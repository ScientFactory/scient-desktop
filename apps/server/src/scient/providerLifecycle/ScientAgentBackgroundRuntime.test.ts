import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { ProviderRuntimeManager, type ProviderRuntimeOutcome } from "./ProviderRuntimeManager.ts";
import {
  backgroundRuntimeAction,
  firstPickState,
  make,
  parseMeteredOutput,
} from "./ScientAgentBackgroundRuntime.ts";

const INSTANCE = ProviderInstanceId.make("scient");

function scientAgent(runtime: Partial<ProviderRuntimeSummary> = {}): ServerProvider {
  return {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("scient"),
    enabled: true,
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    checkedAt: "2026-11-13T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "missing",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["install"],
        managedVersion: null,
        previousManagedVersion: null,
        qualifiedVersion: "0.1.6",
        operation: null,
        message: "Not installed.",
        ...runtime,
      },
    },
  };
}

describe("backgroundRuntimeAction", () => {
  it("installs a missing agent and updates a Scient-managed one", () => {
    assert.deepStrictEqual(backgroundRuntimeAction(scientAgent(), {}), {
      kind: "start",
      action: "install",
      version: "0.1.6",
    });
    const managed = scientAgent({
      source: "scient_managed",
      actions: ["update", "remove"],
      managedVersion: "0.1.5",
      availableManagedVersion: "0.1.6",
    });
    assert.deepStrictEqual(backgroundRuntimeAction(managed, {}), {
      kind: "start",
      action: "update",
      version: "0.1.6",
    });
    // A system or custom copy belongs to the user.
    assert.strictEqual(
      backgroundRuntimeAction(scientAgent({ source: "system", actions: ["install"] }), {}).kind,
      "wait",
    );
  });

  it("respects the user's Remove or Cancel, and gives up on a release after five failures", () => {
    assert.strictEqual(backgroundRuntimeAction(scientAgent(), { userStopped: true }).kind, "wait");
    const managed = scientAgent({
      source: "scient_managed",
      actions: ["update"],
      availableManagedVersion: "0.1.6",
    });
    assert.strictEqual(backgroundRuntimeAction(managed, { skippedVersion: "0.1.6" }).kind, "wait");
    assert.strictEqual(backgroundRuntimeAction(managed, { skippedVersion: "0.1.5" }).kind, "start");
    assert.strictEqual(
      backgroundRuntimeAction(scientAgent(), { failures: { version: "0.1.6", count: 5 } }).kind,
      "wait",
    );
    assert.strictEqual(
      backgroundRuntimeAction(scientAgent(), { failures: { version: "0.1.5", count: 5 } }).kind,
      "start",
    );
  });
});

describe("parseMeteredOutput", () => {
  it("reads Windows' connection cost and NetworkManager's connected devices", () => {
    assert.isTrue(parseMeteredOutput("win32", "Fixed\r\n"));
    assert.isTrue(parseMeteredOutput("win32", "Variable"));
    assert.isFalse(parseMeteredOutput("win32", "Unrestricted"));
    assert.isFalse(parseMeteredOutput("win32", ""));
    const nmcli = (state: string, metered: string) =>
      `GENERAL.STATE:${state}\nGENERAL.METERED:${metered}\n\nGENERAL.STATE:10 (unmanaged)\nGENERAL.METERED:unknown\n`;
    assert.isTrue(parseMeteredOutput("linux", nmcli("100 (connected)", "yes (guessed)")));
    assert.isFalse(parseMeteredOutput("linux", nmcli("100 (connected)", "no")));
    assert.isFalse(parseMeteredOutput("linux", nmcli("30 (disconnected)", "yes")));
  });
});

describe("firstPickState", () => {
  it("says whether the agent was ready, still downloading, failed or never started", () => {
    assert.deepStrictEqual(
      firstPickState({
        ...scientAgent({ source: "scient_managed", managedVersion: "0.1.6" }),
        installed: true,
      }),
      { state: "ready" },
    );
    const operation = {
      operationId: "runtime-1",
      action: "install" as const,
      startedAt: "2026-11-13T00:00:00.000Z",
      message: "Downloading.",
      background: true,
    };
    assert.deepStrictEqual(
      firstPickState(
        scientAgent({
          operation: {
            ...operation,
            status: "downloading",
            finishedAt: null,
            downloadedBytes: 64,
            totalBytes: 100,
          },
        }),
      ),
      { state: "in_progress", percent: 64 },
    );
    assert.deepStrictEqual(
      firstPickState(
        scientAgent({
          operation: { ...operation, status: "failed", finishedAt: "2026-11-13T00:01:00.000Z" },
        }),
      ),
      { state: "failed" },
    );
    assert.deepStrictEqual(firstPickState(scientAgent()), { state: "not_started" });
  });
});

describe("ScientAgentBackgroundRuntime", () => {
  // The record lives in memory, so the loop's only waits are the clock and the counted calls.
  const harness = (outcomes: ReadonlyArray<ProviderRuntimeOutcome>) =>
    Effect.gen(function* () {
      const starts = yield* SubscriptionRef.make<ReadonlyArray<number>>([]);
      const record = yield* SubscriptionRef.make<string | null>(null);
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const queue = [...outcomes];
      const service = yield* make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed([scientAgent()]),
              streamChanges: Stream.never,
            }),
            Layer.mock(ProviderRuntimeManager)({
              plan: () =>
                Effect.succeed({
                  instanceId: INSTANCE,
                  action: "install",
                  target: "darwin-arm64",
                  version: "0.1.6",
                  downloadBytes: 100,
                  sourceLabel: "Scient Agent release",
                  catalogRevision: "reviewed:1",
                  message: "Install.",
                }),
              startInBackground: (input) =>
                SubscriptionRef.update(starts, (all) => [...all, input.attempt]).pipe(
                  Effect.as(queue.shift() ?? "succeeded"),
                ),
            }),
            Layer.mock(ProcessRunner)({}),
            Layer.mock(AnalyticsService)({
              record: (event) => Ref.update(events, (all) => [...all, event]),
            }),
            FileSystem.layerNoop({
              makeDirectory: () => Effect.void,
              readFileString: (path) =>
                SubscriptionRef.get(record).pipe(
                  Effect.flatMap((text) =>
                    text === null
                      ? Effect.fail(
                          PlatformError.systemError({
                            _tag: "NotFound",
                            module: "FileSystem",
                            method: "readFileString",
                            pathOrDescriptor: path,
                          }),
                        )
                      : Effect.succeed(text),
                  ),
                ),
              writeFileString: (_path, text) => SubscriptionRef.set(record, text),
            }),
          ),
        ),
        Effect.provideServiceEffect(
          ServerConfig.ServerConfig,
          ServerConfig.ServerConfig.pipe(
            Effect.map((config) => ({ ...config, mode: "desktop" as const })),
          ),
        ),
        Effect.provide(ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-background-" })),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      const awaitValue = <A>(
        ref: SubscriptionRef.SubscriptionRef<A>,
        done: (value: A) => boolean,
      ) => SubscriptionRef.changes(ref).pipe(Stream.filter(done), Stream.runHead, Effect.asVoid);
      return { service, starts, record, events, awaitValue };
    });

  it.effect("installs quietly a minute after launch and backs off after a failure", () =>
    Effect.gen(function* () {
      const { starts, record, awaitValue } = yield* harness(["failed", "succeeded"]);
      yield* TestClock.adjust("59 seconds");
      assert.deepStrictEqual(yield* SubscriptionRef.get(starts), []);
      yield* TestClock.adjust("1 second");
      yield* awaitValue(record, (text) => text?.includes('"count":1') === true);
      assert.deepStrictEqual(yield* SubscriptionRef.get(starts), [1]);
      yield* TestClock.adjust("4 minutes");
      assert.deepStrictEqual(yield* SubscriptionRef.get(starts), [1]);
      yield* TestClock.adjust("1 minute");
      yield* awaitValue(starts, (all) => all.length === 2);
      assert.deepStrictEqual(yield* SubscriptionRef.get(starts), [1, 2]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("remembers that the user cancelled a background install", () =>
    Effect.gen(function* () {
      const { record, awaitValue } = yield* harness(["cancelled"]);
      yield* TestClock.adjust("60 seconds");
      yield* awaitValue(record, (text) => text !== null);
      assert.deepStrictEqual(JSON.parse((yield* SubscriptionRef.get(record))!), {
        userStopped: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the first pick once per installation", () =>
    Effect.gen(function* () {
      const { service, events } = yield* harness([]);
      yield* service.observePick(INSTANCE);
      yield* service.observePick(INSTANCE);
      assert.deepStrictEqual(yield* Ref.get(events), ["provider.runtime.first_pick"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
