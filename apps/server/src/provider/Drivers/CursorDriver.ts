/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent (`cursor-agent`) runtime.
 *
 * Cursor exposes an ACP-based CLI. Model catalog and capability refreshes
 * happen during the managed provider status check via Cursor's
 * `list_available_models` extension method.
 *
 * Text generation is supported via the ACP runtime — `makeCursorTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/CursorDriver
 */
import {
  CursorSettings,
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
  makeCursorConnectionActions,
  withCursorSessionShutdown,
} from "../../scient/providerLifecycle/CursorConnectionActions.ts";
import { makeCursorManagedRuntimeResolution } from "../../scient/providerLifecycle/CursorManagedRuntimeActions.ts";
import { makeCursorTextGeneration } from "../../textGeneration/CursorTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import { readCursorUsageLimits } from "../Layers/cursorUsageLimits.ts";
import {
  cursorRuntimeEnvironment,
  hasExternalCursorAccountConfiguration,
} from "../Layers/CursorCli.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  makeCursorModelDiscovery,
  enrichCursorSnapshot,
  makeCursorCommandCatalog,
} from "../Layers/CursorProvider.ts";
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
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeCursorMachineSkillCatalog, probeCursorSkills } from "./CursorSkills.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
// cursor-agent updates itself, so the resolved executable is its own updater.
// No executable means nothing to update, not "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "cursor-agent",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
    ),
};

export function assistedCursorConnectionMethods(
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<ProviderConnectionMethod> {
  return hasExternalCursorAccountConfiguration(settings, environment) ? [] : ["cursor_browser"];
}

export type CursorDriverEnv =
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
      methods: snapshot.auth.required === false ? [] : input.connectionMethods,
      canDisconnect:
        snapshot.auth.required !== false &&
        input.connectionMethods.length > 0 &&
        snapshot.auth.status === "authenticated",
      operation: null,
      runtime: input.runtime,
    },
  });

export const CursorDriver: ProviderDriver<CursorSettings, CursorDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const managedRuntime = yield* makeCursorManagedRuntimeResolution({
        settings: config,
        enabled,
        baseDir: serverConfig.baseDir,
        environment: processEnv,
        spawner,
        managedInstallationAllowed: serverConfig.mode === "desktop",
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: managedRuntime.effectiveBinaryPath,
      } satisfies CursorSettings;
      const effectiveProcessEnv = cursorRuntimeEnvironment(
        processEnv,
        managedRuntime.usesManagedPath,
      );
      const connectionMethods = assistedCursorConnectionMethods(config, processEnv);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        runtime: managedRuntime.summary,
        connectionMethods,
      });
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        (managedRuntime.usesManagedPath
          ? Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER_KIND,
                packageName: null,
              }),
            )
          : resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
              binaryPath: effectiveConfig.binaryPath,
              env: effectiveProcessEnv,
            })
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const textGeneration = yield* makeCursorTextGeneration(effectiveConfig, effectiveProcessEnv);
      const providerConnectionActions =
        connectionMethods.length > 0
          ? yield* makeCursorConnectionActions(effectiveConfig, effectiveProcessEnv, spawner)
          : undefined;

      const modelDiscovery = yield* makeCursorModelDiscovery(effectiveConfig, effectiveProcessEnv);
      const machineSkills = yield* makeCursorMachineSkillCatalog(effectiveProcessEnv);
      const readMachineSkills = machineSkills.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        // A skill scan cannot make the provider itself unusable. Before the
        // first complete scan there is no catalog to preserve; retry on refresh.
        Effect.catch((error) =>
          Effect.logWarning(error.message).pipe(Effect.as([] as ServerProvider["skills"])),
        ),
      );
      const checkProvider = checkCursorProviderStatus(
        effectiveConfig,
        effectiveProcessEnv,
        modelDiscovery.discover,
      ).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed
            ? Effect.all({
                skills: readMachineSkills,
                usageLimits:
                  snapshot.auth.status === "authenticated"
                    ? readCursorUsageLimits(effectiveConfig, processEnv).pipe(
                        Effect.map((usageLimits) => ({ usageLimits })),
                      )
                    : Effect.succeed({}),
              }).pipe(
                Effect.map(({ skills, usageLimits }) => ({ ...snapshot, ...usageLimits, skills })),
              )
            : Effect.succeed(snapshot),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const managedSnapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<CursorSettings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        // Model catalog and capabilities come exclusively from Cursor's
        // list_available_models extension method during provider checks.
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichCursorSnapshot({
                settings: settings.provider,
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                stampIdentity,
                httpClient,
              }),
            ),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Cursor snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const { snapshot, onAvailableCommands, snapshotForCwd } =
        yield* makeCursorCommandCatalog(managedSnapshot);
      const adapter = yield* makeCursorAdapter(effectiveConfig, {
        environment: effectiveProcessEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onAvailableCommands: (commands, cwd) =>
          probeCursorSkills(cwd, effectiveProcessEnv).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.flatMap((skills) => onAvailableCommands(commands, cwd, skills)),
            Effect.catch((error) =>
              Effect.logWarning(error.message).pipe(
                Effect.andThen(onAvailableCommands(commands, cwd)),
              ),
            ),
          ),
      });
      const connectionActions = providerConnectionActions
        ? withCursorSessionShutdown(providerConnectionActions, adapter.stopAll())
        : undefined;

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        invalidateCaches: modelDiscovery.invalidate,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : probeCursorSkills(cwd, effectiveProcessEnv).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Cursor skills for '${cwd}'`,
                      cause,
                    }),
                ),
                Effect.flatMap((skills) => snapshotForCwd(cwd, skills)),
              ),
        adapter,
        textGeneration,
        ...(connectionActions ? { connectionActions } : {}),
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
