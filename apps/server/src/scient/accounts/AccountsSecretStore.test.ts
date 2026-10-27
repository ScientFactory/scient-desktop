import { expect, it } from "@effect/vitest";
import {
  CustomModelError,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type CustomModelConnection,
  type CustomModelsSettings,
} from "@t3tools/contracts";
import { Effect, Option, Redacted } from "effect";
import {
  customModelSecretName,
  prepareCustomModelSave,
  resolveCustomModels,
  saveCustomModel,
  withCustomModelKeyHints,
} from "../../customModels.ts";
import { OVERLEAF_TOKEN_SECRET } from "../overleaf/OverleafToken.ts";
import { makeAccountVault } from "./AccountVault.ts";
import { makeAccountsSecretStore } from "./AccountsSecretStore.ts";
import { memoryStore, noKeychain, syntheticValue } from "./Accounts.testkit.ts";

const make = Effect.fn("AccountsSecretStoreTest.make")(function* (
  storage: ReturnType<typeof memoryStore> = memoryStore(),
) {
  const vault = yield* makeAccountVault(storage.store, "/synthetic/custom-models", noKeychain);
  const secrets = yield* makeAccountsSecretStore(storage.store, vault);
  return { ...storage, secrets };
});
const bytes = (value: string) => new TextEncoder().encode(value);
const matches = (stored: Option.Option<Uint8Array>, value: string) =>
  Option.isSome(stored) && new TextDecoder().decode(stored.value) === value;

it.effect("resolves a legacy key and seals it once under its existing name", () =>
  Effect.gen(function* () {
    const f = yield* make();
    const value = `\u0001${syntheticValue()}`;
    const name = customModelSecretName("legacy");
    f.blobs.set(name, bytes(value));
    expect(matches(yield* f.secrets.get(name), value)).toBe(true);
    expect(Buffer.from(f.blobs.get(name)!).includes(value)).toBe(false);
    const sealed = f.blobs.get(name)!.slice();
    const restarted = yield* make(f);
    expect(matches(yield* restarted.secrets.get(name), value)).toBe(true);
    expect(Buffer.from(f.blobs.get(name)!).equals(Buffer.from(sealed))).toBe(true);
  }),
);

it.effect("round trips sealed records and refuses tampering or a different record name", () =>
  Effect.gen(function* () {
    const f = yield* make();
    const name = customModelSecretName("sealed");
    const value = syntheticValue();
    yield* f.secrets.create(name, bytes(value));
    expect(Buffer.from(f.blobs.get(name)!).includes(value)).toBe(false);
    expect(matches(yield* f.secrets.get(name), value)).toBe(true);
    expect((yield* f.secrets.create(name, bytes(syntheticValue())).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(matches(yield* f.secrets.get(name), value)).toBe(true);
    const replacement = syntheticValue();
    yield* f.secrets.set(name, bytes(replacement));
    expect(matches(yield* f.secrets.get(name), replacement)).toBe(true);
    const misplaced = customModelSecretName("other");
    f.blobs.set(misplaced, f.blobs.get(name)!.slice());
    expect((yield* f.secrets.get(misplaced).pipe(Effect.flip))._tag).toBe("SecretStoreDecodeError");
    const blob = f.blobs.get(name)!;
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect((yield* f.secrets.get(name).pipe(Effect.flip))._tag).toBe("SecretStoreDecodeError");
    yield* f.secrets.remove(name);
    expect(Option.isNone(yield* f.secrets.get(name))).toBe(true);
    const random = yield* f.secrets.getOrCreateRandom(name, 32);
    expect(random.length).toBe(32);
    expect(
      Buffer.from(random).equals(Buffer.from(yield* f.secrets.getOrCreateRandom(name, 32))),
    ).toBe(true);
    expect(Buffer.from(f.blobs.get(name)!).includes(Buffer.from(random))).toBe(false);
  }),
);

const pi = ProviderInstanceId.make("pi");
const connection: Omit<CustomModelConnection, "credentialId"> = {
  id: "synthetic-connection",
  name: "Synthetic endpoint",
  baseUrl: "https://models.example.test/v1",
  protocol: "openai-completions",
  models: [
    {
      id: "model",
      modelId: "model/one",
      name: "One",
      contextWindow: 32000,
      maxOutputTokens: 1024,
      images: false,
      reasoning: false,
      instanceIds: [pi],
    },
  ],
};

it.effect("preserves Custom models hints, retained keys, rotation, rollback and key removal", () =>
  Effect.gen(function* () {
    const f = yield* make();
    let catalog: CustomModelsSettings = { revision: 0, connections: [] };
    const settings = () => ({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog });
    const commit = (next: CustomModelsSettings) =>
      Effect.sync(() => {
        catalog = next;
      });
    const value = syntheticValue();
    yield* saveCustomModel(
      settings(),
      { revision: 0, connection, apiKey: Redacted.make(value) },
      f.secrets,
      commit,
    );
    const original = catalog.connections[0]!;
    const originalName = customModelSecretName(original.credentialId!);
    expect(Buffer.from(f.blobs.get(originalName)!).includes(value)).toBe(false);
    const { apiKeySuffix: _suffix, ...withoutHint } = original;
    const hinted = yield* withCustomModelKeyHints(
      { ...catalog, connections: [withoutHint] },
      f.secrets,
    );
    expect(hinted.connections[0]?.apiKeySuffix === value.slice(-4)).toBe(true);
    const prepared = yield* prepareCustomModelSave(
      settings(),
      { revision: catalog.revision, connection },
      f.secrets,
    );
    expect(
      prepared.connection.apiKey !== null && Redacted.value(prepared.connection.apiKey!) === value,
    ).toBe(true);
    yield* saveCustomModel(
      settings(),
      { revision: catalog.revision, connection },
      f.secrets,
      commit,
    );
    expect(catalog.connections[0]?.credentialId).toBe(original.credentialId);
    const replacement = syntheticValue();
    yield* saveCustomModel(
      settings(),
      { revision: catalog.revision, connection, apiKey: Redacted.make(replacement) },
      f.secrets,
      commit,
    );
    expect(f.blobs.has(originalName)).toBe(false);
    const resolved = yield* resolveCustomModels(catalog, pi, f.secrets);
    expect(
      resolved[0]?.apiKey !== null && Redacted.value(resolved[0]!.apiKey!) === replacement,
    ).toBe(true);
    const before = [...f.blobs.keys()];
    const failed = yield* saveCustomModel(
      settings(),
      { revision: catalog.revision, connection, apiKey: Redacted.make(syntheticValue()) },
      f.secrets,
      () => Effect.fail(new CustomModelError({ message: "Synthetic commit failure." })),
    ).pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect([...f.blobs.keys()]).toEqual(before);
    const keyName = customModelSecretName(catalog.connections[0]!.credentialId!);
    yield* saveCustomModel(
      settings(),
      { revision: catalog.revision, connection, removeKey: true },
      f.secrets,
      commit,
    );
    expect(f.blobs.has(keyName)).toBe(false);
    expect((yield* resolveCustomModels(catalog, pi, f.secrets))[0]?.apiKey).toBeNull();
  }),
);

it.effect(
  "migrates the Overleaf token once, retains it across restart, rotates and removes it",
  () =>
    Effect.gen(function* () {
      const f = yield* make();
      const name = OVERLEAF_TOKEN_SECRET;
      const value = syntheticValue();
      f.blobs.set(name, bytes(value));
      expect(matches(yield* f.secrets.get(name), value)).toBe(true);
      expect(Buffer.from(f.blobs.get(name)!).includes(value)).toBe(false);
      const sealed = f.blobs.get(name)!.slice();
      const restarted = yield* make(f);
      expect(matches(yield* restarted.secrets.get(name), value)).toBe(true);
      expect(Buffer.from(f.blobs.get(name)!).equals(Buffer.from(sealed))).toBe(true);
      const replacement = syntheticValue();
      yield* restarted.secrets.set(name, bytes(replacement));
      expect(matches(yield* restarted.secrets.get(name), replacement)).toBe(true);
      expect(Buffer.from(f.blobs.get(name)!).includes(replacement)).toBe(false);
      yield* restarted.secrets.remove(name);
      expect(Option.isNone(yield* restarted.secrets.get(name))).toBe(true);
    }),
);

it.effect("retains the legacy Overleaf token when sealing cannot be persisted", () =>
  Effect.gen(function* () {
    const f = yield* make();
    const value = syntheticValue();
    f.blobs.set(OVERLEAF_TOKEN_SECRET, bytes(value));
    f.failWritesTo(OVERLEAF_TOKEN_SECRET);
    expect((yield* f.secrets.get(OVERLEAF_TOKEN_SECRET).pipe(Effect.result))._tag).toBe("Failure");
    expect(matches(Option.fromUndefinedOr(f.blobs.get(OVERLEAF_TOKEN_SECRET)), value)).toBe(true);
    f.failWritesTo(undefined);
    expect(matches(yield* f.secrets.get(OVERLEAF_TOKEN_SECRET), value)).toBe(true);
    expect(Buffer.from(f.blobs.get(OVERLEAF_TOKEN_SECRET)!).includes(value)).toBe(false);
  }),
);
