import { expect, it } from "@effect/vitest";
import {
  CustomModelError,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModelConnection,
  type CustomModelsSettings,
  type CustomModelSaveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ServerSecretStore } from "./auth/ServerSecretStore.ts";
import { SecretStoreReadError } from "./auth/ServerSecretStore.ts";
import {
  customModelSecretName,
  resolveCustomModels,
  saveCustomModel,
  prepareCustomModelSave,
  withCustomModelKeyHints,
} from "./customModels.ts";

const pi = ProviderInstanceId.make("pi");
const second = ProviderInstanceId.make("pi_work");
const connection: Omit<CustomModelConnection, "credentialId"> = {
  id: "connection",
  name: "My endpoint",
  baseUrl: "https://example.test/v1",
  protocol: "openai-completions",
  models: [
    {
      id: "model",
      modelId: "model/one",
      name: "Model one",
      contextWindow: 32000,
      maxOutputTokens: 1024,
      images: false,
      reasoning: false,
      instanceIds: [pi],
    },
  ],
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function fixture() {
  const values = new Map<string, Uint8Array>();
  const secrets: ServerSecretStore["Service"] = {
    get: (id) => Effect.sync(() => Option.fromNullishOr(values.get(id))),
    set: (id, value) =>
      Effect.sync(() => {
        values.set(id, value);
      }),
    create: (id, value) =>
      Effect.sync(() => {
        if (values.has(id)) throw new Error("Collision");
        values.set(id, value);
      }),
    remove: (id) =>
      Effect.sync(() => {
        values.delete(id);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  };
  let catalog: CustomModelsSettings = { revision: 0, connections: [] };
  const settings = () => ({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog });
  const save = (input: Partial<CustomModelSaveInput> = {}, failCommit = false) =>
    saveCustomModel(
      settings(),
      { revision: catalog.revision, connection, ...input },
      secrets,
      (next) =>
        failCommit
          ? Effect.fail(new CustomModelError({ message: "Simulated disk failure" }))
          : Effect.sync(() => {
              catalog = next;
            }),
    );
  return { values, secrets, save, settings };
}
const rejects = <A>(effect: Effect.Effect<A, CustomModelError>, message: string) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error.message).toContain(message);
    }),
  );

it.effect("rejects a missing recheck target and describes duplicate per-model attachments", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* rejects(f.save({ refreshModelId: "missing" }), "no longer in the connection");
    yield* rejects(
      f.save({
        connection: {
          ...connection,
          models: [{ ...connection.models[0]!, instanceIds: [pi, pi] }],
        },
      }),
      "This model already includes that agent",
    );
    expect(f.values.size).toBe(0);
  }),
);

it.effect("only offers previous metadata for the unchanged endpoint, protocol and credential", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.save({ apiKey: Redacted.make("saved-key") });
    const input = { revision: 1, connection };
    const unchanged = yield* prepareCustomModelSave(f.settings(), input, f.secrets);
    expect(unchanged.previous).toEqual(f.settings().customModels.connections[0]);
    expect(unchanged.connection.apiKey && Redacted.value(unchanged.connection.apiKey)).toBe(
      "saved-key",
    );
    for (const changes of [
      { apiKey: Redacted.make("rotated-key") },
      { removeKey: true },
      { connection: { ...connection, baseUrl: "https://example.test/other" } },
      { connection: { ...connection, protocol: "openai-responses" as const } },
    ]) {
      const prepared = yield* prepareCustomModelSave(
        f.settings(),
        { ...input, ...changes },
        f.secrets,
      );
      expect(prepared.previous).toBeUndefined();
    }
    yield* rejects(
      prepareCustomModelSave(
        f.settings(),
        {
          ...input,
          connection: { ...connection, baseUrl: "https://other.test/v1" },
        },
        f.secrets,
      ),
      "Re-enter",
    );
  }),
);

it.effect("allows detachment without deleting a missing credential reference", () =>
  Effect.gen(function* () {
    const f = fixture();
    const original = yield* f.save({ apiKey: Redacted.make("saved-key") });
    f.values.clear();
    const detached = { ...connection, models: [] };
    const prepared = yield* prepareCustomModelSave(
      f.settings(),
      { revision: 1, connection: detached },
      f.secrets,
    );
    expect(prepared.connection.credentialError).toContain("unavailable");
    expect(prepared.connection.apiKey).toBeUndefined();
    const saved = yield* f.save({ connection: detached });
    expect(saved.connections[0]?.models).toEqual([]);
    expect(saved.connections[0]?.credentialId).toBe(original.connections[0]?.credentialId);
  }),
);

it.effect(
  "discards submitted derived reasoning evidence rather than persisting a forged provider claim",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const saved = yield* f.save({
        connection: {
          ...connection,
          models: [
            {
              ...connection.models[0]!,
              reasoningMetadata: {
                status: "known",
                source: "provider",
                checkedAt: "2026-09-06T00:00:00.000Z",
                stale: false,
                supported: true,
                levels: ["max"],
              },
              reasoningOverride: { supported: true, levels: ["high"], defaultLevel: "high" },
            },
          ],
        },
      });
      expect(saved.connections[0]?.models[0]?.reasoningMetadata).toBeUndefined();
      expect(saved.connections[0]?.models[0]?.reasoningOverride?.defaultLevel).toBe("high");
    }),
);

it.effect("exposes only a compact suffix and updates it with the credential", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.save({ apiKey: Redacted.make("synthetic-secret-a7X9") });
    expect(first.connections[0]!.apiKeySuffix).toBe("a7X9");
    expect(json(first)).not.toContain("synthetic-secret");
    expect((yield* f.save()).connections[0]!.apiKeySuffix).toBe("a7X9");
    const rotated = yield* f.save({ apiKey: Redacted.make("replacement-b8Y0") });
    expect(rotated.connections[0]!.apiKeySuffix).toBe("b8Y0");
    yield* rejects(f.save({ apiKey: Redacted.make("failed-c9Z1") }, true), "Simulated");
    expect(f.settings().customModels).toEqual(rotated);
    expect((yield* f.save({ removeKey: true })).connections[0]!.apiKeySuffix).toBeNull();
    for (const key of ["a", "ab", "abc", "abcd"]) {
      expect(
        (yield* f.save({ apiKey: Redacted.make(key) })).connections[0]!.apiKeySuffix,
      ).toBeNull();
    }
  }),
);

it.effect("adds hints to legacy catalogs without changing secrets or failing on missing keys", () =>
  Effect.gen(function* () {
    const f = fixture();
    const saved = yield* f.save({ apiKey: Redacted.make("legacy-secret-Z9x8") });
    const legacy = {
      ...saved,
      connections: [{ ...connection, credentialId: saved.connections[0]!.credentialId }],
    };
    const hydrated = yield* withCustomModelKeyHints(legacy, f.secrets);
    expect(hydrated.connections[0]!.apiKeySuffix).toBe("Z9x8");
    expect(hydrated.revision).toBe(legacy.revision);
    expect(json(hydrated)).not.toContain("legacy-secret");
    expect(f.values.size).toBe(1);
    const unreadable = {
      ...f.secrets,
      get: () =>
        Effect.fail(new SecretStoreReadError({ resource: "synthetic-key", cause: "unreadable" })),
    };
    expect(
      (yield* withCustomModelKeyHints(legacy, unreadable)).connections[0]!.apiKeySuffix,
    ).toBeNull();
    f.values.clear();
    expect(
      (yield* withCustomModelKeyHints(legacy, f.secrets)).connections[0]!.apiKeySuffix,
    ).toBeNull();
    expect(yield* withCustomModelKeyHints(hydrated, unreadable)).toEqual(hydrated);
  }),
);

it.effect("stores one key separately and reuses it across models", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.save({ apiKey: Redacted.make("synthetic-key") });
    yield* f.save({
      connection: {
        ...connection,
        models: [...connection.models, { ...connection.models[0]!, id: "two", modelId: "two" }],
      },
    });
    expect(f.values.size).toBe(1);
    expect(f.settings().customModels.connections[0]!.credentialId).toBe(
      first.connections[0]!.credentialId,
    );
    expect(json(f.settings())).not.toContain("synthetic-key");
    expect(
      (yield* resolveCustomModels(f.settings().customModels, pi, f.secrets))[0]!.models,
    ).toHaveLength(2);
  }),
);
it.effect("rotates keys without retaining the old credential", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.save({ apiKey: Redacted.make("old-key") });
    const next = yield* f.save({ apiKey: Redacted.make("new-key") });
    expect(next.connections[0]!.credentialId).not.toBe(first.connections[0]!.credentialId);
    expect(f.values.has(customModelSecretName(first.connections[0]!.credentialId!))).toBe(false);
    expect(f.values.size).toBe(1);
  }),
);
it.effect("keeps the previous key and metadata if the commit fails", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.save({ apiKey: Redacted.make("old-key") });
    yield* rejects(f.save({ apiKey: Redacted.make("new-key") }, true), "Simulated disk failure");
    expect(f.settings().customModels).toEqual(first);
    expect(f.values.size).toBe(1);
    expect(Redacted.value((yield* resolveCustomModels(first, pi, f.secrets))[0]!.apiKey!)).toBe(
      "old-key",
    );
  }),
);
it.effect("rejects stale edits before creating a secret", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.save();
    yield* rejects(f.save({ revision: 0, apiKey: Redacted.make("never-saved") }), "changed");
    expect(f.values.size).toBe(0);
    expect(f.settings().customModels.revision).toBe(1);
  }),
);
it.effect("requires re-entering a retained key when the host changes", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.save({ apiKey: Redacted.make("key") });
    yield* rejects(
      f.save({ connection: { ...connection, baseUrl: "https://different.test/v1" } }),
      "Re-enter",
    );
    yield* f.save({
      connection: { ...connection, baseUrl: "https://different.test/v1" },
      apiKey: Redacted.make("new"),
    });
    expect(f.values.size).toBe(1);
  }),
);
it.effect("supports keyless connections and explicit credential removal", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.save({ apiKey: Redacted.make("key") });
    const next = yield* f.save({
      removeKey: true,
      connection: { ...connection, baseUrl: "http://localhost:8080/v1" },
    });
    expect(f.values.size).toBe(0);
    expect(next.connections[0]!.credentialId).toBeNull();
    expect((yield* resolveCustomModels(next, pi, f.secrets))[0]!.apiKey).toBeNull();
  }),
);
it.effect("only resolves explicitly attached models", () =>
  Effect.gen(function* () {
    const f = fixture();
    const next = yield* f.save({ apiKey: Redacted.make("key") });
    expect(yield* resolveCustomModels(next, second, f.secrets)).toEqual([]);
    expect((yield* resolveCustomModels(next, pi, f.secrets))[0]!.models).toHaveLength(1);
    yield* f.save({
      connection: {
        ...connection,
        models: connection.models.map((m) => ({ ...m, instanceIds: [] })),
      },
    });
    expect(yield* resolveCustomModels(f.settings().customModels, pi, f.secrets)).toEqual([]);
  }),
);
it.effect("isolates a missing credential and recovers after key replacement", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.save({ apiKey: Redacted.make("key") });
    const next = yield* f.save({
      connection: { ...connection, id: "healthy" },
      apiKey: Redacted.make("healthy-key"),
    });
    f.values.delete(customModelSecretName(first.connections[0]!.credentialId!));
    const resolved = yield* resolveCustomModels(next, pi, f.secrets);
    expect(resolved[0]).toMatchObject({
      id: "connection",
      credentialError: expect.stringContaining("Re-enter"),
    });
    expect(resolved[0]).not.toHaveProperty("apiKey");
    expect(Redacted.value(resolved[1]!.apiKey!)).toBe("healthy-key");
    const repaired = yield* f.save({ apiKey: Redacted.make("replacement-key") });
    const available = yield* resolveCustomModels(repaired, pi, f.secrets);
    expect(available.every((c) => c.credentialError === undefined)).toBe(true);
    expect(Redacted.value(available[0]!.apiKey!)).toBe("replacement-key");
  }),
);
it.effect(
  "isolates unreadable secrets without exposing their error details or blocking keyless models",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.save({ apiKey: Redacted.make("key") });
      const catalog = yield* f.save({ connection: { ...connection, id: "keyless" } });
      const resolved = yield* resolveCustomModels(catalog, pi, {
        ...f.secrets,
        get: () =>
          Effect.fail(
            new SecretStoreReadError({
              resource: "private-path",
              cause: "sensitive error body",
            }),
          ),
      });
      expect(resolved[0]).not.toHaveProperty("apiKey");
      expect(resolved[0]!.credentialError).toContain("Re-enter");
      expect(json(resolved)).not.toContain("sensitive error body");
      expect(json(resolved)).not.toContain("private-path");
      expect(resolved[1]!.apiKey).toBeNull();
      expect(resolved[1]).not.toHaveProperty("credentialError");
    }),
);
it.effect("rejects unsupported and missing agent instances", () =>
  Effect.gen(function* () {
    const f = fixture();
    for (const id of ["codex", "pi_missing"]) {
      yield* rejects(
        f.save({
          connection: {
            ...connection,
            models: connection.models.map((m) => ({
              ...m,
              instanceIds: [ProviderInstanceId.make(id)],
            })),
          },
        }),
        "does not support",
      );
    }
    const current = {
      ...f.settings(),
      providerInstances: {
        [second]: { driver: ProviderDriverKind.make("pi"), enabled: true },
      },
    };
    yield* saveCustomModel(
      current,
      {
        revision: 0,
        connection: {
          ...connection,
          models: connection.models.map((m) => ({ ...m, instanceIds: [second] })),
        },
      },
      f.secrets,
      () => Effect.void,
    );
    const droid = ProviderInstanceId.make("droid_work");
    yield* saveCustomModel(
      {
        ...f.settings(),
        providerInstances: {
          [droid]: { driver: ProviderDriverKind.make("droid"), enabled: true },
        },
      },
      {
        revision: 0,
        connection: {
          ...connection,
          models: connection.models.map((m) => ({ ...m, instanceIds: [droid] })),
        },
      },
      f.secrets,
      () => Effect.void,
    );
  }),
);
it.effect("rejects malformed keys before persistence", () =>
  Effect.gen(function* () {
    const f = fixture();
    for (const key of ["", " ", "key\nheader", "key\rheader", "key\0", "x".repeat(16385)]) {
      yield* rejects(f.save({ apiKey: Redacted.make(key) }), "valid API key");
      expect(f.values.size).toBe(0);
    }
  }),
);
it.effect("never evaluates command or environment-shaped keys", () =>
  Effect.gen(function* () {
    const f = fixture();
    for (const key of ["!echo test", "$SECRET", "${SECRET}"]) {
      const next = yield* f.save({ apiKey: Redacted.make(key) });
      expect(Redacted.value((yield* resolveCustomModels(next, pi, f.secrets))[0]!.apiKey!)).toBe(
        key,
      );
    }
  }),
);
