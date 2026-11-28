import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, RpcClientId, type HostPowerSnapshot } from "@t3tools/contracts";
import { DateTime, Deferred, Effect, Fiber, Layer, Redacted, Stream } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicyModule from "../../background/BackgroundPolicy.ts";
import { ClientActivityLeases, vouchedClientKind } from "./clientLeases.ts";
import { HostPowerMonitor } from "../../background/HostPowerMonitor.ts";
import { ServerConfig } from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  AccountVault,
  decryptBlob,
  encryptBlob,
  layerWith,
  makeAccountVault,
} from "./AccountVault.ts";
import { ACCOUNTS_AWAIT_PERSON } from "./awaitPerson.ts";
import {
  memoryStore,
  noKeychain,
  recordingKeychain,
  syntheticValue,
  windowLeases,
} from "./Accounts.testkit.ts";

const key = () =>
  Redacted.make(new TextEncoder().encode(syntheticValue().replaceAll("-", "").slice(0, 32)));
const material = () => Redacted.make(new TextEncoder().encode(syntheticValue()));

describe("AccountVault", () => {
  it.effect("encrypts with fresh nonces and round trips without plaintext storage", () =>
    Effect.gen(function* () {
      const master = key();
      const value = material();
      const first = yield* encryptBlob(master, "record", value);
      const second = yield* encryptBlob(master, "record", value);
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
      expect(Buffer.from(first).includes(Buffer.from(Redacted.value(value)))).toBe(false);
      const decoded = yield* decryptBlob(master, "record", first);
      expect(Buffer.from(Redacted.value(decoded)).equals(Buffer.from(Redacted.value(value)))).toBe(
        true,
      );
    }),
  );
  it.effect("refuses a blob moved to a different record", () =>
    Effect.gen(function* () {
      const master = key();
      const blob = yield* encryptBlob(master, "original", material());
      expect((yield* decryptBlob(master, "other", blob).pipe(Effect.flip)).reason).toBe(
        "unavailable",
      );
    }),
  );
  it.effect("refuses modified ciphertext and unsupported formats", () =>
    Effect.gen(function* () {
      const master = key();
      const blob = yield* encryptBlob(master, "record", material());
      const original = blob.slice();
      blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
      expect((yield* decryptBlob(master, "record", blob).pipe(Effect.flip)).reason).toBe(
        "unavailable",
      );
      blob.set(original);
      blob[0] = 2;
      expect((yield* decryptBlob(master, "record", blob).pipe(Effect.flip)).reason).toBe(
        "unavailable",
      );
    }),
  );
  it.effect("refuses the wrong master key", () =>
    Effect.gen(function* () {
      const blob = yield* encryptBlob(key(), "record", material());
      expect((yield* decryptBlob(key(), "record", blob).pipe(Effect.flip)).reason).toBe(
        "unavailable",
      );
    }),
  );
  it.effect("retains file fallback across restart and never resets a missing key", () =>
    Effect.gen(function* () {
      const { store, blobs } = memoryStore();
      const first = yield* makeAccountVault(store, "/synthetic/one", noKeychain);
      expect(yield* first.protection).toBe("file");
      const value = material();
      const blob = yield* first.encrypt("record", value);
      const restarted = yield* makeAccountVault(store, "/synthetic/one", noKeychain);
      const decoded = yield* restarted.decrypt("record", blob);
      expect(Buffer.from(Redacted.value(decoded)).equals(Buffer.from(Redacted.value(value)))).toBe(
        true,
      );
      blobs.delete("accounts-master-key");
      const missing = yield* makeAccountVault(store, "/synthetic/one", noKeychain);
      expect((yield* missing.protection.pipe(Effect.flip)).reason).toBe("unavailable");
      expect(blobs.has("accounts-master-key")).toBe(false);
    }),
  );
  it.effect("uses a state-directory-specific keychain item and refuses lost keychain keys", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const items = new Map<string, Redacted.Redacted<string>>();
      const keychain = {
        read: (account: string) => Effect.succeed(items.get(account) ?? null),
        write: (account: string, value: Redacted.Redacted<string>) =>
          Effect.sync(() => {
            items.set(account, value);
          }),
        unattendedWaitsForPerson: false,
      };
      const first = yield* makeAccountVault(storage.store, "/synthetic/one", keychain);
      expect(yield* first.protection).toBe("keychain");
      expect(storage.blobs.has("accounts-master-key")).toBe(false);
      const other = yield* makeAccountVault(memoryStore().store, "/synthetic/two", keychain);
      yield* other.protection;
      expect(items.size).toBe(2);
      items.clear();
      const restarted = yield* makeAccountVault(storage.store, "/synthetic/one", keychain);
      expect((yield* restarted.protection.pipe(Effect.flip)).reason).toBe("unavailable");
      expect(storage.blobs.has("accounts-master-key")).toBe(false);
    }),
  );
  it.effect("falls back when keychain writes fail and refuses malformed stored keys", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const vault = yield* makeAccountVault(storage.store, "/synthetic", {
        read: () => Effect.succeed(null),
        write: noKeychain.write,
        unattendedWaitsForPerson: false,
      });
      expect(yield* vault.protection).toBe("file");
      storage.blobs.set("accounts-master-key", new Uint8Array(31));
      const broken = yield* makeAccountVault(storage.store, "/synthetic", noKeychain);
      expect((yield* broken.protection.pipe(Effect.flip)).reason).toBe("unavailable");
    }),
  );
  it.effect(
    "opens unattended only a vault set up before, and touches nothing while that waits for the person",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const items = new Map<string, Redacted.Redacted<string>>();
        const reads: string[] = [];
        const keychain = {
          read: (account: string) =>
            Effect.sync(() => {
              reads.push(account);
              return items.get(account) ?? null;
            }),
          write: (account: string, value: Redacted.Redacted<string>) =>
            Effect.sync(() => {
              items.set(account, value);
            }),
          unattendedWaitsForPerson: false,
        };
        // A vault is set up only with the person there.
        const fresh = yield* makeAccountVault(storage.store, "/synthetic", keychain);
        expect(yield* fresh.openWithoutPrompt).toBe(false);
        expect(storage.blobs.size).toBe(0);
        const value = material();
        const blob = yield* fresh.encrypt("record", value);
        reads.length = 0;
        const records = new Map(storage.blobs);

        const waiting = { ...keychain, unattendedWaitsForPerson: true };
        const { leases, atWindow } = yield* windowLeases();
        const atLogin = yield* makeAccountVault(storage.store, "/synthetic", waiting).pipe(
          Effect.provideService(ClientActivityLeases, leases),
        );
        expect(yield* atLogin.openWithoutPrompt).toBe(false);
        expect(reads).toEqual([]);
        expect(new Map(storage.blobs)).toEqual(records);
        // Any use with nobody at a window to answer the dialog leaves it closed, and reads nothing.
        const closed = yield* Effect.flip(atLogin.decrypt("record", blob));
        expect(closed.message).toBe(ACCOUNTS_AWAIT_PERSON);
        expect(reads).toEqual([]);
        // With someone at a window it opens as before.
        yield* atWindow(true);
        const decoded = yield* atLogin.decrypt("record", blob);
        expect(
          Buffer.from(Redacted.value(decoded)).equals(Buffer.from(Redacted.value(value))),
        ).toBe(true);
        expect(reads).toHaveLength(1);

        reads.length = 0;
        const unattended = yield* makeAccountVault(storage.store, "/synthetic", keychain);
        expect(yield* unattended.openWithoutPrompt).toBe(true);
        yield* unattended.decrypt("record", blob);
        expect(reads).toHaveLength(1);
      }),
  );
  it.effect("an unattended open never waits behind a foreground one", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const items = new Map<string, Redacted.Redacted<string>>();
      const write = (account: string, value: Redacted.Redacted<string>) =>
        Effect.sync(() => {
          items.set(account, value);
        });
      const read = (account: string) => Effect.succeed(items.get(account) ?? null);
      const setUp = yield* makeAccountVault(storage.store, "/synthetic", {
        read,
        write,
        unattendedWaitsForPerson: false,
      });
      yield* setUp.encrypt("record", material());

      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const vault = yield* makeAccountVault(storage.store, "/synthetic", {
        // A keychain dialog the person has not answered yet.
        read: (account) =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(read(account)),
          ),
        write,
        unattendedWaitsForPerson: false,
      });
      const foreground = yield* Effect.forkChild(vault.protection);
      yield* Deferred.await(reading);
      expect(yield* vault.openWithoutPrompt).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(foreground)).toBe("keychain");
      expect(yield* vault.openWithoutPrompt).toBe(true);
    }),
  );
  it.effect("a vault built before the background policy reads the leases it records", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
      const { leases } = yield* windowLeases(true);
      const setUp = yield* makeAccountVault(storage.store, "/synthetic", keychain).pipe(
        Effect.provideService(ClientActivityLeases, leases),
      );
      const blob = yield* setUp.encrypt("record", material());
      reads.length = 0;
      // As the server builds them: the vault first (Server Settings, through the Accounts secret
      // store), then the background policy.
      const hostPower = Layer.succeed(HostPowerMonitor, {
        snapshot: Effect.succeed<HostPowerSnapshot>({
          source: "unknown",
          idle: "unknown",
          idleSeconds: null,
          locked: "unknown",
          suspended: false,
          onBattery: "unknown",
          lowPowerMode: "unknown",
          thermalState: "unknown",
          stale: true,
          updatedAt: DateTime.makeUnsafe(0),
        }),
        report: () => Effect.void,
        streamChanges: Stream.empty,
      });
      const layer = BackgroundPolicyModule.layer.pipe(
        Layer.provide(Layer.merge(hostPower, ServerSettings.layerTest())),
        Layer.provideMerge(layerWith(Effect.succeed(keychain))),
        Layer.provide(
          Layer.merge(
            Layer.succeed(ServerSecretStore, storage.store),
            Layer.succeed(ServerConfig, { stateDir: "/synthetic" } as ServerConfig["Service"]),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const vault = yield* AccountVault;
        const policy = yield* BackgroundPolicyModule.BackgroundPolicy;
        // No window: the store stays closed, and nothing is read.
        const closed = yield* Effect.flip(vault.decrypt("record", blob));
        expect(closed.message).toBe(ACCOUNTS_AWAIT_PERSON);
        expect(reads).toEqual([]);
        // A window in the foreground: the vault, built first, sees its lease and opens.
        yield* policy.reportClientActivity(AuthSessionId.make("session"), RpcClientId.make(1), {
          clientId: "window",
          clientKind: "desktop-renderer",
          visible: true,
          focused: true,
          recentlyInteracted: true,
          scopes: [],
          ttlMs: 45_000,
          observedAt: yield* DateTime.now,
        });
        // regression: the vault caught the policy at its own build, before the policy existed.
        yield* vault.decrypt("record", blob);
        expect(reads).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect("only this computer's desktop, focused and unlocked, lets the keychain be read", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
      const { leases, client, hostLocked } = yield* windowLeases(true);
      const vaultHere = makeAccountVault(storage.store, "/synthetic", keychain).pipe(
        Effect.provideService(ClientActivityLeases, leases),
      );
      const blob = yield* (yield* vaultHere).encrypt("record", material());
      reads.length = 0;
      const vault = yield* vaultHere;
      const refused = Effect.flip(vault.decrypt("record", blob)).pipe(
        Effect.map((error) => error.message),
      );
      // regression: a window that had lost focus, but was used a moment ago, let it be read.
      yield* client({ focused: false, recentlyInteracted: true });
      expect(yield* refused).toBe(ACCOUNTS_AWAIT_PERSON);
      // The computer unlocked, and a focused web client: elsewhere, as far as this computer knows.
      yield* hostLocked(false);
      // regression: a web client focused on another computer let it be read with nobody here.
      yield* client({ clientKind: "web" });
      expect(yield* refused).toBe(ACCOUNTS_AWAIT_PERSON);
      // Nor a client only saying it's the desktop, signed in other than by this desktop.
      yield* client({ clientKind: vouchedClientKind("pairing-link", "desktop-renderer") });
      expect(yield* refused).toBe(ACCOUNTS_AWAIT_PERSON);
      // A phone in the foreground: the dialog would show here, where nobody is.
      yield* client({ clientKind: "mobile" });
      expect(yield* refused).toBe(ACCOUNTS_AWAIT_PERSON);
      // This computer's desktop window focused, the computer locked.
      yield* client({ clientKind: vouchedClientKind("desktop-bootstrap", "desktop-renderer") });
      yield* hostLocked(true);
      expect(yield* refused).toBe(ACCOUNTS_AWAIT_PERSON);
      expect(reads).toEqual([]);
      // Unlocked: it opens.
      yield* hostLocked(false);
      yield* vault.decrypt("record", blob);
      expect(reads).toHaveLength(1);
    }),
  );
});
