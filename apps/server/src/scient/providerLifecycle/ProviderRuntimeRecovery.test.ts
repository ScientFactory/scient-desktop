import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ProviderRuntimeManager, type ProviderRuntimeOutcome } from "./ProviderRuntimeManager.ts";
import { make as makeRecovery } from "./ProviderRuntimeRecovery.ts";
import { make as makeRequests, ProviderRuntimeRequests } from "./ProviderRuntimeRequests.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const CODEX = ProviderDriverKind.make("codex");
const MINUTE = 60_000;

const runtime: ProviderRuntimeSummary = {
  source: "missing",
  supportTier: "fully_assisted",
  target: "darwin-arm64",
  actions: ["install"],
  managedVersion: null,
  previousManagedVersion: null,
  operation: null,
  message: "Codex setup is available.",
};

const codex: ServerProvider = {
  instanceId: INSTANCE,
  driver: CODEX,
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-11-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: { methods: [], canDisconnect: false, operation: null, runtime },
};

const plan = (catalogRevision: string) => ({
  instanceId: INSTANCE,
  action: "install" as const,
  target: "darwin-arm64",
  version: "0.147.0",
  downloadBytes: 100,
  sourceLabel: "Official OpenAI release",
  catalogRevision,
  message: "Install reviewed Codex.",
});

const request = {
  instanceId: INSTANCE,
  driver: CODEX,
  action: "install" as const,
  catalogRevision: "reviewed:1",
};

describe("ProviderRuntimeRequests", () => {
  it.effect("keeps the user's request across a restart without making it due at once", () =>
    Effect.gen(function* () {
      const before = yield* makeRequests();
      yield* before.requested(request);
      const after = yield* makeRequests();
      const [kept] = yield* after.list;
      assert.deepInclude(kept, { ...request, retries: 0 });
      // A restart while the user's own download runs waits as long as a failure would.
      assert.isAtLeast(kept!.dueAt, (yield* Clock.currentTimeMillis) + 4 * MINUTE);
      yield* after.requested({ ...request, action: "remove" });
      assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-requests-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ProviderRuntimeRecovery", () => {
  // Requests stay in memory here, so the loop's only waits are the clock and these calls.
  const harness = (catalogRevision: string) =>
    Effect.gen(function* () {
      const starts = yield* Ref.make<ReadonlyArray<{ attempt: number; at: number }>>([]);
      const requests = yield* makeRequests().pipe(Effect.provide(FileSystem.layerNoop({})));
      yield* requests.requested(request);
      // The user's own try failed in a way a later try can fix.
      yield* requests.settled({ instanceId: INSTANCE, driver: CODEX, outcome: "retryable" });
      yield* makeRecovery().pipe(
        Effect.provideService(ProviderRuntimeRequests, requests),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed([codex]),
              streamChanges: Stream.never,
            }),
            Layer.mock(ProviderRuntimeManager)({
              plan: () => Effect.succeed(plan(catalogRevision)),
              // As the manager does: a failure that may pass keeps the request.
              startInBackground: (input) =>
                Effect.gen(function* () {
                  const at = yield* Clock.currentTimeMillis;
                  yield* Ref.update(starts, (all) => [...all, { attempt: input.attempt, at }]);
                  yield* requests.settled({
                    instanceId: input.instanceId,
                    driver: CODEX,
                    outcome: "retryable",
                  });
                  return "failed" as ProviderRuntimeOutcome;
                }),
            }),
          ),
        ),
      );
      const runFor = (minutes: number) =>
        Effect.forEach(Array.from({ length: minutes }), () => TestClock.adjust("1 minute"), {
          discard: true,
        });
      return { starts, requests, runFor };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-recovery-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

  it.effect("tries again about 5 minutes, then 30 minutes, then 2 hours after each failure", () =>
    Effect.gen(function* () {
      const { starts, runFor } = yield* harness("reviewed:1");
      yield* runFor(4 * 60);
      const tries = yield* Ref.get(starts);
      assert.deepStrictEqual(
        tries.map((entry) => entry.attempt),
        [1, 2, 3],
      );
      const [first, second, third] = tries.map((entry) => entry.at / MINUTE);
      // Jittered by a fifth either way, then picked up at the next one-minute check.
      assert.isTrue(first! >= 4 && first! <= 7, `first try at ${first}`);
      assert.isTrue(second! - first! >= 24 && second! - first! <= 37, `second at ${second}`);
      assert.isTrue(third! - second! >= 96 && third! - second! <= 145, `third at ${third}`);
    }),
  );

  it.effect("drops the request when the plan changed instead of installing another one", () =>
    Effect.gen(function* () {
      const { starts, requests, runFor } = yield* harness("reviewed:2");
      yield* runFor(10);
      assert.deepStrictEqual(yield* Ref.get(starts), []);
      assert.deepStrictEqual(yield* requests.list, []);
    }),
  );
});
