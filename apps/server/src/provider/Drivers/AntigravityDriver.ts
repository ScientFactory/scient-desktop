/**
 * AntigravityDriver — `ProviderDriver` for the Antigravity (`agy`) runtime.
 *
 * Antigravity uses the CLI's native persistent stream-json interface.
 *
 * Text generation uses the same native transport with agy's JSON-schema
 * structured-output option.
 *
 * The provider defaults to enabled so first-run assisted onboarding can
 * install and verify it. An explicit instance or legacy disable still wins.
 *
 * @module provider/Drivers/AntigravityDriver
 */
import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderConnectionMethod,
  type ServerProvider,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import { makeAntigravityTextGeneration } from "../../textGeneration/AntigravityTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";
import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
  enrichAntigravitySnapshot,
} from "../Layers/AntigravityProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makeAntigravityConnectionActions,
  makeAntigravityLocalCredentialStore,
  officialAntigravityAccountEnvironment,
  withAntigravitySessionShutdown,
} from "../../scient/providerLifecycle/AntigravityConnectionActions.ts";
import { makeAntigravityManagedRuntimeResolution } from "../../scient/providerLifecycle/AntigravityManagedRuntimeActions.ts";
import { PtyAdapter } from "../../terminal/PtyAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const DRIVER_KIND = ProviderDriverKind.make("antigravity");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type AntigravityDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | PtyAdapter
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
      methods: snapshot.auth.required === false ? [] : input.connectionMethods,
      canDisconnect:
        snapshot.auth.required !== false &&
        input.connectionMethods.length > 0 &&
        snapshot.auth.status === "authenticated",
      operation: null,
      runtime: input.runtime,
    },
  });

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Antigravity",
    supportsMultipleInstances: true,
  },
  configSchema: AntigravitySettings,
  defaultConfig: (): AntigravitySettings => decodeAntigravitySettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const ptyAdapter = yield* PtyAdapter;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      // Antigravity is intentionally the Google-account/subscription provider.
      // Do not let ambient Gemini/API-key variables silently change billing or
      // make an unauthenticated account appear connected.
      const processEnv = officialAntigravityAccountEnvironment(
        mergeProviderInstanceEnvironment(environment),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const managedRuntime = yield* makeAntigravityManagedRuntimeResolution({
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
      } satisfies AntigravitySettings;
      const effectiveProcessEnv = managedRuntime.usesManagedPath
        ? { ...processEnv, DISABLE_UPDATES: "1" }
        : processEnv;
      const connectionMethods = ["antigravity_google"] as const;
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        runtime: managedRuntime.summary,
        connectionMethods,
      });
      const maintenanceCapabilities = managedRuntime.usesManagedPath
        ? makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          })
        : yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
            binaryPath: effectiveConfig.binaryPath,
            env: effectiveProcessEnv,
          });

      const adapter = yield* makeAntigravityAdapter(effectiveConfig, {
        environment: effectiveProcessEnv,
        attachmentsDir: serverConfig.attachmentsDir,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeAntigravityTextGeneration(
        effectiveConfig,
        effectiveProcessEnv,
      );

      // Connection actions for the antigravity_google auth method.
      const connectionActions = yield* makeAntigravityConnectionActions(
        effectiveConfig,
        effectiveProcessEnv,
        spawner,
        ptyAdapter,
        makeAntigravityLocalCredentialStore(
          effectiveProcessEnv,
          fileSystem,
          path,
          spawner,
          platform,
        ),
      ).pipe(Effect.map((actions) => withAntigravitySessionShutdown(actions, adapter.stopAll())));
      const checkProvider = checkAntigravityProviderStatus(
        effectiveConfig,
        effectiveProcessEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AntigravitySettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialAntigravityProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichAntigravitySnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            stampIdentity,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Antigravity snapshot: ${cause.message ?? String(cause)}`,
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
        connectionActions,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
