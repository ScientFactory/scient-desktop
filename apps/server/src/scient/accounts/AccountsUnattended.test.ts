import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Redacted } from "effect";
import type { CustomModelAccountResolver } from "../../customModels.ts";
import { makeHarness, memoryStore, recordingKeychain, website } from "./Accounts.testkit.ts";

const backgroundRunning = { mode: "desktop", backgroundRunning: true } as const;
const origin = "http://127.0.0.1:8080";
const modelKey = {
  name: "Synthetic model key",
  details: {
    kind: "api-key" as const,
    sites: [origin],
    auth: { type: "bearer" as const },
    purpose: "custom-models" as const,
  },
  secrets: { token: { type: "scient" as const, value: "synthetic-model-key" } },
};

/** A model catalog that keeps every resolver Accounts installs; `reinstalled` on the second. */
const modelCatalogFixture = Effect.fn("AccountsUnattendedTest.modelCatalog")(function* () {
  const resolvers: Array<CustomModelAccountResolver> = [];
  const reinstalled = yield* Deferred.make<void>();
  const modelCatalog = {
    connections: Effect.succeed([]),
    readLegacy: () => Effect.undefined,
    removeLegacy: () => Effect.void,
    setBinding: () => Effect.succeed(true),
    installResolver: (resolve: CustomModelAccountResolver) =>
      Effect.sync(() => void resolvers.push(resolve)).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            resolvers.length > 1 ? Deferred.succeed(reinstalled, undefined) : Effect.void,
          ),
        ),
        Effect.asVoid,
      ),
  };
  return { resolvers, reinstalled, modelCatalog };
});

it.effect("work before the person's first use of Accounts shows no prompt and loses nothing", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain(backgroundRunning);
    const before = yield* makeHarness({ storage, keychain });
    const { accountId } = yield* before.service.save(website());
    const records = new Map(storage.blobs);
    reads.length = 0;

    const { service } = yield* makeHarness({ storage, keychain });
    // What runs before any foreground use: paper recovery, then unattended work that asks first.
    yield* service.setPaperQueue({
      root: "/synthetic/project",
      waiting: 1,
      saved: 0,
      failed: 0,
      requests: [],
      paused: [],
    });
    expect(yield* service.openWithoutPrompt).toBe(false);
    expect(reads).toEqual([]);
    expect(new Map(storage.blobs)).toEqual(records);

    // The next foreground use opens the store, with everything in it.
    const snapshot = yield* service.snapshot;
    expect(reads).toHaveLength(1);
    expect(snapshot.accounts.map((account) => account.accountId)).toEqual([accountId]);
    expect(snapshot.paperQueues?.map((queue) => queue.root)).toEqual(["/synthetic/project"]);
  }),
);

it.effect(
  "custom models linked to saved keys make no keychain call before the person uses Accounts",
  () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { keychain, reads } = yield* recordingKeychain(backgroundRunning);
      const { resolvers, reinstalled, modelCatalog } = yield* modelCatalogFixture();
      const before = yield* makeHarness({ storage, keychain, sourceOverrides: { modelCatalog } });
      const { accountId } = yield* before.service.save(modelKey);
      reads.length = 0;
      resolvers.length = 0;

      // Provider probes resolve the linked model's key before any foreground use.
      const { service } = yield* makeHarness({
        storage,
        keychain,
        sourceOverrides: { modelCatalog },
      });
      const probe = resolvers[0]!;
      const refused = yield* probe(accountId, origin, "openai-completions").pipe(Effect.flip);
      expect(refused.reason).toBe("unavailable");
      expect(reads).toEqual([]);

      // The person's first use opens the store; the key resolves again without a second prompt.
      yield* service.snapshot;
      expect(reads).toHaveLength(1);
      yield* Deferred.await(reinstalled);
      const { token } = yield* resolvers[1]!(accountId, origin, "openai-completions");
      expect(Redacted.value(token)).toBe("synthetic-model-key");
      expect(reads).toHaveLength(1);
    }),
);

it.effect.each([
  { host: "a desktop that quits with its last window", mode: "desktop", backgroundRunning: false },
  { host: "a server without a desktop", mode: "web", backgroundRunning: true },
] as const)("on $host, unattended work opens the store as any use does", (host) =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain(host);
    const { resolvers, modelCatalog } = yield* modelCatalogFixture();
    const before = yield* makeHarness({ storage, keychain, sourceOverrides: { modelCatalog } });
    const { accountId } = yield* before.service.save(modelKey);

    // A provider probe at start opens the store to resolve the linked model's key.
    reads.length = 0;
    resolvers.length = 0;
    yield* makeHarness({ storage, keychain, sourceOverrides: { modelCatalog } });
    const { token } = yield* resolvers[0]!(accountId, origin, "openai-completions");
    expect(Redacted.value(token)).toBe("synthetic-model-key");
    expect(reads).toHaveLength(1);

    // So does other unattended work, such as renewal.
    reads.length = 0;
    const { service } = yield* makeHarness({ storage, keychain });
    expect(yield* service.openWithoutPrompt).toBe(true);
    expect(reads).toHaveLength(1);
  }),
);
