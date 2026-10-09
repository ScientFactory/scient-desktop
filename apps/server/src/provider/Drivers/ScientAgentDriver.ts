import { ScientAgentSettings, type ServerProvider, type ServerSettings } from "@t3tools/contracts";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import type { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { customModelDiscoverySnapshot } from "../../customModelCapabilities.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderConnectionActionError } from "../../scient/providerLifecycle/ProviderConnectionActions.ts";
import {
  makeScientAgentConnectionActions,
  readScientAgentAccounts,
} from "../../scient/providerLifecycle/ScientAgentConnectionActions.ts";
import { makeScientAgentManagedRuntimeResolution } from "../../scient/providerLifecycle/ScientAgentManagedRuntimeActions.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapterV2 } from "../../orchestration-v2/Adapters/OmpAdapterV2.ts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/continuationRequests";
import {
  checkOmpProviderStatus,
  makePendingOmpProvider,
  type OmpProviderStatus,
} from "../OmpProvider.ts";
import { ProviderEventLoggers } from "../ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeOmpCustomModelsClientFactory } from "../omp/OmpCustomModels.ts";
import type { OmpExecutableGate } from "../omp/OmpExecutableGate.ts";
import { sweepStaleOmpExtensionFiles } from "../omp/OmpExtensionBootstrap.ts";
import { OMP_ISOLATED_ARGS } from "../omp/OmpRpcProcess.ts";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { scientAgentProcessEnvironment, scientAgentTarget } from "../scient/ScientAgentTarget.ts";
import type { ScientProviderDriver, ScientProviderInstance } from "../ScientProviderInstance.ts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";

const DRIVER_KIND = scientAgentTarget.driverKind;
const decodeSettings = Schema.decodeSync(ScientAgentSettings);

export type ScientAgentDriverEnv =
  | ProviderHost
  | BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | OmpExecutableGate
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Scient Agent, ScientFactory's agent. It runs through the same adapter, RPC
 * client and Scient tool bridge as Oh My Pi, as a separate product: this
 * driver gives it its own executable, a config root inside Scient's state
 * directory, and its own session and extension folders. It never reads an
 * Oh My Pi home, and an Oh My Pi conversation cannot resume in it.
 *
 * One instance for now. Managed installation uses qualified ScientFactory
 * releases; a configured executable remains usable before the first release.
 */
export const ScientAgentDriver: ScientProviderDriver<ScientAgentSettings, ScientAgentDriverEnv> = {
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
      const managedRuntime = yield* makeScientAgentManagedRuntimeResolution({
        settings: effectiveConfig,
        baseDir: serverConfig.baseDir,
        environment: processEnv,
        spawner,
        managedInstallationAllowed: serverConfig.mode === "desktop",
      });
      const launchConfig = {
        ...effectiveConfig,
        binaryPath: managedRuntime.effectiveBinaryPath,
      } satisfies ScientAgentSettings;
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
      // The agent signs in to several model accounts and reports its own list.
      // An agent build that does not describe its entries offers no sign-in.
      // The list itself says sign-in is available: `methods` stays empty, so a
      // client that predates the account method still decodes this provider.
      const stamp = (
        snapshot: ServerProviderDraft & Pick<OmpProviderStatus, "accounts">,
      ): ServerProvider => {
        const { accounts, ...draft } = snapshot;
        return {
          ...stampIdentity(draft),
          connection: {
            methods: [],
            canDisconnect: false,
            operation: null,
            runtime: managedRuntime.summary,
            ...(accounts ? { accounts } : {}),
          },
        };
      };
      const orchestrationAdapter = makeOmpAdapterV2({
        target: scientAgentTarget,
        instanceId,
        settings: launchConfig,
        homePath: root,
        environment: processEnv,
        spawner,
        fileSystem: fs,
        path,
        crypto: yield* Crypto.Crypto,
        serverConfig,
        makeProcess: makeRpcClient,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        idAllocator: yield* IdAllocatorV2,
        continuations: yield* ProviderContinuationRequests,
      });
      const textGeneration = yield* makeOmpTextGeneration(
        scientAgentTarget,
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
      const checkProvider = (cwd?: string) =>
        checkOmpProviderStatus(
          scientAgentTarget,
          launchConfig,
          processEnv,
          makeRpcClient,
          cwd,
          readScientAgentAccounts,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.map(stamp),
        );
      // One isolated agent process per sign-in or sign-out, in the caller's scope.
      const openSignIn = makeRpcClient({
        target: scientAgentTarget,
        command: launchConfig.binaryPath,
        env: processEnv,
        extraArgs: OMP_ISOLATED_ARGS,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.map((client) => ({
          events: client.events,
          command: client.command,
          extensionUiResponse: client.extensionUiResponse,
          redact: client.redaction.text,
        })),
        Effect.mapError(
          (cause) =>
            new ProviderConnectionActionError({
              message: "Scient could not start Scient Agent to manage the account.",
              cause,
            }),
        ),
      );
      // Account removal settles this exact instance's native conversations;
      // other instances own independent account roots and remain live.
      const connectionActions = makeScientAgentConnectionActions({ open: openSignIn });
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
        orchestrationAdapter,
        textGeneration,
        connectionActions,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ScientProviderInstance;
    }),
};
