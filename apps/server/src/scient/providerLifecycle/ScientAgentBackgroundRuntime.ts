// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";

import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { ProviderRuntimeManager } from "./ProviderRuntimeManager.ts";

const SCIENT_AGENT = ProviderDriverKind.make("scient");
const START_DELAY = "60 seconds";
const RECHECK_INTERVAL = "1 hour";
/** After a failed background try; after the last one, the next launch tries again. */
const FAILURE_BACKOFF = ["5 minutes", "30 minutes", "2 hours"] as const;
/** Busy with other work, or stopped for the user's own change. */
const BUSY_RETRY = "5 minutes";
const MAX_FAILED_ATTEMPTS_PER_RELEASE = 5;
/** The download, the binary, the add-on it unpacks on first run, and staging. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;

/** Kept outside the runtime folder, which Remove deletes. */
const BackgroundRecord = Schema.Struct({
  /** The user removed Scient Agent or cancelled its install: install only on request. */
  userStopped: Schema.optionalKey(Schema.Boolean),
  /** An update the user cancelled; a newer release is offered again. */
  skippedVersion: Schema.optionalKey(Schema.String),
  failures: Schema.optionalKey(Schema.Struct({ version: Schema.String, count: Schema.Number })),
  firstPickRecorded: Schema.optionalKey(Schema.Boolean),
});
type BackgroundRecord = typeof BackgroundRecord.Type;
const BackgroundRecordJson = Schema.fromJsonString(BackgroundRecord);
const decodeRecord = Schema.decodeEffect(BackgroundRecordJson);
const encodeRecord = Schema.encodeEffect(BackgroundRecordJson);

export type BackgroundCheck =
  | { readonly kind: "start"; readonly action: "install" | "update"; readonly version: string }
  | { readonly kind: "wait"; readonly reason: string };

/** What, if anything, Scient may get ready on its own for this instance. */
export function backgroundRuntimeAction(
  provider: ServerProvider,
  record: BackgroundRecord,
): BackgroundCheck {
  const runtime = provider.connection?.runtime;
  if (!provider.enabled || !runtime) return { kind: "wait", reason: "unavailable" };
  const action: ProviderManagedRuntimeAction | undefined =
    runtime.source === "missing" && runtime.actions.includes("install")
      ? "install"
      : runtime.source === "scient_managed" && runtime.actions.includes("update")
        ? "update"
        : undefined;
  const version =
    action === "update"
      ? runtime.availableManagedVersion
      : (runtime.availableManagedVersion ?? runtime.qualifiedVersion);
  if (action === undefined || !version) return { kind: "wait", reason: "nothing-to-do" };
  if (action === "install" && record.userStopped) return { kind: "wait", reason: "user-stopped" };
  if (action === "update" && record.skippedVersion === version)
    return { kind: "wait", reason: "user-stopped" };
  if (
    record.failures?.version === version &&
    record.failures.count >= MAX_FAILED_ATTEMPTS_PER_RELEASE
  )
    return { kind: "wait", reason: "gave-up" };
  return { kind: "start", action, version };
}

/** True when the OS says the connection is metered. Unknown counts as not metered. */
export function parseMeteredOutput(platform: NodeJS.Platform, output: string): boolean {
  if (platform === "win32") return /^(Fixed|Variable)$/mu.test(output.trim());
  // `nmcli -t -f GENERAL.STATE,GENERAL.METERED device show`: pairs per device.
  const lines = output.split(/\r?\n/u);
  return lines.some(
    (line, index) =>
      /^GENERAL\.STATE:100\b/u.test(line) && /^GENERAL\.METERED:yes/u.test(lines[index + 1] ?? ""),
  );
}

const WINDOWS_COST_SCRIPT =
  "[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];" +
  "$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();" +
  "if($p){$p.GetConnectionCost().NetworkCostType}";

export class ScientAgentBackgroundRuntime extends Context.Service<
  ScientAgentBackgroundRuntime,
  {
    /** The user picked Scient Agent: records once per installation how ready it was. */
    readonly observePick: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("t3/scient/providerLifecycle/ScientAgentBackgroundRuntime") {}

export const make = Effect.fn("ScientAgentBackgroundRuntime.make")(function* () {
  const config = yield* ServerConfig;
  const registry = yield* ProviderRegistry;
  const manager = yield* ProviderRuntimeManager;
  const processes = yield* ProcessRunner.ProcessRunner;
  const analytics = yield* AnalyticsService;
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recordPath = path.join(
    config.baseDir,
    "provider-runtimes",
    ".background",
    "scient-agent.json",
  );

  const readRecord = fs.readFileString(recordPath).pipe(
    Effect.flatMap(decodeRecord),
    Effect.orElseSucceed((): BackgroundRecord => ({})),
  );
  const recordLock = yield* Semaphore.make(1);
  /** Applies a change under the lock and returns the record from before it. */
  const updateRecord = (change: (record: BackgroundRecord) => BackgroundRecord) =>
    recordLock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* readRecord;
        const text = yield* encodeRecord(change(record));
        yield* fs.makeDirectory(path.dirname(recordPath), { recursive: true });
        yield* fs.writeFileString(recordPath, text);
        return record;
      }),
    );
  const changeRecord = (change: (record: BackgroundRecord) => BackgroundRecord) =>
    updateRecord(change).pipe(Effect.ignore);

  const freeBytes = Effect.promise(() =>
    NodeFSP.statfs(config.baseDir).then(
      (stats) => stats.bavail * stats.bsize,
      () => Number.POSITIVE_INFINITY,
    ),
  );

  // macOS keeps Low Data Mode out of Node's reach, so it counts as unmetered.
  const metered =
    platform === "win32" || platform === "linux"
      ? processes
          .run(
            platform === "win32"
              ? {
                  command: "powershell.exe",
                  args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COST_SCRIPT],
                  timeout: "10 seconds",
                }
              : {
                  command: "nmcli",
                  args: ["-t", "-f", "GENERAL.STATE,GENERAL.METERED", "device", "show"],
                  timeout: "10 seconds",
                },
          )
          .pipe(
            Effect.map((output) => parseMeteredOutput(platform, output.stdout)),
            Effect.orElseSucceed(() => false),
          )
      : Effect.succeed(false);

  const scientAgent = registry.getProviders.pipe(
    Effect.map((providers) =>
      providers.find(
        (provider) => provider.driver === SCIENT_AGENT && provider.connection?.runtime,
      ),
    ),
  );
  const anyRuntimeBusy = registry.getProviders.pipe(
    Effect.map((providers) =>
      providers.some((provider) => {
        const operation = provider.connection?.runtime?.operation;
        return (
          operation !== null &&
          operation !== undefined &&
          operation.finishedAt === null &&
          operation.status !== "failed" &&
          operation.status !== "cancelled" &&
          operation.status !== "succeeded"
        );
      }),
    ),
  );

  type Pass = "ready" | "failed" | "busy" | "waiting";
  const tryOnce = Effect.fn("ScientAgentBackgroundRuntime.tryOnce")(
    function* (): Effect.fn.Return<Pass> {
      const provider = yield* scientAgent;
      if (!provider) return "waiting";
      const record = yield* readRecord;
      const check = backgroundRuntimeAction(provider, record);
      if (check.kind === "wait") return "waiting";
      if (yield* anyRuntimeBusy) return "busy";
      if ((yield* freeBytes) < MIN_FREE_BYTES) return "waiting";
      if (yield* metered) return "waiting";
      const planned = yield* manager
        .plan({ instanceId: provider.instanceId, action: check.action })
        .pipe(Effect.option);
      if (Option.isNone(planned)) return "waiting";
      const failures = record.failures?.version === check.version ? record.failures.count : 0;
      const outcome = yield* manager
        .startInBackground({
          instanceId: provider.instanceId,
          action: check.action,
          catalogRevision: planned.value.catalogRevision,
          attempt: failures + 1,
        })
        .pipe(Effect.orElseSucceed(() => "busy" as const));
      switch (outcome) {
        case "succeeded":
          yield* changeRecord(({ failures: _failures, ...rest }) => rest);
          return "ready";
        case "failed":
          yield* changeRecord((current) => ({
            ...current,
            failures: { version: check.version, count: failures + 1 },
          }));
          return "failed";
        case "cancelled":
          yield* changeRecord((current) =>
            check.action === "install"
              ? { ...current, userStopped: true }
              : { ...current, skippedVersion: check.version },
          );
          return "waiting";
        case "yielded":
        case "busy":
          return "busy";
        case "interrupted":
          return yield* Effect.interrupt;
      }
    },
  );

  // A newer release wakes the loop at once, so no update notice shows first.
  const offeredVersion = (provider: ServerProvider | undefined) =>
    provider?.connection?.runtime?.availableManagedVersion ?? null;
  const lastOfferRef = yield* Ref.make<string | null>(null);
  const newOffer = registry.streamChanges.pipe(
    Stream.map((providers) =>
      offeredVersion(providers.find((provider) => provider.driver === SCIENT_AGENT)),
    ),
    Stream.filterEffect((offer) =>
      Ref.get(lastOfferRef).pipe(Effect.map((last) => offer !== null && offer !== last)),
    ),
    Stream.runHead,
  );

  const loop = Effect.gen(function* () {
    yield* Effect.sleep(START_DELAY);
    let failedInARow = 0;
    while (true) {
      yield* Ref.set(lastOfferRef, offeredVersion(yield* scientAgent));
      const pass = yield* tryOnce();
      if (pass === "failed") {
        const delay = FAILURE_BACKOFF[failedInARow];
        failedInARow += 1;
        if (delay === undefined) return;
        yield* Effect.sleep(delay);
        continue;
      }
      failedInARow = 0;
      if (pass === "busy") {
        yield* Effect.sleep(BUSY_RETRY);
        continue;
      }
      yield* Effect.race(Effect.sleep(RECHECK_INTERVAL), newOffer);
    }
  });

  // Remove, or Cancel of an install, by the user stays until the user installs again.
  const handled = yield* Ref.make<string | null>(null);
  const followUserChanges = registry.streamChanges.pipe(
    Stream.runForEach((providers) =>
      Effect.gen(function* () {
        const operation = providers.find((provider) => provider.driver === SCIENT_AGENT)?.connection
          ?.runtime?.operation;
        if (!operation || operation.background || operation.finishedAt === null) return;
        if ((yield* Ref.getAndSet(handled, operation.operationId)) === operation.operationId)
          return;
        if (
          (operation.action === "remove" && operation.status === "succeeded") ||
          (operation.action === "install" && operation.status === "cancelled")
        )
          yield* changeRecord((current) => ({ ...current, userStopped: true }));
        else if (operation.action !== "remove" && operation.status === "succeeded")
          yield* changeRecord(
            ({ userStopped: _stopped, skippedVersion: _skipped, ...rest }) => rest,
          );
      }),
    ),
  );

  if (config.mode === "desktop") {
    yield* loop.pipe(Effect.forkScoped);
    yield* followUserChanges.pipe(Effect.forkScoped);
  }

  const observePick = Effect.fn("ScientAgentBackgroundRuntime.observePick")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const provider = (yield* registry.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (provider?.driver !== SCIENT_AGENT) return;
    const before = yield* updateRecord((record) => ({ ...record, firstPickRecorded: true })).pipe(
      Effect.option,
    );
    const recorded = Option.isNone(before) || before.value.firstPickRecorded === true;
    if (recorded) return;
    yield* analytics.record("provider.runtime.first_pick", {
      provider: provider.driver,
      ...firstPickState(provider),
    });
  });

  return ScientAgentBackgroundRuntime.of({ observePick });
});

/** How ready a provider was when the user first picked it. */
export function firstPickState(provider: ServerProvider): {
  readonly state: "ready" | "in_progress" | "failed" | "not_started";
  readonly percent?: number;
} {
  const runtime = provider.connection?.runtime;
  const operation = runtime?.operation;
  if (provider.installed && runtime?.source !== "missing") return { state: "ready" };
  if (operation && operation.finishedAt === null) {
    const percent =
      operation.downloadedBytes !== undefined && operation.totalBytes !== undefined
        ? Math.floor((operation.downloadedBytes / operation.totalBytes) * 100)
        : 0;
    return { state: "in_progress", percent };
  }
  if (operation?.status === "failed") return { state: "failed" };
  return { state: "not_started" };
}

export const layer = Layer.effect(ScientAgentBackgroundRuntime, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
