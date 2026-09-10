import {
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";

import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { customModelDiscoverySnapshot } from "../../customModelCapabilities.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { makePiManagedRuntimeResolution } from "../../scient/providerLifecycle/PiManagedRuntimeActions.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { makePiCustomModelsClientFactory } from "../pi/PiCustomModels.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { piMaintenance } from "../piDroidMaintenance.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const decodeSettings = Schema.decodeSync(PiSettings);

export type PiDriverEnv =
  | BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
      const managedRuntime = yield* makePiManagedRuntimeResolution({
        settings: config,
        baseDir: serverConfig.baseDir,
        environment: processEnv,
        spawner,
        managedInstallationAllowed: serverConfig.mode === "desktop",
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: managedRuntime.effectiveBinaryPath,
      } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...stampIdentity(snapshot),
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: managedRuntime.summary,
        },
      });
      const adapter = yield* makePiAdapter({
        binaryPath: effectiveConfig.binaryPath,
        providerInstanceId: instanceId,
        stateDir: serverConfig.stateDir,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnv,
        makeRpcClient,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const textGeneration = yield* makePiTextGeneration(
        effectiveConfig,
        processEnv,
        makeRpcClient,
      );
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        (managedRuntime.usesManagedPath
          ? Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER_KIND,
                packageName: null,
              }),
            )
          : resolveProviderMaintenanceCapabilitiesEffect(piMaintenance, {
              binaryPath: effectiveConfig.binaryPath,
              env: processEnv,
            })
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );
      const mapSettings = (settings: ServerSettings) => ({
        provider: effectiveConfig,
        enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
        customModels: customModelDiscoverySnapshot(settings.customModels.connections, instanceId),
      });
      const source = {
        getSettings: serverSettings.getSettings.pipe(Effect.map(mapSettings)),
        streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSettings)),
      };
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<PiSettings> & {
          customModels: ReturnType<typeof customModelDiscoverySnapshot>;
        }
      >({
        resolveMaintenance,
        getSettings: source.getSettings,
        streamSettings: source.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingPiProvider(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkPiProviderStatus(effectiveConfig, processEnv, makeRpcClient).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.map(stamp),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, capabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${String(cause)}`,
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
        snapshotForCwd: (cwd) =>
          checkPiProviderStatus(effectiveConfig, processEnv, makeRpcClient, cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.map(stamp),
          ),
        adapter,
        textGeneration,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
