import { expect, it } from "@effect/vitest";
import { VaultSecretRef } from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ConnectorCredentialStore } from "../extensions/connectors/ConnectorCredentialStore.ts";
import { AccountVault, makeAccountVault } from "./AccountVault.ts";
import * as EncryptedCredentials from "./AccountsConnectorCredentials.ts";
import { memoryStore, noKeychain, syntheticValue } from "./Accounts.testkit.ts";

const owner = { type: "connector", connectorId: "synthetic-connector" } as const;
const make = Effect.fn("AccountsConnectorCredentialsTest.make")(function* (
  storage: ReturnType<typeof memoryStore>,
) {
  const vault = yield* makeAccountVault(storage.store, "/synthetic/connector", noKeychain);
  const context = yield* Layer.build(
    EncryptedCredentials.layer.pipe(
      Layer.provide(Layer.succeed(AccountVault, vault)),
      Layer.provide(Layer.succeed(ServerSecretStore, storage.store)),
    ),
  );
  return Context.get(context, ConnectorCredentialStore);
});

it.effect("migrates a legacy envelope in place without losing ownership, version or material", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const value = syntheticValue();
    const ref = VaultSecretRef.make("connector-00000000-0000-4000-8000-000000000000");
    const envelope = `{"format":1,"version":7,"kind":"bearer","label":"Synthetic","owner":{"type":"connector","connectorId":"synthetic-connector"},"material":"${Buffer.from(value).toString("base64")}"}`;
    storage.blobs.set(ref, new TextEncoder().encode(envelope));
    const store = yield* make(storage);
    const read = yield* store.readOwned(ref, owner);
    expect(Option.isSome(read) && new TextDecoder().decode(read.value.material) === value).toBe(
      true,
    );
    expect(Option.isSome(read) && read.value.version === 7).toBe(true);
    expect(storage.blobs.get(ref)?.[0]).toBe(1);
    expect(
      Buffer.from(storage.blobs.get(ref)!).includes(Buffer.from(value).toString("base64")),
    ).toBe(false);
    const restarted = yield* make(storage);
    const next = yield* restarted.readOwned(ref, owner);
    expect(Option.isSome(next) && new TextDecoder().decode(next.value.material) === value).toBe(
      true,
    );
  }),
);

it.effect(
  "encrypts credentials, isolates owners and preserves compare-and-swap under concurrent replacement",
  () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const store = yield* make(storage);
      const value = syntheticValue();
      const ref = yield* store.put(owner, "bearer", new TextEncoder().encode(value), {
        label: "Synthetic",
      });
      expect(Buffer.from(storage.blobs.get(ref)!).includes(value)).toBe(false);
      expect(
        Option.isNone(yield* store.readOwned(ref, { type: "connector", connectorId: "other" })),
      ).toBe(true);
      const material = new TextEncoder().encode(syntheticValue());
      const results = yield* Effect.all(
        [
          store.replace(ref, material, 1).pipe(Effect.result),
          store.replace(ref, material, 1).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(results.filter((result) => result._tag === "Success").length).toBe(1);
      expect(
        results.some(
          (result) => result._tag === "Failure" && result.failure._tag === "SecretVersionConflict",
        ),
      ).toBe(true);
      const read = yield* store.readOwned(ref, owner);
      expect(
        Option.isSome(read) && Buffer.from(read.value.material).equals(Buffer.from(material)),
      ).toBe(true);
      yield* store.remove(ref);
      expect(Option.isNone(yield* store.readOwned(ref, owner))).toBe(true);
      expect(storage.blobs.has(ref)).toBe(false);
    }),
);

it.effect("refuses tampered or misplaced encrypted connector envelopes", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const store = yield* make(storage);
    const ref = yield* store.put(owner, "bearer", new TextEncoder().encode(syntheticValue()), {
      label: "Synthetic",
    });
    const other = VaultSecretRef.make("connector-11111111-1111-4111-8111-111111111111");
    storage.blobs.set(other, storage.blobs.get(ref)!.slice());
    expect((yield* store.readOwned(other, owner).pipe(Effect.flip)).reason).toBe(
      "state-unavailable",
    );
    const bytes = storage.blobs.get(ref)!;
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect((yield* store.readOwned(ref, owner).pipe(Effect.flip)).reason).toBe("state-unavailable");
    expect(Option.isNone(yield* store.readOwned(VaultSecretRef.make("../outside"), owner))).toBe(
      true,
    );
  }),
);
