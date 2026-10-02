import { ScientAgentSettings, type ServerProvider, type ServerSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { customModelDiscoverySnapshot } from "../../customModelCapabilities.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { checkOmpProviderStatus, makePendingOmpProvider } from "../Layers/OmpProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeOmpCustomModelsClientFactory } from "../omp/OmpCustomModels.ts";
import type { OmpExecutableGate } from "../omp/OmpExecutableGate.ts";
import { sweepStaleOmpExtensionFiles } from "../omp/OmpExtensionBootstrap.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { scientAgentProcessEnvironment, scientAgentTarget } from "../scient/ScientAgentTarget.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = scientAgentTarget.driverKind;
const decodeSettings = Schema.decodeSync(ScientAgentSettings);

export type ScientAgentDriverEnv =
  | BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | OmpExecutableGate
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Scient Agent, Scient's own agent. It runs through the same adapter, RPC
 * client and Scient tool bridge as Oh My Pi, as a separate product: this
 * driver gives it its own executable, a config root inside Scient's state
 * directory, and its own session and extension folders. It never reads an
 * Oh My Pi home, and an Oh My Pi conversation cannot resume in it.
 *
 * One instance for now, and no managed installation: the executable is the
 * configured path until Scient Agent publishes releases.
 */
export const ScientAgentDriver: ProviderDriver<ScientAgentSettings, ScientAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: scientAgentTarget.displayName, supportsMultipleInstances: false },
  configSchema: ScientAgentSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const failure = (detail: string) => (cause: { readonly message?: string }) =>
        new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail, cause });
      const effectiveConfig = { ...config, enabled } satisfies ScientAgentSettings;
      // Everything the agent owns (credentials, configuration, logs, caches,
      // its native addon) lives here, per instance.
      const root = path.join(
        serverConfig.stateDir,
        scientAgentTarget.stateNamespace,
        "instances",
        instanceId,
      );
      yield* fs
        .makeDirectory(root, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failure("Could not create the Scient Agent state directory.")));
      const processEnv = scientAgentProcessEnvironment({
        instanceEnvironment: environment,
        root,
        platform,
      });
      // A crashed server never removed its extension files, and a bootstrap
      // it left unread still holds credentials.
      yield* sweepStaleOmpExtensionFiles({
        target: scientAgentTarget,
        stateDir: serverConfig.stateDir,
        startedAt: performance.timeOrigin,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const makeRpcClient = yield* makeOmpCustomModelsClientFactory(
        scientAgentTarget,
        serverSettings,
        instanceId,
        serverConfig.stateDir,
      ).pipe(Effect.mapError(failure("Could not prepare Scient Agent custom models.")));
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp: (snapshot: ServerProviderDraft) => ServerProvider = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makeOmpAdapter({
        target: scientAgentTarget,
        binaryPath: effectiveConfig.binaryPath,
        providerInstanceId: instanceId,
        stateDir: serverConfig.stateDir,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnv,
        makeProcess: makeRpcClient,
        // The resume identity: a cursor written under another root is refused.
        homePath: root,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const textGeneration = yield* makeOmpTextGeneration(
        scientAgentTarget,
        effectiveConfig,
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
      const checkProvider = (cwd?: string) =>
        checkOmpProviderStatus(
          scientAgentTarget,
          effectiveConfig,
          processEnv,
          makeRpcClient,
          cwd,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.map(stamp),
        );
      // Scient Agent has no updater of its own; Scient replaces the executable.
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ScientAgentSettings> & {
          readonly customModels: ReturnType<typeof customModelDiscoverySnapshot>;
        }
      >({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: serverSettings.getSettings.pipe(Effect.map(mapSnapshotSettings)),
        streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSnapshotSettings)),
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOmpProvider(scientAgentTarget, settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkProvider(),
      }).pipe(
        Effect.mapError((cause) =>
          failure(`Failed to build the Scient Agent snapshot: ${cause.message ?? String(cause)}`)(
            cause,
          ),
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
        snapshotForCwd: checkProvider,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
