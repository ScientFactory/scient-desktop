import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Redacted } from "effect";
import type { CustomModelAccountResolver } from "../../customModels.ts";
import type { AccountKeychain } from "./AccountVault.ts";
import { makeHarness, memoryStore, website } from "./Accounts.testkit.ts";

it.effect("work before the person's first use of Accounts shows no prompt and loses nothing", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const items = new Map<string, Redacted.Redacted<string>>();
    const prompts: string[] = [];
    let needsPerson = false;
    const keychain: AccountKeychain = {
      read: (account) =>
        Effect.sync(() => {
          prompts.push(account);
          return items.get(account) ?? null;
        }),
      readWithoutPrompt: (account) =>
        Effect.succeed(needsPerson ? "needs-person" : (items.get(account) ?? null)),
      write: (account, value) =>
        Effect.sync(() => {
          items.set(account, value);
        }),
    };
    const before = yield* makeHarness({ storage, keychain });
    const { accountId } = yield* before.service.save(website());
    const records = new Map(storage.blobs);
    prompts.length = 0;

    needsPerson = true;
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
    expect(prompts).toEqual([]);
    expect(new Map(storage.blobs)).toEqual(records);

    // The next foreground use opens the store, with everything in it.
    const snapshot = yield* service.snapshot;
    expect(prompts).toHaveLength(1);
    expect(snapshot.accounts.map((account) => account.accountId)).toEqual([accountId]);
    expect(snapshot.paperQueues?.map((queue) => queue.root)).toEqual(["/synthetic/project"]);
  }),
);

it.effect(
  "custom models linked to saved keys make no keychain call before the person uses Accounts",
  () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const items = new Map<string, Redacted.Redacted<string>>();
      const keychainReads: string[] = [];
      const keychain: AccountKeychain = {
        read: (account) =>
          Effect.sync(() => {
            keychainReads.push(account);
            return items.get(account) ?? null;
          }),
        // What macOS answers now: unattended work never touches the keychain.
        readWithoutPrompt: () => Effect.succeed("needs-person"),
        write: (account, value) =>
          Effect.sync(() => {
            items.set(account, value);
          }),
      };
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
      const origin = "http://127.0.0.1:8080";
      const before = yield* makeHarness({ storage, keychain, sourceOverrides: { modelCatalog } });
      const { accountId } = yield* before.service.save({
        name: "Synthetic model key",
        details: {
          kind: "api-key",
          sites: [origin],
          auth: { type: "bearer" },
          purpose: "custom-models",
        },
        secrets: { token: { type: "scient", value: "synthetic-model-key" } },
      });
      keychainReads.length = 0;
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
      expect(keychainReads).toEqual([]);

      // The person's first use opens the store; the key resolves again without a second prompt.
      yield* service.snapshot;
      expect(keychainReads).toHaveLength(1);
      yield* Deferred.await(reinstalled);
      const { token } = yield* resolvers[1]!(accountId, origin, "openai-completions");
      expect(Redacted.value(token)).toBe("synthetic-model-key");
      expect(keychainReads).toHaveLength(1);
    }),
);
