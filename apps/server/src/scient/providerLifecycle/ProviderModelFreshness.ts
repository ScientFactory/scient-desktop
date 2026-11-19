/**
 * Antigravity lists models only from a started session (about 1 GB unpacked), so its health
 * check never re-reads them. Opening the model picker asks for new models; reload a list older
 * than {@link MODEL_LIST_MAX_AGE_MS} then, in the background, while the picker shows the old one.
 */
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";

import { ServerConfig } from "../../config.ts";
import { AntigravityInstallation } from "../../provider/AntigravityInstallation.ts";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ProviderActivity } from "./ProviderActivity.ts";
import type { ScientProviderInstance } from "../../provider/ScientProviderInstance.ts";

export const MODEL_LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const MODEL_REFRESH_STATE_FILE = "provider-model-refresh.json";

export class ProviderModelFreshness extends Context.Service<
  ProviderModelFreshness,
  {
    /** Start reloading every eligible stale model list in the background; returns at once. */
    readonly refreshStale: Effect.Effect<void>;
  }
>()("t3/scient/providerLifecycle/ProviderModelFreshness") {}

interface DueReload {
  readonly instance: ScientProviderInstance;
  readonly refresh: NonNullable<ScientProviderInstance["refreshModels"]>;
}

const RefreshTimesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number));
const decodeRefreshTimes = Schema.decodeUnknownEffect(RefreshTimesJson);
const encodeRefreshTimes = Schema.encodeEffect(RefreshTimesJson);

// Drivers put a user-safe summary in `detail`; the native error text stays out of the log.
const failureReason = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? "interrupted"
    : Option.match(Cause.findErrorOption(cause), {
        onNone: () => "unexpected failure",
        onSome: (error) =>
          typeof error === "object" && error !== null && "detail" in error
            ? String(error.detail)
            : "refresh failed",
      });

// Finished operations stay on the snapshot ("connected", "succeeded"); only running ones block.
const DONE = new Set(["connected", "succeeded", "failed", "cancelled"]);
const running = (operation: { readonly status: string } | null | undefined) =>
  operation != null && !DONE.has(operation.status);

/**
 * The worker and a drain step the tests can run inline. `refreshStale` only wakes the worker,
 * so a request that is interrupted or disconnects can never leave an instance half-claimed,
 * and requests can never start reloads side by side.
 */
export const makeWorker = Effect.fn("ProviderModelFreshness.makeWorker")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* ProviderRegistry;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const installation = yield* AntigravityInstallation;
  const activity = yield* ProviderActivity;
  const statePath = path.join((yield* ServerConfig).stateDir, MODEL_REFRESH_STATE_FILE);
  // Read once; later attempts live here first, so an unwritable file cannot lift the limit.
  const attempts: Record<string, number> = {
    ...(yield* fs.readFileString(statePath).pipe(
      Effect.flatMap(decodeRefreshTimes),
      Effect.orElseSucceed(() => ({})),
    )),
  };

  const save = Effect.suspend(() => encodeRefreshTimes({ ...attempts })).pipe(
    Effect.flatMap((contents) => writeFileStringAtomically({ filePath: statePath, contents })),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not save the model refresh time", { reason: failureReason(cause) }),
    ),
  );

  // The managed runtime is being downloaded or replaced; a refresh now would read the old one.
  const installing = (driver: string) =>
    installation.state.pipe(
      Effect.map(
        (state) =>
          state.driver === driver &&
          (state.phase === "downloading" ||
            state.phase === "extracting" ||
            state.phase === "verifying"),
      ),
    );

  // Checked right before each launch, so a sign-out or install that began while an earlier
  // instance reloaded is seen. Claims the instance by recording the attempt.
  const claimNext = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const providers = yield* registry.getProviders;
    for (const instance of yield* instanceRegistry.listInstances) {
      const refresh = instance.refreshModels;
      const provider = providers.find((entry) => entry.instanceId === instance.instanceId);
      if (
        !refresh ||
        !instance.enabled ||
        provider?.enabled !== true ||
        !provider.installed ||
        provider.auth.status !== "authenticated" ||
        now - (attempts[instance.instanceId] ?? 0) < MODEL_LIST_MAX_AGE_MS ||
        running(provider.connection?.operation) ||
        // A runtime change shows on the instance that started it; siblings share the runtime.
        providers.some(
          (entry) =>
            entry.driver === provider.driver && running(entry.connection?.runtime?.operation),
        ) ||
        (yield* installing(instance.driverKind)) ||
        (yield* activity.isBusy(instance.driverKind))
      )
        continue;
      attempts[instance.instanceId] = now;
      yield* save;
      return Option.some<DueReload>({ instance, refresh });
    }
    return Option.none<DueReload>();
  });

  // One reload at a time: each unpacks the runtime. A failure or interruption (a sign-out
  // stops the startup) counts as the attempt and never stops the remaining instances.
  const drain: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      const next = yield* claimNext;
      if (Option.isNone(next)) return;
      const { instance, refresh } = next.value;
      yield* refresh().pipe(
        Effect.andThen(registry.refreshInstance(instance.instanceId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Background model refresh failed", {
            instanceId: instance.instanceId,
            reason: failureReason(cause),
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not check model list freshness", { reason: failureReason(cause) }),
    ),
  );

  // Picker opens during a reload collapse into one pending pass.
  const wake = yield* Queue.sliding<void>(1);
  const run = Queue.take(wake).pipe(Effect.andThen(drain), Effect.forever);
  const refreshStale = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  return { refreshStale, drain, run };
});

export const layer = Layer.effect(
  ProviderModelFreshness,
  Effect.gen(function* () {
    const worker = yield* makeWorker();
    yield* worker.run.pipe(Effect.forkScoped);
    return ProviderModelFreshness.of({ refreshStale: worker.refreshStale });
  }),
);
