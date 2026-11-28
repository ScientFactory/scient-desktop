// @effect-diagnostics nodeBuiltinImport:off -- Native keyring and authenticated encryption stay at this boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import { AccountsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { Context, Duration, Effect, Layer, Option, Queue, Redacted, Semaphore } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ACCOUNTS_AWAIT_PERSON } from "./awaitPerson.ts";
import { ClientActivityLeases, leasesLayer, someoneAtWindow } from "./clientLeases.ts";

const requireKeyring = NodeModule.createRequire(import.meta.url);
const unavailable = () =>
  new AccountsError({ reason: "unavailable", message: "Scient Accounts store is unavailable." });
const SENTINEL = "accounts-vault";
const KEY_FILE = "accounts-master-key";
/** How often a refused open looks for someone at a window: it opens within this of their lease. */
const PERSON_LOOK_GAP = Duration.seconds(1);

export interface AccountKeychain {
  readonly read: (
    account: string,
  ) => Effect.Effect<Redacted.Redacted<string> | null, AccountsError>;
  readonly write: (
    account: string,
    key: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AccountsError>;
  /**
   * While Scient may run with no window (macOS, Linux): the keychain is read only when someone can
   * answer its dialog, and unattended work opens nothing (`openWithoutPrompt`).
   */
  readonly unattendedWaitsForPerson: boolean;
}

/**
 * Credential Manager never asks. A macOS keychain item whose access list no longer trusts this
 * executable asks, and a Secret Service collection can ask to be unlocked: while the desktop may
 * run with no window, those open only with one. Otherwise unattended work reads as any use does.
 */
export const makeAccountKeychain = Effect.fn("AccountKeychain.make")(function* (
  keychain: Omit<AccountKeychain, "unattendedWaitsForPerson">,
) {
  const backgroundRunning = (yield* ServerConfig).desktopBackgroundRunning === true;
  return {
    ...keychain,
    unattendedWaitsForPerson: backgroundRunning && (yield* HostProcess.Platform) !== "win32",
  } satisfies AccountKeychain;
});

const KEYCHAIN_SERVICE = "Scient Accounts";

const nativeKeychain: Omit<AccountKeychain, "unattendedWaitsForPerson"> = {
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
    /** Opens a vault set up before for unattended work; false when that needs the person. */
    readonly openWithoutPrompt: Effect.Effect<boolean, AccountsError>;
    /**
     * While Scient may run with no window: the store opens only with a client in the foreground,
     * and `openWithoutPrompt` declines a keychain one.
     */
    readonly unattendedWaitsForPerson: boolean;
    /**
     * Waits for an open refused for want of a person, then for someone at a window: the moment to
     * open the store. One wait per refusal: after it, the next waits for the next refusal.
     */
    readonly personArrived: Effect.Effect<void>;
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
  // The clients' leases and the host's lock state as they are when the keychain would be read:
  // shared with the background policy, which is built after this vault.
  const leases = yield* Effect.serviceOption(ClientActivityLeases);
  /** Someone can answer a keychain dialog here now (`someoneAtWindow`), nothing else. */
  const personCanAnswer = Option.isSome(leases)
    ? someoneAtWindow(leases.value)
    : Effect.succeed(false);
  /** An open refused for want of a person, until someone arrives to answer it. */
  const refused = yield* Queue.sliding<void>(1);
  const personArrived = Option.isNone(leases)
    ? Effect.never
    : Queue.take(refused).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            while (!(yield* personCanAnswer)) yield* Effect.sleep(PERSON_LOOK_GAP);
            // Every refusal made while this one waited joins it: one try for the person's return.
            yield* Queue.clear(refused);
          }),
        ),
      );
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
        // The one place the keychain is read to open the store: while nobody can answer a dialog,
        // it stays closed, and work waiting for it goes on once the person opens it (`changes`).
        if (keychain.unattendedWaitsForPerson && !(yield* personCanAnswer)) {
          yield* Queue.offer(refused, undefined);
          return yield* new AccountsError({
            reason: "unavailable",
            message: ACCOUNTS_AWAIT_PERSON,
          });
        }
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
  // Unattended work opens only a vault set up before; a keychain-protected one only when the
  // keychain allows unattended reads, else nothing is read or written and the next foreground use
  // opens it. It never waits behind another open either.
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
                if (keychain.unattendedWaitsForPerson) return false;
                const read = yield* keychain.read(account);
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
    unattendedWaitsForPerson: keychain.unattendedWaitsForPerson,
    personArrived,
    encrypt: Effect.fn("AccountVault.encrypt")(function* (name, value) {
      return yield* encryptBlob((yield* load).key, name, value);
    }),
    decrypt: Effect.fn("AccountVault.decrypt")(function* (name, blob) {
      return yield* decryptBlob((yield* load).key, name, blob);
    }),
  });
});

/** The vault over `keychain`, reading the clients' shared leases (`ClientActivityLeases`). */
export const layerWith = (keychain: Effect.Effect<AccountKeychain, never, ServerConfig>) =>
  Layer.effect(
    AccountVault,
    Effect.gen(function* () {
      return yield* makeAccountVault(
        yield* ServerSecretStore,
        (yield* ServerConfig).stateDir,
        yield* keychain,
      );
    }),
  ).pipe(Layer.provide(leasesLayer));

export const layer = layerWith(makeAccountKeychain(nativeKeychain));
