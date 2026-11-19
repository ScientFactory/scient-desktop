import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { AntigravityInstallation } from "../../provider/AntigravityInstallation.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import type { ScientProviderInstance } from "../../provider/ScientProviderInstance.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { ProviderActivity } from "./ProviderActivity.ts";
import {
  makeWorker,
  MODEL_LIST_MAX_AGE_MS,
  MODEL_REFRESH_STATE_FILE,
} from "./ProviderModelFreshness.ts";

const START = Date.parse("2026-11-19T12:00:00.000Z");

const provider = (id: string, signedIn = true, connection?: unknown): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: "1.5.0",
    status: "ready",
    auth: { status: signedIn ? "authenticated" : "unauthenticated", required: true },
    checkedAt: "2026-11-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(connection ? { connection } : {}),
  }) as unknown as ServerProvider;

const operation = (status: string) => ({ status });

const harness = Effect.fn(function* (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly refresh?: (id: string) => Effect.Effect<void>;
  readonly stateDir: string;
  readonly installPhase?: string;
  readonly busy?: () => boolean;
}) {
  const refreshed: string[] = [];
  const published: string[] = [];
  const instances = input.providers.map(
    (entry) =>
      ({
        instanceId: entry.instanceId,
        driverKind: entry.driver,
        enabled: true,
        refreshModels: () =>
          (input.refresh?.(entry.instanceId) ?? Effect.void).pipe(
            Effect.andThen(Effect.sync(() => void refreshed.push(entry.instanceId))),
          ),
      }) as unknown as ScientProviderInstance,
  );
  const worker = yield* makeWorker().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfig, { stateDir: input.stateDir } as ServerConfig["Service"]),
        Layer.succeed(ProviderRegistry, {
          ...makeProviderRegistryMock(input.providers),
          refreshInstance: (id) =>
            Effect.sync(() => {
              published.push(id);
              return input.providers;
            }),
        }),
        Layer.succeed(ProviderInstanceRegistry, {
          listInstances: Effect.succeed(instances),
        } as unknown as ProviderInstanceRegistryShape),
        Layer.succeed(ProviderActivity, {
          isBusy: () => Effect.sync(() => input.busy?.() ?? false),
        }),
        Layer.succeed(AntigravityInstallation, {
          state: Effect.succeed({ driver: "antigravity", phase: input.installPhase ?? "idle" }),
        } as unknown as AntigravityInstallation["Service"]),
      ),
    ),
  );
  // `refreshStale` runs one pass inline; `worker` is the real background worker.
  return { refreshStale: worker.drain, worker, refreshed, published };
});

describe("ProviderModelFreshness", () => {
  it.effect("reloads a stale signed-in list, at most once per maximum age, across restarts", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const providers = [provider("antigravity"), provider("antigravity-work", false)];
      yield* TestClock.setTime(START);
      const first = yield* harness({ providers, stateDir });
      yield* first.refreshStale;
      // Only the signed-in instance reloads, and its new list is published.
      assert.deepStrictEqual(first.refreshed, ["antigravity"]);
      assert.deepStrictEqual(first.published, ["antigravity"]);

      // A restart reads the saved time, so the picker opening again changes nothing.
      yield* TestClock.adjust(MODEL_LIST_MAX_AGE_MS - 1);
      const restarted = yield* harness({ providers, stateDir });
      yield* restarted.refreshStale;
      assert.deepStrictEqual(restarted.refreshed, []);

      yield* TestClock.adjust(1);
      yield* restarted.refreshStale;
      assert.deepStrictEqual(restarted.refreshed, ["antigravity"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs one reload at a time however many times the picker opens", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* TestClock.setTime(START);
      const startedA = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const startedB = yield* Deferred.make<void>();
      let active = 0;
      let peak = 0;
      const { worker, refreshed } = yield* harness({
        providers: [provider("antigravity"), provider("antigravity-work")],
        stateDir,
        refresh: (id) =>
          Effect.gen(function* () {
            peak = Math.max(peak, ++active);
            if (id === "antigravity") {
              yield* Deferred.succeed(startedA, undefined);
              yield* Deferred.await(releaseA);
            } else {
              yield* Deferred.succeed(startedB, undefined);
            }
            active--;
          }),
      });
      yield* worker.run.pipe(Effect.forkScoped);
      yield* worker.refreshStale;
      yield* Deferred.await(startedA);
      // More picker opens while the first reload runs start nothing new.
      yield* worker.refreshStale;
      yield* worker.refreshStale;
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(startedB));
      yield* Deferred.succeed(releaseA, undefined);
      yield* Deferred.await(startedB);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      assert.strictEqual(peak, 1);
      assert.deepStrictEqual(refreshed, ["antigravity", "antigravity-work"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps reloading other instances after one is interrupted by a sign-out", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* TestClock.setTime(START);
      const { refreshStale, refreshed, published } = yield* harness({
        providers: [provider("antigravity"), provider("antigravity-work")],
        refresh: (id) => (id === "antigravity" ? Effect.interrupt : Effect.void),
        stateDir,
      });
      yield* refreshStale;
      assert.deepStrictEqual(refreshed, ["antigravity-work"]);
      assert.deepStrictEqual(published, ["antigravity-work"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits only for running work: operations, a sibling's runtime change, an install", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* TestClock.setTime(START);
      const finished = provider("antigravity", true, {
        operation: operation("connected"),
        runtime: { operation: operation("succeeded") },
      });
      const removing = provider("antigravity-work", false, {
        operation: null,
        runtime: { operation: operation("removing") },
      });
      const blocked = yield* harness({ providers: [finished, removing], stateDir });
      yield* blocked.refreshStale;
      assert.deepStrictEqual(blocked.refreshed, []);

      const installing = yield* harness({
        providers: [finished],
        stateDir,
        installPhase: "extracting",
      });
      yield* installing.refreshStale;
      assert.deepStrictEqual(installing.refreshed, []);

      // A finished sign-in and update stay on the snapshot but do not block.
      const idle = yield* harness({ providers: [finished], stateDir });
      yield* idle.refreshStale;
      assert.deepStrictEqual(idle.refreshed, ["antigravity"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rechecks each instance right before it launches", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* TestClock.setTime(START);
      let busy = false;
      const { refreshStale, refreshed } = yield* harness({
        providers: [provider("antigravity"), provider("antigravity-work")],
        stateDir,
        // A chat starts while the first instance reloads.
        refresh: (id) => Effect.sync(() => void (id === "antigravity" && (busy = true))),
        busy: () => busy,
      });
      yield* refreshStale;
      assert.deepStrictEqual(refreshed, ["antigravity"]);

      // The skipped instance was not charged an attempt: once idle, the next open reloads it.
      busy = false;
      yield* refreshStale;
      assert.deepStrictEqual(refreshed, ["antigravity", "antigravity-work"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the limit when the attempt time cannot be saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      // A folder where the file should be: reads and atomic writes both fail.
      yield* fs.makeDirectory(`${stateDir}/${MODEL_REFRESH_STATE_FILE}`);
      yield* TestClock.setTime(START);
      const { refreshStale, refreshed } = yield* harness({
        providers: [provider("antigravity")],
        stateDir,
      });
      yield* refreshStale;
      yield* TestClock.adjust("1 hour");
      yield* refreshStale;
      assert.deepStrictEqual(refreshed, ["antigravity"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
