import type {
  ProviderKind,
  ServerProviderClientStatus,
  ServerProviderRuntimeState,
  ServerProviderStatus,
  ServerSettings,
} from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";

import type { ProviderRuntimeSnapshot } from "../providerRuntimeTypes";
import { ServerSettingsService } from "../../serverSettings";
import { ProviderClientStatusProjection } from "../Services/ProviderClientStatusProjection";
import { ProviderHealth } from "../Services/ProviderHealth";
import {
  ProviderRuntimeManager,
  type ResolvedProviderRuntime,
} from "../Services/ProviderRuntimeManager";

export function projectProviderClientStatus(input: {
  readonly status: ServerProviderStatus;
  readonly runtime: ServerProviderRuntimeState;
  readonly installationState: ServerProviderClientStatus["installationState"] | null;
}): ServerProviderClientStatus {
  const {
    runtime: _legacyRuntime,
    installationState: _legacyInstallationState,
    ...healthStatus
  } = input.status;
  const appManaged = input.runtime.source === "managed" || input.runtime.source === "bundled";
  return {
    ...healthStatus,
    ...(appManaged && healthStatus.versionAdvisory
      ? {
          versionAdvisory: {
            ...healthStatus.versionAdvisory,
            canUpdate: false,
            updateCommand: null,
            message: "Updates for this runtime are managed by Scient.",
          },
        }
      : {}),
    runtime: input.runtime,
    ...(input.installationState ? { installationState: input.installationState } : {}),
  };
}

export function makeProviderClientStatusProjection(input: {
  readonly getSettings: Effect.Effect<ServerSettings, unknown>;
  readonly getHealthStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;
  readonly refreshHealthStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;
  readonly healthChanges: Stream.Stream<ReadonlyArray<ServerProviderStatus>>;
  readonly resolveRuntime: (
    provider: ProviderKind,
    configuredExecutable?: string | null,
  ) => Effect.Effect<ResolvedProviderRuntime>;
  readonly getRuntimeSnapshot: (provider: ProviderKind) => Effect.Effect<ProviderRuntimeSnapshot>;
  readonly runtimeChanges: Stream.Stream<unknown>;
}) {
  const project = Effect.fn("ProviderClientStatusProjection.project")(function* (
    statuses: ReadonlyArray<ServerProviderStatus>,
  ) {
    const settings = yield* input.getSettings.pipe(Effect.catch(() => Effect.succeed(null)));
    return yield* Effect.forEach(
      statuses,
      (status) =>
        input.resolveRuntime(status.provider, settings?.providers[status.provider].binaryPath).pipe(
          Effect.zip(input.getRuntimeSnapshot(status.provider)),
          Effect.map(([runtime, snapshot]) =>
            projectProviderClientStatus({
              status,
              runtime: {
                source: runtime.source,
                managedVersion: runtime.managedVersion,
                canInstall: runtime.canInstall,
                canRepair: runtime.canRepair,
                canRollback: runtime.canRollback,
                canRemove: runtime.canRemove,
                message: runtime.message,
              },
              installationState: snapshot.installationState,
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
  });

  const getStatuses = input.getHealthStatuses.pipe(Effect.flatMap(project));
  const refreshStatuses = input.refreshHealthStatuses.pipe(Effect.flatMap(project));
  const streamChanges = Stream.merge(
    input.healthChanges,
    input.runtimeChanges.pipe(Stream.mapEffect(() => input.getHealthStatuses)),
  ).pipe(Stream.mapEffect(project));

  return { project, getStatuses, refreshStatuses, streamChanges };
}

export const ProviderClientStatusProjectionLive = Layer.effect(
  ProviderClientStatusProjection,
  Effect.gen(function* () {
    const providerHealth = yield* ProviderHealth;
    const providerRuntimeManager = yield* ProviderRuntimeManager;
    const serverSettings = yield* ServerSettingsService;
    return makeProviderClientStatusProjection({
      getSettings: serverSettings.getSettings,
      getHealthStatuses: providerHealth.getStatuses,
      refreshHealthStatuses: providerHealth.refresh,
      healthChanges: providerHealth.streamChanges,
      resolveRuntime: providerRuntimeManager.resolve,
      getRuntimeSnapshot: providerRuntimeManager.getSnapshot,
      runtimeChanges: providerRuntimeManager.streamChanges,
    });
  }),
);
