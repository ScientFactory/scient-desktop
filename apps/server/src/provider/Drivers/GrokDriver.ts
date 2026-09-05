import {
  GrokSettings,
  type ProviderConnectionMethod,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
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
import {
  makeGrokConnectionActions,
  withGrokSessionShutdown,
} from "../../scient/providerLifecycle/GrokConnectionActions.ts";
import { makeGrokManagedRuntimeResolution } from "../../scient/providerLifecycle/GrokManagedRuntimeActions.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
} from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { discoverGrokSkills } from "./GrokSkills.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type GrokDriverEnv =
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
    readonly connectionMethods: ReadonlyArray<ProviderConnectionMethod>;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    connection: {
      methods: input.connectionMethods,
      canDisconnect:
        snapshot.auth.status === "authenticated" && snapshot.auth.type === "grok_account",
      operation: null,
      runtime: input.runtime,
    },
  });

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const { cwd } = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const managedRuntime = yield* makeGrokManagedRuntimeResolution({
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
      } satisfies GrokSettings;
      const connectionMethods = ["grok_account", "grok_device_code"] as const;
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        runtime: managedRuntime.summary,
        connectionMethods,
      });
      const adapter = yield* makeGrokAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv);
      const connectionActions = withGrokSessionShutdown(
        yield* makeGrokConnectionActions(effectiveConfig, processEnv, spawner),
        adapter.stopAll(),
      );

      const checkProvider = checkGrokProviderStatus(effectiveConfig, processEnv, cwd).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGrokProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichGrokSnapshot({
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
              detail: `Failed to build Grok snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverGrokSkills(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Grok skills for '${workspaceCwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
        connectionActions,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
