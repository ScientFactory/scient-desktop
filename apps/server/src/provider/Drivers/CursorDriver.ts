/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent SDK runtime.
 *
 * Provider status, model discovery, orchestration, and text generation use the
 * official Cursor SDK with an instance browser login or CURSOR_API_KEY. Scient
 * additionally resolves a managed `cursor-agent` runtime, publishes the machine
 * skill catalog alongside the probe, and reports the assisted connection
 * methods the app offers for the default provider.
 *
 * @module provider/Drivers/CursorDriver
 */
import {
  CursorSettings,
  type ProviderConnectionMethod,
  ProviderDriverKind,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readCursorUsageLimits } from "../Layers/cursorUsageLimits.ts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeCursorManagedRuntimeResolution } from "../../scient/providerLifecycle/CursorManagedRuntimeActions.ts";
import { makeCursorTextGeneration } from "../../textGeneration/CursorTextGeneration.ts";
import {
  CursorAdapterV2Driver,
  type CursorAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CursorAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { cursorRuntimeEnvironment } from "../Layers/CursorCli.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  makeCursorCommandCatalog,
} from "../Layers/CursorProvider.ts";
import * as CursorSdkCatalog from "../Layers/CursorSdkCatalog.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
// SCIENT-FORK:START — identity stamp carries assisted connection and runtime state.
import { withConnectionInstanceIdentity } from "./scientInstanceIdentity.ts";
// SCIENT-FORK:END
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
import { makeCursorAuth } from "../CursorAuth.ts";
import * as CursorCredentialStore from "../CursorCredentialStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CursorAgentSdk from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");

export function assistedCursorConnectionMethods(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<ProviderConnectionMethod> {
  // CLI endpoints and tokens do not own the SDK's account.
  return environment.CURSOR_API_KEY?.trim() ? [] : ["cursor_browser"];
}

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

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerSettings.ServerSettingsService;

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
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const serverConfig = yield* ServerConfig.ServerConfig;
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
      const connectionMethods = assistedCursorConnectionMethods(processEnv);
      const stampIdentity = withConnectionInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: displayName ?? "Cursor",
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        runtime: managedRuntime.summary,
        connectionMethods,
      });
      // The bundled SDK has no CLI update target. Explicit CLI targets retain
      // their maintenance controls; managed installs are replaced by Scient.
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        (!config.binaryPath?.trim() || managedRuntime.usesManagedPath
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
      const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
        instanceId,
        path.join(
          serverConfig.stateDir,
          "provider-auth",
          encodeURIComponent(instanceId),
          "cursor.json",
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not open the Cursor credential store.",
              cause,
            }),
        ),
      );
      const auth = yield* makeCursorAuth({
        instanceId,
        displayName: displayName ?? "Cursor",
        enabled,
        ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
        store: credentials.store,
        credentialBinding: credentials.binding,
        onChanged: (signedIn): Effect.Effect<void, ProviderSetupError> =>
          snapshot.refresh.pipe(
            Effect.flatMap((provider) =>
              !signedIn || provider.auth.status === "authenticated"
                ? Effect.void
                : Effect.fail(
                    new ProviderSetupError({
                      instanceId,
                      operation: "start",
                      detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                    }),
                  ),
            ),
          ),
      });
      const stampSnapshot: typeof stampIdentity = (draft) =>
        stampIdentity({
          ...draft,
          setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
          auth: {
            ...draft.auth,
            canLogout: !auth.usesApiKey,
          },
        });

      const orchestrationAdapter = yield* CursorAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfig,
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          ...sdkRunner,
          open: (input) =>
            auth.requireApiKey.pipe(
              Effect.flatMap((apiKey) =>
                Effect.acquireRelease(
                  sdkRunner
                    .open({ ...input, options: { ...input.options, apiKey } })
                    .pipe(
                      Effect.flatMap((session) =>
                        Effect.cached(session.close).pipe(
                          Effect.map((close) => ({ ...session, close })),
                        ),
                      ),
                    ),
                  (session) => session.close.pipe(Effect.ignore),
                ),
              ),
              auth.withAccess,
              Effect.mapError((cause) =>
                isSdkRunnerError(cause)
                  ? cause
                  : new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "open", cause }),
              ),
            ),
        }),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Cursor orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeCursorTextGeneration(
        effectiveConfig,
        effectiveProcessEnv,
        auth.requireApiKey,
        auth.withAccess,
      );
      // A skill scan cannot make the provider itself unusable. Before the first
      // complete scan there is no catalog to preserve; retry on refresh.
      const readMachineSkills = (yield* makeCursorMachineSkillCatalog(effectiveProcessEnv).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      )).pipe(Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(undefined))));

      const checkProvider = auth.readApiKey.pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((apiKey) =>
          checkCursorProviderStatus(
            effectiveConfig,
            {
              ...effectiveProcessEnv,
              CURSOR_API_KEY: apiKey,
            },
            auth.usesApiKey ? "api-key" : "browser",
          ).pipe(
            Effect.flatMap((snapshot) =>
              effectiveConfig.enabled && snapshot.installed
                ? Effect.gen(function* () {
                    const { skills, usageLimits } = yield* Effect.all({
                      skills: readMachineSkills,
                      usageLimits: Effect.gen(function* () {
                        if (snapshot.auth.status !== "authenticated") {
                          return undefined;
                        }
                        const settings = yield* serverSettings.getSettings;
                        // The macOS Keychain read stays opt-in: the setting defaults
                        // to false and `readCursorUsageLimits` also defaults to it.
                        return yield* readCursorUsageLimits(
                          effectiveConfig,
                          { ...effectiveProcessEnv, CURSOR_API_KEY: apiKey },
                          settings.cursorKeychainUsageEnabled,
                        );
                      }),
                    });
                    return {
                      ...snapshot,
                      ...(usageLimits ? { usageLimits } : {}),
                      ...(skills === undefined ? {} : { skills }),
                    };
                  })
                : Effect.succeed(snapshot),
            ),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.map(stampSnapshot),
        Effect.provide(CursorSdkCatalog.CursorSdkCatalogLive),
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
          buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
        checkProvider,
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

      const { snapshot, snapshotForCwd } = yield* makeCursorCommandCatalog(managedSnapshot);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth: auth.controller,
        snapshot,
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
        orchestrationAdapter,
        textGeneration,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
