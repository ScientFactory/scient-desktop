import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import {
  ConnectorRuntime,
  ExtensionDeliveryReceipts,
  ScientPluginRegistry,
} from "./ExtensionsServices.ts";
import {
  changeFeedLayer,
  ExtensionsChangeFeed,
  followProviderStoreChanges,
  providerSupportChanges,
  validateConnectorAgents,
  providerStoreEntryError,
} from "./ExtensionsRpcHandlers.ts";

const provider = (
  instance: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instance),
  driver: ProviderDriverKind.make(driver),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const summarize = (key: string): string => {
  const entries: ReadonlyArray<{ providerInstanceId: string; driver: string; status: string }> =
    JSON.parse(key).support;
  return entries
    .map((entry) => `${entry.providerInstanceId}:${entry.driver}:${entry.status}`)
    .join(",");
};

it.effect("announces provider additions, removals and driver changes, not health refreshes", () =>
  Effect.gen(function* () {
    const work = provider("work", "codex");
    const changes = yield* providerSupportChanges(
      [],
      Stream.make(
        [work],
        // A health check: new timestamp and status, same compatibility.
        [{ ...work, checkedAt: "2026-10-21T00:05:00.000Z", status: "warning" }],
        [work, provider("team", "claudeAgent")],
        // The same instance id now runs an unreviewed driver.
        [work, provider("team", "future-agent")],
        [work, provider("team", "future-agent", { checkedAt: "2026-10-21T01:00:00.000Z" })],
        [provider("team", "future-agent")],
      ),
    ).pipe(Stream.runCollect);
    assert.deepEqual(Array.from(changes, summarize), [
      "work:codex:supported",
      "work:codex:supported,team:claudeAgent:supported",
      "work:codex:supported,team:future-agent:unsupported",
      "team:future-agent:unsupported",
    ]);
  }),
);

it.effect("bumps the extensions revision when a provider instance is added", () =>
  Effect.gen(function* () {
    const snapshots = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const owners = Layer.mergeAll(
      Layer.mock(ConnectorRuntime)({ changes: Stream.never }),
      Layer.mock(ScientPluginRegistry)({ changes: Stream.never }),
      Layer.mock(ExtensionDeliveryReceipts)({ changes: Stream.never }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([provider("work", "codex")]),
        streamChanges: Stream.fromQueue(snapshots),
      }),
      Layer.mock(ProviderInstanceRegistry)({ streamChanges: Stream.never }),
    );
    const feed = Context.get(
      yield* Layer.build(changeFeedLayer.pipe(Layer.provide(owners))),
      ExtensionsChangeFeed,
    );
    const announced = yield* feed.changes.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    // The current snapshot again (a health refresh), then a new instance.
    yield* Queue.offer(snapshots, [provider("work", "codex", { status: "warning" })]);
    yield* Queue.offer(snapshots, [provider("work", "codex"), provider("team", "claudeAgent")]);
    assert.deepEqual(Array.from(yield* Fiber.join(announced)), [{ revision: 1 }]);
    assert.equal(yield* feed.current, 1);
  }),
);

it.effect("bumps the extensions revision when an instance is replaced with the same snapshot", () =>
  Effect.gen(function* () {
    const generations = yield* Queue.unbounded<void>();
    const owners = Layer.mergeAll(
      Layer.mock(ConnectorRuntime)({ changes: Stream.never }),
      Layer.mock(ScientPluginRegistry)({ changes: Stream.never }),
      Layer.mock(ExtensionDeliveryReceipts)({ changes: Stream.never }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([provider("agy", "antigravity")]),
        streamChanges: Stream.never,
      }),
      Layer.mock(ProviderInstanceRegistry)({ streamChanges: Stream.fromQueue(generations) }),
    );
    const feed = Context.get(
      yield* Layer.build(changeFeedLayer.pipe(Layer.provide(owners))),
      ExtensionsChangeFeed,
    );
    const announced = yield* feed.changes.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* Queue.offer(generations, undefined);
    assert.deepEqual(Array.from(yield* Fiber.join(announced)), [{ revision: 1 }]);
  }),
);

it.effect("follows a replaced instance to its new store's changes", () =>
  Effect.gen(function* () {
    const generations = yield* PubSub.unbounded<void>();
    const storeOf = (changes: Queue.Queue<void>, reads: Ref.Ref<number>) =>
      ({
        store: {
          changes: Stream.fromQueue(changes),
          search: () => Effect.die("unused"),
          entry: () => Effect.die("unused"),
          install: () => Effect.die("unused"),
        },
        refreshInventory: () => Ref.update(reads, (count) => count + 1),
      }) as unknown as ProviderPluginActions;
    const oldChanges = yield* Queue.unbounded<void>();
    const newChanges = yield* Queue.unbounded<void>();
    const oldReads = yield* Ref.make(0);
    const newReads = yield* Ref.make(0);
    let current = storeOf(oldChanges, oldReads);
    const notified = yield* Queue.unbounded<void>();
    yield* followProviderStoreChanges({
      providerRegistry: {
        getProviders: Effect.succeed([provider("agy", "antigravity")]),
        getProviderPluginActionsForInstance: () => Effect.sync(() => current),
      },
      generations: { subscribeChanges: PubSub.subscribe(generations) },
      notify: Queue.offer(notified, undefined).pipe(Effect.asVoid),
    });
    yield* Queue.offer(oldChanges, undefined);
    yield* Queue.take(notified);

    // The runtime manager rebuilds the instance: the old store is retired, a new one answers.
    current = storeOf(newChanges, newReads);
    yield* PubSub.publish(generations, undefined);
    yield* Queue.offer(newChanges, undefined);
    yield* Queue.take(notified);
    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(oldReads), 1);
    assert.equal(yield* Ref.get(newReads), 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "announces late workspace plugin content without looping on scan timestamps or ordering",
  () =>
    Effect.gen(function* () {
      const plugin = { id: "one", name: "One", source: "local" as const, enabled: true };
      const snapshot = (cwd: string, checkedAt: string, plugins: ReadonlyArray<typeof plugin>) => ({
        cwd,
        checkedAt,
        plugins,
        skills: [],
        slashCommands: [],
      });
      const first = snapshot("/one", "2026-10-26T00:00:00.000Z", []);
      const second = snapshot("/two", "2026-10-26T00:00:00.000Z", []);
      const original = provider("work", "codex", { workspaceSnapshots: [first, second] });
      const listed = { ...first, plugins: [plugin] };
      const changes = yield* providerSupportChanges(
        [original],
        Stream.make(
          [
            {
              ...original,
              workspaceSnapshots: [{ ...first, checkedAt: "2026-10-26T00:01:00.000Z" }, second],
            },
          ],
          [{ ...original, workspaceSnapshots: [listed, second] }],
          [
            {
              ...original,
              workspaceSnapshots: [second, { ...listed, checkedAt: "2026-10-26T00:02:00.000Z" }],
            },
          ],
          [{ ...original, workspaceSnapshots: [first, second] }],
        ),
      ).pipe(Stream.runCollect);
      assert.lengthOf(changes, 2);
    }),
);

it.effect(
  "validates supplied agent choices against configured instances without rewriting omitted or null choices",
  () =>
    Effect.gen(function* () {
      const known = ProviderInstanceId.make("work");
      const unknown = ProviderInstanceId.make("removed");
      const snapshots = Effect.succeed([
        provider("work", "codex"),
        provider("disabled", "claudeAgent", { enabled: false }),
      ]);
      for (const agents of [[unknown], [unknown, ProviderInstanceId.make("missing")]]) {
        const refused = yield* validateConnectorAgents({ agents }, snapshots).pipe(Effect.flip);
        assert.equal(refused.reason, "invalid-input");
        assert.include(refused.message, "None of the chosen agents is configured");
      }
      assert.deepEqual(
        (yield* validateConnectorAgents({ agents: [unknown, known, known] }, snapshots)).agents,
        [known],
      );
      assert.deepEqual(
        (yield* validateConnectorAgents(
          { agents: [ProviderInstanceId.make("disabled")] },
          snapshots,
        )).agents,
        [ProviderInstanceId.make("disabled")],
      );
      assert.deepEqual(
        yield* validateConnectorAgents({ agents: null }, Effect.die("must not read")),
        { agents: null },
      );
      assert.deepEqual(yield* validateConnectorAgents({}, Effect.die("must not read")), {});
      assert.deepEqual(yield* validateConnectorAgents({ agents: [] }, snapshots), { agents: [] });
    }),
);

it.effect("keeps store timeouts and read failures distinct from a store's missing entry", () =>
  Effect.gen(function* () {
    for (const message of [
      "The plugin store timed out.",
      "Could not read the configured plugin marketplaces.",
      "Connection refused",
    ]) {
      const error = yield* Effect.fail({ message }).pipe(
        Effect.mapError(providerStoreEntryError),
        Effect.flip,
      );
      assert.equal(error.reason, "state-unavailable");
      assert.equal(error.message, message);
    }
    for (const message of [
      "This plugin is no longer in the store.",
      "This Codex plugin is no longer available.",
    ]) {
      assert.equal(providerStoreEntryError({ message }).reason, "not-found");
    }
  }),
);
