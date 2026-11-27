// @effect-diagnostics nodeBuiltinImport:off -- Native keyring and authenticated encryption stay at this boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import { AccountsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { Context, Effect, Layer, Option, Redacted, Semaphore } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";

/** "needs-person" when only a foreground read may open it. */
export type KeychainReadWithoutPrompt = Redacted.Redacted<string> | null | "needs-person";

const requireKeyring = NodeModule.createRequire(import.meta.url);
const unavailable = () =>
  new AccountsError({ reason: "unavailable", message: "Scient Accounts store is unavailable." });
const SENTINEL = "accounts-vault";
const KEY_FILE = "accounts-master-key";

export interface AccountKeychain {
  readonly read: (
    account: string,
  ) => Effect.Effect<Redacted.Redacted<string> | null, AccountsError>;
  /** Never shows a dialog and, on macOS and Linux, never touches the keychain. */
  readonly readWithoutPrompt: (
    account: string,
  ) => Effect.Effect<KeychainReadWithoutPrompt, AccountsError>;
  readonly write: (
    account: string,
    key: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AccountsError>;
}

const KEYCHAIN_SERVICE = "Scient Accounts";

const nativeKeychain: AccountKeychain = {
  read: Effect.fn("AccountKeychain.read")((account) =>
    Effect.tryPromise({
      try: async () => {
        const { AsyncEntry } = requireKeyring(
          "@napi-rs/keyring",
        ) as typeof import("@napi-rs/keyring");
        const key = await new AsyncEntry(KEYCHAIN_SERVICE, account).getPassword();
        return key == null ? null : Redacted.make(key);
      },
      catch: unavailable,
    }),
  ),
  readWithoutPrompt: Effect.fn("AccountKeychain.readWithoutPrompt")(function* (account) {
    // Credential Manager never asks. A macOS keychain item whose access list no longer trusts
    // this executable asks, and a Secret Service collection can ask to be unlocked: those open
    // only with a window.
    if ((yield* HostProcess.Platform) === "win32") return yield* nativeKeychain.read(account);
    return "needs-person" as const;
  }),
  write: Effect.fn("AccountKeychain.write")((account, key) =>
    Effect.tryPromise({
      try: async () => {
        const { AsyncEntry } = requireKeyring(
          "@napi-rs/keyring",
        ) as typeof import("@napi-rs/keyring");
        await new AsyncEntry(KEYCHAIN_SERVICE, account).setPassword(Redacted.value(key));
      },
      catch: unavailable,
    }),
  ),
};

export const encryptBlob = (
  key: Redacted.Redacted<Uint8Array>,
  name: string,
  value: Redacted.Redacted<Uint8Array>,
) =>
  Effect.try({
    try: () => {
      const nonce = NodeCrypto.randomBytes(12);
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", Redacted.value(key), nonce);
      cipher.setAAD(Buffer.from(name));
      const ciphertext = Buffer.concat([cipher.update(Redacted.value(value)), cipher.final()]);
      return Uint8Array.from(
        Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]),
      );
    },
    catch: unavailable,
  });

export const decryptBlob = (key: Redacted.Redacted<Uint8Array>, name: string, blob: Uint8Array) =>
  Effect.try({
    try: () => {
      if (blob[0] !== 1 || blob.length < 29) throw unavailable();
      const decipher = NodeCrypto.createDecipheriv(
        "aes-256-gcm",
        Redacted.value(key),
        blob.subarray(1, 13),
      );
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(blob.subarray(13, 29));
      return Redacted.make(
        Uint8Array.from(Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()])),
      );
    },
    catch: unavailable,
  });

export class AccountVault extends Context.Service<
  AccountVault,
  {
    readonly protection: Effect.Effect<"keychain" | "file", AccountsError>;
    /** Opens a vault set up before without any dialog; false when that needs the person. */
    readonly openWithoutPrompt: Effect.Effect<boolean, AccountsError>;
    readonly encrypt: (
      name: string,
      value: Redacted.Redacted<Uint8Array>,
    ) => Effect.Effect<Uint8Array, AccountsError>;
    readonly decrypt: (
      name: string,
      blob: Uint8Array,
    ) => Effect.Effect<Redacted.Redacted<Uint8Array>, AccountsError>;
  }
>()("t3/scient/accounts/AccountVault") {}

export const makeAccountVault = Effect.fn("AccountVault.make")(function* (
  store: ServerSecretStore["Service"],
  stateDirectory: string,
  keychain: AccountKeychain,
) {
  const account = NodeCrypto.createHash("sha256").update(stateDirectory).digest("hex");
  const lock = yield* Semaphore.make(1);
  let loaded: { key: Redacted.Redacted<Uint8Array>; protection: "keychain" | "file" } | undefined;
  const load = lock.withPermits(1)(
    Effect.gen(function* () {
      if (loaded) return loaded;
      const sentinel = yield* store.get(SENTINEL).pipe(Effect.mapError(unavailable));
      const file = yield* store.get(KEY_FILE).pipe(Effect.mapError(unavailable));
      const existing = Option.isSome(sentinel);
      const protection = existing
        ? sentinel.value[0] === 0
          ? "file"
          : sentinel.value[0] === 1
            ? "keychain"
            : undefined
        : undefined;
      if (existing && protection === undefined) return yield* unavailable();
      let key: Uint8Array;
      let selected: "file" | "keychain";
      if (protection === "file" || (!existing && Option.isSome(file))) {
        if (Option.isNone(file)) return yield* unavailable();
        key = file.value;
        selected = "file";
      } else {
        const read = yield* keychain.read(account).pipe(Effect.result);
        if (protection === "keychain") {
          if (read._tag === "Failure" || read.success === null) return yield* unavailable();
          key = Buffer.from(Redacted.value(read.success), "base64");
          selected = "keychain";
        } else if (read._tag === "Success" && read.success !== null) {
          key = Buffer.from(Redacted.value(read.success), "base64");
          selected = "keychain";
        } else {
          // Existing encrypted records must never be replaced with a fresh empty vault.
          const state = yield* store.get("accounts-state").pipe(Effect.mapError(unavailable));
          const activity = yield* store.get("accounts-activity").pipe(Effect.mapError(unavailable));
          if (Option.isSome(state) || Option.isSome(activity)) return yield* unavailable();
          key = NodeCrypto.randomBytes(32);
          const written =
            read._tag === "Success"
              ? yield* keychain
                  .write(account, Redacted.make(Buffer.from(key).toString("base64")))
                  .pipe(Effect.result)
              : undefined;
          if (written?._tag === "Success") {
            selected = "keychain";
          } else {
            key = yield* store.getOrCreateRandom(KEY_FILE, 32).pipe(Effect.mapError(unavailable));
            selected = "file";
          }
        }
      }
      if (key.length !== 32) return yield* unavailable();
      const hidden = Redacted.make(key);
      if (existing) {
        yield* decryptBlob(hidden, SENTINEL, sentinel.value.subarray(1));
      } else {
        const check = yield* encryptBlob(hidden, SENTINEL, Redacted.make(new Uint8Array()));
        yield* store
          .create(SENTINEL, Uint8Array.from([selected === "file" ? 0 : 1, ...check]))
          .pipe(Effect.mapError(unavailable));
      }
      loaded = { key: hidden, protection: selected };
      return loaded;
    }),
  );
  // Unattended work opens only a vault set up before, and never with a dialog: when reading its
  // key would ask, nothing is read or written and the next foreground use opens it. It never
  // waits behind another open either.
  const openWithoutPrompt = Effect.suspend(() =>
    loaded
      ? Effect.succeed(true)
      : lock
          .withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              if (loaded) return true;
              const sentinel = yield* store.get(SENTINEL).pipe(Effect.mapError(unavailable));
              if (Option.isNone(sentinel)) return false;
              let key: Uint8Array;
              let protection: "keychain" | "file";
              if (sentinel.value[0] === 0) {
                const file = yield* store.get(KEY_FILE).pipe(Effect.mapError(unavailable));
                if (Option.isNone(file)) return yield* unavailable();
                key = file.value;
                protection = "file";
              } else if (sentinel.value[0] === 1) {
                const read = yield* keychain.readWithoutPrompt(account);
                if (read === "needs-person") return false;
                if (read === null) return yield* unavailable();
                key = Buffer.from(Redacted.value(read), "base64");
                protection = "keychain";
              } else {
                return yield* unavailable();
              }
              if (key.length !== 32) return yield* unavailable();
              const hidden = Redacted.make(key);
              yield* decryptBlob(hidden, SENTINEL, sentinel.value.subarray(1));
              loaded = { key: hidden, protection };
              return true;
            }),
          )
          .pipe(Effect.map(Option.getOrElse(() => false))),
  );
  return AccountVault.of({
    protection: load.pipe(Effect.map((value) => value.protection)),
    openWithoutPrompt,
    encrypt: Effect.fn("AccountVault.encrypt")(function* (name, value) {
      return yield* encryptBlob((yield* load).key, name, value);
    }),
    decrypt: Effect.fn("AccountVault.decrypt")(function* (name, blob) {
      return yield* decryptBlob((yield* load).key, name, blob);
    }),
  });
});

export const layer = Layer.effect(
  AccountVault,
  Effect.gen(function* () {
    return yield* makeAccountVault(
      yield* ServerSecretStore,
      (yield* ServerConfig).stateDir,
      nativeKeychain,
    );
  }),
);
