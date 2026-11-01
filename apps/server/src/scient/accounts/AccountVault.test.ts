import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { decryptBlob, encryptBlob, makeAccountVault } from "./AccountVault.ts";
import { memoryStore, noKeychain, syntheticValue } from "./Accounts.testkit.ts";

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
      });
      expect(yield* vault.protection).toBe("file");
      storage.blobs.set("accounts-master-key", new Uint8Array(31));
      const broken = yield* makeAccountVault(storage.store, "/synthetic", noKeychain);
      expect((yield* broken.protection.pipe(Effect.flip)).reason).toBe("unavailable");
    }),
  );
});
