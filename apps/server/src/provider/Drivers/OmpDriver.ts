import { ompProcessEnvironment } from "../omp/OmpEnvironment.ts";
import {
  OmpSettings,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpManagedRuntimeResolution } from "../../scient/providerLifecycle/OmpManagedRuntimeActions.ts";
import { makeOmpCustomModelsClientFactory } from "../omp/OmpCustomModels.ts";
import { sweepStaleOmpExtensionFiles } from "../omp/OmpExtensionBootstrap.ts";
import type { OmpExecutableGate } from "../omp/OmpExecutableGate.ts";
import { ompTarget } from "../omp/OmpTarget.ts";
import { customModelDiscoverySnapshot } from "../../customModelCapabilities.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { checkOmpProviderStatus, makePendingOmpProvider } from "../Layers/OmpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  resolveOmpInstallation,
  resolveOmpLatestVersion,
  shapeOmpVersionAdvisory,
} from "../omp/OmpMaintenance.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ompTarget.driverKind;
const decodeSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv =
  | BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OmpExecutableGate
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
      const home = effectiveConfig.homePath.trim();
      const profile = effectiveConfig.profile.trim();
      if (home.length > 0 && profile.length > 0) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Choose either an Oh My Pi home or a named profile, not both.",
        });
      }
      const platform = yield* HostProcessPlatform;
      const processEnv = ompProcessEnvironment({
        instanceEnvironment: environment,
        homePath: home,
        profile,
        platform,
      });
      // A crashed server never removed its extension files, and a bootstrap
      // it left unread still holds credentials. Files this server wrote are
      // newer than its start, so creating an instance later keeps them.
      yield* sweepStaleOmpExtensionFiles({
        target: ompTarget,
        stateDir: serverConfig.stateDir,
        startedAt: performance.timeOrigin,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const makeRpcClient = yield* makeOmpCustomModelsClientFactory(
        ompTarget,
        serverSettings,
        instanceId,
        serverConfig.stateDir,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not prepare Oh My Pi custom models.",
              cause,
            }),
        ),
      );
      const managedRuntime = yield* makeOmpManagedRuntimeResolution({
        settings: effectiveConfig,
        baseDir: serverConfig.baseDir,
        environment: processEnv,
        spawner,
        managedInstallationAllowed: serverConfig.mode === "desktop",
      });
      const launchConfig = {
        ...effectiveConfig,
        binaryPath: managedRuntime.effectiveBinaryPath,
      } satisfies OmpSettings;
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
      const adapter = yield* makeOmpAdapter({
        target: ompTarget,
        binaryPath: launchConfig.binaryPath,
        providerInstanceId: instanceId,
        stateDir: serverConfig.stateDir,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnv,
        makeProcess: makeRpcClient,
        homePath: home || undefined,
        profile: profile || undefined,
        // The shared native provider event log, written from the adapter so a
        // native agent's raw protocol frames stay diagnosable like every other
        // provider's.
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const textGeneration = yield* makeOmpTextGeneration(
        ompTarget,
        launchConfig,
        processEnv,
        makeRpcClient,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const mapSnapshotSettings = (settings: ServerSettings) => ({
        provider: effectiveConfig,
        enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
        customModels: customModelDiscoverySnapshot(settings.customModels.connections, instanceId),
      });
      const snapshotSettings = {
        getSettings: serverSettings.getSettings.pipe(Effect.map(mapSnapshotSettings)),
        streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSnapshotSettings)),
      };
      // Scient never runs Oh My Pi's own updater. System installs get an
      // advisory with the command to run by hand; managed installs update
      // through the managed-runtime pipeline.
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const resolveMaintenance = () => Effect.succeed(maintenance);
      const managedAvailable = managedRuntime.summary.actions.includes("install");
      const resolveVersionAdvisory = (
        currentSnapshot: ServerProvider,
        checksEnabled: boolean,
      ): Effect.Effect<ServerProviderVersionAdvisory> =>
        Effect.gen(function* () {
          const installation = managedRuntime.usesManagedPath
            ? null
            : yield* resolveOmpInstallation({
                binaryPath: launchConfig.binaryPath,
                env: processEnv,
                platform,
              });
          const shouldCheck =
            checksEnabled &&
            currentSnapshot.enabled &&
            currentSnapshot.installed &&
            Boolean(currentSnapshot.version);
          const latestVersion =
            installation && shouldCheck ? yield* resolveOmpLatestVersion(installation) : null;
          return shapeOmpVersionAdvisory({
            currentVersion: currentSnapshot.version,
            latestVersion,
            installation,
            managedAvailable,
            checkedAt: shouldCheck
              ? DateTime.formatIso(yield* DateTime.now)
              : currentSnapshot.checkedAt,
          });
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OmpSettings> & {
          readonly customModels: ReturnType<typeof customModelDiscoverySnapshot>;
        }
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOmpProvider(ompTarget, settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkOmpProviderStatus(
          ompTarget,
          launchConfig,
          processEnv,
          makeRpcClient,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.map(stamp),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveVersionAdvisory(
            currentSnapshot,
            settings.enableProviderUpdateChecks !== false,
          ).pipe(
            Effect.flatMap((versionAdvisory) =>
              publishSnapshot({ ...currentSnapshot, versionAdvisory }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Oh My Pi snapshot: ${cause.message ?? String(cause)}`,
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
          checkOmpProviderStatus(ompTarget, launchConfig, processEnv, makeRpcClient, cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.map(stamp),
          ),
        adapter,
        textGeneration,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
