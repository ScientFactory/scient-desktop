import { ProviderDriverKind } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeMuseTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeMuseAdapterV2 } from "./adapter.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkMuseProviderStatus, makePendingMuseProvider } from "./status.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { enrichMuseSnapshot, latestMuseVersion, museMaintenance } from "./maintenance.ts";
import { makeMuseEnvironment } from "./sdk.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
// SCIENT-FORK:START — type the optional host prompt-composition callback.
import type { RuntimeInstructionsInput } from "@t3tools/provider-core/server/runtimeInstructions";
// SCIENT-FORK:END
// SCIENT-FORK:START — type the optional host runtime-composition hook.
import type { ServerProvider } from "@t3tools/contracts";
import type * as Scope from "effect/Scope";
import type { ProviderDriverCreateInput } from "@t3tools/provider-core/server/driver";
// SCIENT-FORK:END

const DRIVER_KIND = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

export type MuseDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

// SCIENT-FORK:START — give the host optional runtime-copy and runtime-composition seams
// without changing the driver SPI or the package's single MSP implementation.
/** Host-owned runtime selection and instance composition for one Muse instance. */
export interface MuseRuntimeResolution<Requirements = never, Extension extends object = {}> {
  /** The executable every status probe, session and generation of this instance launches. */
  readonly binaryPath: string;
  readonly decorateSnapshot: (snapshot: ServerProvider) => ServerProvider;
  readonly composeInstance: (
    instance: ProviderInstance,
  ) => Effect.Effect<ProviderInstance & Extension, ProviderDriverError, Requirements | Scope.Scope>;
}

export interface MuseDriverOptions<Requirements = never, Extension extends object = {}> {
  /** Host-owned runtime text; absent means the package's generic T3 default. */
  readonly runtimeInstructions?: (input: RuntimeInstructionsInput) => string;
  /** Host-owned runtime selection; receives the environment Muse is launched with. */
  readonly resolveRuntime?: (
    input: ProviderDriverCreateInput<MuseSettings> & {
      readonly processEnvironment: NodeJS.ProcessEnv;
    },
  ) => Effect.Effect<
    MuseRuntimeResolution<Requirements, Extension>,
    ProviderDriverError,
    Requirements | Scope.Scope
  >;
}

export interface MuseDriverFactory<
  Requirements = never,
  Extension extends object = {},
> extends ProviderDriver<MuseSettings, MuseDriverEnv | Requirements> {
  readonly create: (
    input: ProviderDriverCreateInput<MuseSettings>,
  ) => Effect.Effect<
    ProviderInstance & Extension,
    ProviderDriverError,
    MuseDriverEnv | Requirements | Scope.Scope
  >;
}
// SCIENT-FORK:END

// SCIENT-FORK:START — expose an optional app-copy factory while retaining one generic driver.
export const makeMuseDriver = <Requirements = never, Extension extends object = {}>(
  options: MuseDriverOptions<Requirements, Extension> = {},
): MuseDriverFactory<Requirements, Extension> => ({
  // SCIENT-FORK:END
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeMuseSettings({}),
  // SCIENT-FORK:START — the runtime hook receives the complete create input.
  create: (input) =>
    Effect.gen(function* () {
      const { instanceId, displayName, accentColor, environment, enabled, config } = input;
      // SCIENT-FORK:END
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const host = yield* ProviderHost.ProviderHost;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const { cwd } = host.paths;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const hostEnvironment = yield* HostProcess.Environment;
      // Drop an inherited META_API_KEY so Muse uses its login; an instance value still wins.
      const processEnvironment = yield* mergeProviderInstanceEnvironment(
        environment,
        makeMuseEnvironment(hostEnvironment),
      );
      // SCIENT-FORK:START — a host may select the executable this instance launches.
      const runtime = options.resolveRuntime
        ? yield* options.resolveRuntime({ ...input, processEnvironment })
        : undefined;
      // SCIENT-FORK:END
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath:
          // SCIENT-FORK:START — host-selected executable.
          runtime?.binaryPath ??
          // SCIENT-FORK:END
          expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      } satisfies MuseSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const identify = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      // SCIENT-FORK:START — host lifecycle presentation on every published snapshot.
      const stampIdentity = (draft: Parameters<typeof identify>[0]) =>
        runtime ? runtime.decorateSnapshot(identify(draft)) : identify(draft);
      // SCIENT-FORK:END
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnvironment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        Effect.gen(function* () {
          const capabilities = yield* resolveInstallation(options);
          // The maintenance runner requests fresh capabilities around an explicit update
          // and needs the native target version to verify that the command actually upgraded.
          const latestVersion = options?.fresh
            ? yield* latestMuseVersion(processEnvironment, { fresh: true }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              )
            : undefined;
          return latestVersion !== undefined ? { ...capabilities, latestVersion } : capabilities;
        });
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingMuseProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkMuseProviderStatus(effectiveConfig, processEnvironment, cwd).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichMuseSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                environment: processEnvironment,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Muse Code snapshot.",
              cause,
            }),
        ),
      );
      const modelCatalog = snapshot.getSnapshot.pipe(Effect.map((current) => current.models));
      const orchestrationAdapter = yield* makeMuseAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnvironment,
        modelCatalog,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        continuationRequests,
        // SCIENT-FORK:START — retain the one provider driver and pass host copy at adapter creation.
        ...(options.runtimeInstructions === undefined
          ? {}
          : { runtimeInstructions: options.runtimeInstructions }),
        // SCIENT-FORK:END
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, {
        environment: processEnvironment,
        modelCatalog,
      });
      const instance = {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
      // SCIENT-FORK:START — host-owned instance composition.
      return runtime
        ? yield* runtime.composeInstance(instance)
        : (instance as ProviderInstance & Extension);
      // SCIENT-FORK:END
    }),
  // SCIENT-FORK:START — close the optional host-copy driver factory.
});
// SCIENT-FORK:END

/** @public Upstream-compatible default for hosts without an app-owned prompt composition. */
// SCIENT-FORK:START — instantiate the package default through the same host-copy factory.
export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = makeMuseDriver();
// SCIENT-FORK:END
