/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent SDK runtime.
 *
 * Provider status, model discovery, orchestration, and text generation use the
 * official Cursor SDK with an instance browser login or CURSOR_API_KEY. A host
 * may inject runtime resolution and instance composition without moving that
 * host's lifecycle policy into this package.
 *
 * @module provider/Drivers/CursorDriver
 */
import { ProviderDriverKind, ProviderSetupError, type ServerProvider } from "@t3tools/contracts";
import { CursorSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import type * as Scope from "effect/Scope";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import {
  makeCursorAdapterV2Driver,
  type CursorAdapterV2DriverEnv,
  type CursorTurnStartErrorMapper,
} from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { buildInitialCursorProviderSnapshot, checkCursorProviderStatus } from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { makeCursorMachineSkillCatalog, probeCursorSkills } from "./skills.ts";
import { makeCursorCommandCatalog } from "./commandCatalog.ts";
import { makeCursorAuth } from "./auth.ts";
import * as CursorCredentialStore from "./credentialStore.ts";
import { readCursorUsageLimits } from "./usageLimits.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const DEFAULT_MAINTENANCE = {
  resolve: () =>
    Effect.succeed(
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      }),
    ),
};

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost;

export interface CursorRuntimeResolverInput extends ProviderDriverCreateInput<CursorSettings> {
  /** The base directory selected by the host's provider runtime. */
  readonly baseDir: string;
  /** Host process environment before per-instance overrides. */
  readonly hostEnvironment: NodeJS.ProcessEnv;
  /** Host process environment with the instance overrides applied. */
  readonly processEnv: NodeJS.ProcessEnv;
}

/**
 * Host-owned runtime policy applied around the generic Cursor driver.
 *
 * `effectiveEnvironment` is used for status, skills, and text-generation
 * commands. The SDK adapter continues to receive the explicit instance
 * environment and effective config, so it does not inherit arbitrary host
 * resolver state.
 */
export interface CursorRuntimeResolution<Requirements = never, Extension extends object = {}> {
  readonly effectiveConfig: CursorSettings;
  readonly effectiveEnvironment: NodeJS.ProcessEnv;
  readonly maintenanceResolver?: ProviderMaintenanceCapabilitiesResolver;
  /** Host-owned mapping that may retain an already observed native-delivery receipt. */
  readonly turnStartError?: CursorTurnStartErrorMapper;
  /** Called after the package stamps the canonical provider-instance identity. */
  readonly decorateSnapshot?: (snapshot: ServerProvider) => ServerProvider;
  /** Compose host-owned lifecycle capabilities around the generic instance. */
  readonly composeInstance: (
    instance: ProviderInstance,
  ) => Effect.Effect<ProviderInstance & Extension, ProviderDriverError, Requirements>;
}

export interface CursorDriverOptions<Requirements = never, Extension extends object = {}> {
  readonly resolveRuntime?: (
    input: CursorRuntimeResolverInput,
  ) => Effect.Effect<
    CursorRuntimeResolution<Requirements, Extension>,
    ProviderDriverError,
    Requirements
  >;
}

export interface CursorDriverFactory<
  Requirements = never,
  Extension extends object = {},
> extends ProviderDriver<CursorSettings, CursorDriverEnv | Requirements> {
  readonly create: (
    input: ProviderDriverCreateInput<CursorSettings>,
  ) => Effect.Effect<
    ProviderInstance & Extension,
    ProviderDriverError,
    CursorDriverEnv | Requirements | Scope.Scope
  >;
}

export function makeCursorDriver<Requirements = never, Extension extends object = {}>(
  options: CursorDriverOptions<Requirements, Extension> = {},
): CursorDriverFactory<Requirements, Extension> {
  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: "Cursor",
      supportsMultipleInstances: true,
    },
    configSchema: CursorSettings,
    defaultConfig: (): CursorSettings => decodeCursorSettings({}),
    create: (input) =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const httpClient = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        const hostEnvironment = yield* HostProcessEnvironment;
        const processEnv = mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
        const runtime: CursorRuntimeResolution<Requirements, Extension> = options.resolveRuntime
          ? yield* options.resolveRuntime({
              ...input,
              baseDir: host.paths.baseDir,
              hostEnvironment,
              processEnv,
            })
          : {
              effectiveConfig: { ...input.config, enabled: input.enabled },
              effectiveEnvironment: processEnv,
              composeInstance: (instance: ProviderInstance) =>
                Effect.succeed(instance as ProviderInstance & Extension),
            };
        const effectiveConfig = {
          ...runtime.effectiveConfig,
          enabled: input.enabled,
        } satisfies CursorSettings;
        const effectiveEnvironment = runtime.effectiveEnvironment;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId: input.instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          displayName: input.displayName ?? "Cursor",
          accentColor: input.accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });

        const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
          input.instanceId,
          path.join(
            host.paths.stateDir,
            "provider-auth",
            encodeURIComponent(input.instanceId),
            "cursor.json",
          ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: input.instanceId,
                detail: "Could not open the Cursor credential store.",
                cause,
              }),
          ),
        );
        const auth = yield* makeCursorAuth({
          instanceId: input.instanceId,
          displayName: input.displayName ?? "Cursor",
          enabled: input.enabled,
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
                        instanceId: input.instanceId,
                        operation: "start",
                        detail:
                          provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                      }),
                    ),
              ),
            ),
        });
        const stampSnapshot = (draft: ServerProviderDraft): ServerProvider => {
          const identified = stampIdentity({
            ...draft,
            setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
            auth: {
              ...draft.auth,
              canLogout: !auth.usesApiKey,
            },
          });
          return runtime.decorateSnapshot?.(identified) ?? identified;
        };

        const orchestrationAdapter = yield* makeCursorAdapterV2Driver({
          ...(runtime.turnStartError ? { turnStartError: runtime.turnStartError } : {}),
        })
          .create({
            ...input,
            config: effectiveConfig,
          })
          .pipe(
            Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
              ...sdkRunner,
              open: (openInput) =>
                auth.requireApiKey.pipe(
                  Effect.flatMap((apiKey) =>
                    Effect.acquireRelease(
                      sdkRunner
                        .open({
                          ...openInput,
                          options: { ...openInput.options, apiKey },
                        })
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
                      : new CursorAgentSdk.CursorAgentSdkRunnerError({
                          method: "open",
                          cause,
                        }),
                  ),
                ),
            }),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId: input.instanceId,
                  detail: "Failed to build Cursor orchestration adapter.",
                  cause,
                }),
            ),
          );
        const textGeneration = yield* makeCursorTextGeneration(
          effectiveConfig,
          effectiveEnvironment,
          auth.requireApiKey,
          auth.withAccess,
        );
        const readMachineSkills = (yield* makeCursorMachineSkillCatalog(effectiveEnvironment).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        )).pipe(
          Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(undefined))),
        );
        const checkProvider = auth.readApiKey.pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((apiKey) =>
            checkCursorProviderStatus(
              effectiveConfig,
              { ...effectiveEnvironment, CURSOR_API_KEY: apiKey },
              auth.usesApiKey ? "api-key" : "browser",
            ).pipe(
              Effect.flatMap((providerSnapshot) =>
                effectiveConfig.enabled && providerSnapshot.installed
                  ? Effect.gen(function* () {
                      const skills = yield* readMachineSkills;
                      const usageLimits =
                        providerSnapshot.auth.status === "authenticated"
                          ? yield* host.settings.get.pipe(
                              Effect.flatMap((settings) =>
                                readCursorUsageLimits(
                                  effectiveConfig,
                                  { ...effectiveEnvironment, CURSOR_API_KEY: apiKey },
                                  settings.cursorKeychainUsageEnabled,
                                ),
                              ),
                            )
                          : undefined;
                      return {
                        ...providerSnapshot,
                        ...(skills === undefined ? {} : { skills }),
                        ...(usageLimits === undefined ? {} : { usageLimits }),
                      };
                    })
                  : Effect.succeed(providerSnapshot),
              ),
            ),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map(stampSnapshot),
          Effect.provide(CursorSdkCatalog.layer),
        );

        const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
          resolveProviderMaintenanceCapabilitiesEffect(
            runtime.maintenanceResolver ?? DEFAULT_MAINTENANCE,
            {
              ...(effectiveConfig.binaryPath === undefined
                ? {}
                : { binaryPath: effectiveConfig.binaryPath }),
              env: effectiveEnvironment,
            },
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        );
        const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CursorSettings>>(
          {
            resolveMaintenance,
            getSettings: snapshotSettings.getSettings,
            streamSettings: snapshotSettings.streamSettings,
            haveSettingsChanged: haveProviderSnapshotSettingsChanged,
            initialSnapshot: (settings) =>
              buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
            checkProvider,
          },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: input.instanceId,
                detail: `Failed to build Cursor snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );
        const commandCatalog = yield* makeCursorCommandCatalog(snapshot);

        const instance = {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName: input.displayName,
          accentColor: input.accentColor,
          enabled: input.enabled,
          auth: auth.controller,
          snapshot: commandCatalog.snapshot,
          snapshotForCwd: (cwd: string) =>
            !effectiveConfig.enabled
              ? commandCatalog.snapshot.getSnapshot
              : Effect.all([
                  commandCatalog.snapshot.getSnapshot,
                  probeCursorSkills(cwd, effectiveEnvironment).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                    Effect.mapError(
                      (cause) =>
                        new ProviderDriverError({
                          driver: DRIVER_KIND,
                          instanceId: input.instanceId,
                          detail: `Failed to discover Cursor skills for '${cwd}'`,
                          cause,
                        }),
                    ),
                  ),
                ]).pipe(Effect.flatMap(([, skills]) => commandCatalog.snapshotForCwd(cwd, skills))),
          orchestrationAdapter,
          textGeneration,
        } satisfies ProviderInstance;

        return yield* runtime.composeInstance(instance);
      }),
  };
}

export const CursorDriver = makeCursorDriver();
