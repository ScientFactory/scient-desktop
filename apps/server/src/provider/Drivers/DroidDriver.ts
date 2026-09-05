import { DroidSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDroidTextGeneration } from "../../textGeneration/DroidTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDroidAdapter } from "../Layers/DroidAdapter.ts";
import {
  buildInitialDroidProviderSnapshot,
  checkDroidProviderStatusWithCapabilities,
  enrichDroidSnapshot,
} from "../Layers/DroidProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  hasDroidApiKeyEnvironment,
  type DroidAccountCapabilities,
} from "../acp/DroidAcpSupport.ts";
import {
  droidProcessEnvironment,
  makeDroidConnectionActions,
  withDroidSessionShutdown,
} from "../../scient/providerLifecycle/DroidConnectionActions.ts";
import { makeDroidManagedRuntimeResolution } from "../../scient/providerLifecycle/DroidManagedRuntimeActions.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);

const DRIVER_KIND = ProviderDriverKind.make("droid");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type DroidDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly runtime: NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;
    readonly assistedAccountActionsAllowed: boolean;
  }) =>
  (
    snapshot: ServerProviderDraft,
    accountCapabilities: DroidAccountCapabilities = { devicePairing: false, logout: false },
  ): ServerProvider => {
    const connectionMethods =
      input.assistedAccountActionsAllowed &&
      accountCapabilities.devicePairing &&
      snapshot.auth.required !== false
        ? (["droid_device_pairing"] as const)
        : [];
    return {
      ...snapshot,
      instanceId: input.instanceId,
      driver: DRIVER_KIND,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: input.continuationGroupKey },
      connection: {
        methods: connectionMethods,
        canDisconnect:
          input.assistedAccountActionsAllowed &&
          accountCapabilities.logout &&
          snapshot.auth.required !== false &&
          snapshot.auth.status === "authenticated",
        operation: null,
        runtime: input.runtime,
      },
    };
  };

export const DroidDriver: ProviderDriver<DroidSettings, DroidDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Droid",
    supportsMultipleInstances: true,
  },
  configSchema: DroidSettings,
  defaultConfig: (): DroidSettings => decodeDroidSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = droidProcessEnvironment(mergeProviderInstanceEnvironment(environment));
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const managedRuntime = yield* makeDroidManagedRuntimeResolution({
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
      } satisfies DroidSettings;
      const assistedAccountActionsAllowed = !hasDroidApiKeyEnvironment(processEnv);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        runtime: managedRuntime.summary,
        assistedAccountActionsAllowed,
      });

      const adapter = yield* makeDroidAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeDroidTextGeneration(effectiveConfig, processEnv);
      const connectionActions = !assistedAccountActionsAllowed
        ? undefined
        : withDroidSessionShutdown(
            makeDroidConnectionActions({
              settings: effectiveConfig,
              environment: processEnv,
              spawner,
            }),
            adapter.stopAll(),
          );

      const checkProvider = checkDroidProviderStatusWithCapabilities(
        effectiveConfig,
        processEnv,
      ).pipe(
        Effect.map(({ snapshot: checkedSnapshot, accountCapabilities }) =>
          stampIdentity(checkedSnapshot, accountCapabilities),
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DroidSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialDroidProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichDroidSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Droid snapshot: ${cause.message ?? String(cause)}`,
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
        adapter,
        textGeneration,
        ...(connectionActions ? { connectionActions } : {}),
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
