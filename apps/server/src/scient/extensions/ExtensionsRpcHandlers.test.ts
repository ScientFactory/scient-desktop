import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import {
  ConnectorRuntime,
  ExtensionDeliveryReceipts,
  ScientPluginRegistry,
} from "./ExtensionsServices.ts";
import {
  changeFeedLayer,
  ExtensionsChangeFeed,
  providerSupportChanges,
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
