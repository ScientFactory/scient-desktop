/**
 * PiDriver — configured Pi provider instances, composing the
 * orchestrator-v2 adapter (`PiAdapterV2`), the snapshot/probe layer
 * (`PiProvider`), and Pi-backed text generation.
 *
 * Pi keeps native sessions/settings/auth in its configured state directory;
 * continuation authority is conservatively scoped to the configured instance.
 */
import {
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerSettings as ServerSettingsData,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { customModelDiscoverySnapshot } from "../../customModelCapabilities.ts";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import * as Crypto from "effect/Crypto";
import {
  makePiAdapterV2,
  piContinuationRequestsIfProvided,
  type PiAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/PiAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
// SCIENT-FORK:START — instance-owned runtime and custom-model integration.
import { makePiCustomModelsClientFactory } from "../pi/PiCustomModels.ts";
import { makePiCustomModelsConnectionFactory } from "../pi/PiCustomModelsConnection.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { makePiManagedRuntimeResolution } from "../../scient/providerLifecycle/PiManagedRuntimeActions.ts";
import { expandHomePath } from "../../pathExpansion.ts";
// SCIENT-FORK:END
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  enrichPiSnapshot,
} from "../PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@earendil-works/pi-coding-agent",
  // Pi's updater covers its own installer and npm, pnpm, yarn, and bun globals.
  nativeUpdate: { args: ["update", "--self"] },
});

export type PiDriverEnv =
  | PiAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  // SCIENT-FORK:START — native identity and custom-model bootstrap ownership.
  | Crypto.Crypto
  // SCIENT-FORK:END
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly runtime: NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    connection: { methods: [], canDisconnect: false, operation: null, runtime: input.runtime },
  });

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const { cwd } = serverConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      // SCIENT-FORK:START — use one resolved executable for native V2 sessions,
      // one-shot text generation, retained library clients, and status probes.
      const managedRuntime = yield* makePiManagedRuntimeResolution({
        settings: config,
        baseDir: serverConfig.baseDir,
        environment: processEnv,
        spawner,
        managedInstallationAllowed: serverConfig.mode === "desktop",
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        runtime: managedRuntime.summary,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(managedRuntime.effectiveBinaryPath),
      } satisfies PiSettings;
      // SCIENT-FORK:END
      // SCIENT-FORK:START — native V2 sessions and one-shot text generation use
      // the same instance-scoped custom-model authority and extension bootstrap.
      // The typed factory also supplies the retained library compatibility seam.
      const makeRpcClient = yield* makePiCustomModelsClientFactory(
        serverSettings,
        instanceId,
        serverConfig.stateDir,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not prepare custom models.",
              cause,
            }),
        ),
      );
      // SCIENT-FORK:END
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const makeConnection = yield* makePiCustomModelsConnectionFactory(
        serverSettings,
        instanceId,
        serverConfig.stateDir,
      );
      const orchestrationAdapter = makePiAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnv,
        spawner,
        fileSystem,
        path: yield* Path.Path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig,
        makeConnection,
        continuationRequests: yield* piContinuationRequestsIfProvided,
      });
      const textGeneration = yield* makePiTextGeneration(
        effectiveConfig,
        processEnv,
        makeRpcClient,
      );

      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        processEnv,
        cwd,
        makeRpcClient,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const mapSettings = (settings: ServerSettingsData) => ({
        provider: effectiveConfig,
        enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
        customModels: customModelDiscoverySnapshot(settings.customModels.connections, instanceId),
      });
      const snapshotSettings = {
        getSettings: serverSettings.getSettings.pipe(Effect.map(mapSettings)),
        streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSettings)),
      };
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<PiSettings> & {
          customModels: ReturnType<typeof customModelDiscoverySnapshot>;
        }
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichPiSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Pi snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
        // SCIENT-FORK:START — workspace probes and managed runtime actions belong to this instance.
        snapshotForCwd: (cwd) =>
          checkPiProviderStatus(effectiveConfig, processEnv, cwd, makeRpcClient).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.map(stampIdentity),
          ),
        managedRuntimeActions: managedRuntime.actions,
        // SCIENT-FORK:END
      } satisfies ProviderInstance;
    }),
};
