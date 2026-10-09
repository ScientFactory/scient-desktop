import {
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ServerProvider,
} from "@t3tools/contracts";
import { GrokSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import type * as Scope from "effect/Scope";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeGrokTextGeneration } from "./textGeneration.ts";
import { makeGrokAdapterV2ForInstance, type GrokAdapterV2DriverEnv } from "./adapter.ts";
import type { AcpAdapterV2ApplicationBridge } from "@t3tools/provider-acp/server/adapter";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
} from "./status.ts";
import { readGrokAccount } from "./usageLimits.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriverCreateInput,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { discoverGrokSkills } from "./skills.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
// npm's `latest` tracks Grok's stable channel, the one `grok update` installs
// by default, so the registry stays the source for "latest".
const GROK_NPM_PACKAGE = "@xai-official/grok";
// `grok update` finds the installer that owns the binary itself, so the
// resolved executable is its own updater. It installs under `GROK_HOME`, so it
// runs with the instance's environment. No executable means nothing to update,
// not "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: GROK_NPM_PACKAGE,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "grok",
            platform: context.platform,
            env: context.env,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: GROK_NPM_PACKAGE,
          }),
    ),
};

export type GrokDriverEnv =
  | GrokAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export interface GrokRuntimeResolverInput {
  readonly instanceId: ProviderDriverCreateInput<GrokSettings>["instanceId"];
  readonly displayName: ProviderDriverCreateInput<GrokSettings>["displayName"];
  readonly accentColor?: ProviderDriverCreateInput<GrokSettings>["accentColor"];
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: GrokSettings;
  readonly hostEnvironment: NodeJS.ProcessEnv;
}

/**
 * App-supplied runtime composition for Grok. The package owns protocol,
 * probing, models and skills discovery; the host can select an effective
 * managed runtime and decorate the resulting instance without importing app
 * lifecycle policy into this package.
 */
export interface GrokRuntimeResolution<Requirements = never, Extension extends object = {}> {
  readonly effectiveConfig: GrokSettings;
  readonly effectiveEnvironment: NodeJS.ProcessEnv;
  /** Called after the package stamps the canonical provider-instance identity. */
  readonly decorateSnapshot?: (snapshot: ServerProvider) => ServerProvider;
  /** Supply a host-owned maintenance policy for a selected runtime source. */
  readonly maintenanceResolver?: ProviderMaintenanceCapabilitiesResolver;
  /** App-owned ACP capabilities passed to the adapter without moving policy into this package. */
  readonly application?: AcpAdapterV2ApplicationBridge;
  /** Compose host-owned session shutdown and lifecycle actions around the package instance. */
  readonly composeInstance: (
    instance: ProviderInstance,
  ) => Effect.Effect<ProviderInstance & Extension, ProviderDriverError, Requirements>;
}

export interface GrokDriverOptions<Requirements = never, Extension extends object = {}> {
  /** App-owned ACP policy callbacks supplied at server composition time. */
  readonly application?: AcpAdapterV2ApplicationBridge;
  readonly resolveRuntime?: (
    input: GrokRuntimeResolverInput,
  ) => Effect.Effect<
    GrokRuntimeResolution<Requirements, Extension>,
    ProviderDriverError,
    Requirements
  >;
}

export interface GrokDriverFactory<
  Requirements = never,
  Extension extends object = {},
> extends ProviderDriver<GrokSettings, GrokDriverEnv | Requirements> {
  readonly create: (
    input: ProviderDriverCreateInput<GrokSettings>,
  ) => Effect.Effect<
    ProviderInstance & Extension,
    ProviderDriverError,
    GrokDriverEnv | Requirements | Scope.Scope
  >;
}

export function makeGrokDriver<Requirements = never, Extension extends object = {}>(
  options: GrokDriverOptions<Requirements, Extension> = {},
): GrokDriverFactory<Requirements, Extension> {
  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: "Grok",
      supportsMultipleInstances: true,
    },
    configSchema: GrokSettings,
    defaultConfig: (): GrokSettings => decodeGrokSettings({}),
    create: (input) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* ProviderHost.ProviderHost;
        const hostEnvironment = yield* HostProcessEnvironment;
        const { cwd } = host.paths;
        const runtime: GrokRuntimeResolution<Requirements, Extension> = options.resolveRuntime
          ? yield* options.resolveRuntime({ ...input, hostEnvironment })
          : {
              effectiveConfig: { ...input.config, enabled: input.enabled },
              effectiveEnvironment: mergeProviderInstanceEnvironment(
                input.environment,
                hostEnvironment,
              ),
              // The default instance has no app extension. Non-empty extension
              // types are only returned by an explicit resolver/composer.
              composeInstance: (instance: ProviderInstance) =>
                Effect.succeed(instance as ProviderInstance & Extension),
            };
        const effectiveConfig = {
          ...runtime.effectiveConfig,
          enabled: input.enabled,
        } satisfies GrokSettings;
        const effectiveEnvironment = runtime.effectiveEnvironment;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId: input.instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          displayName: input.displayName,
          accentColor: input.accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const decorateSnapshot = (snapshot: ServerProviderDraft): ServerProvider => {
          const identified = stampIdentity(snapshot);
          return runtime.decorateSnapshot?.(identified) ?? identified;
        };
        const maintenanceResolver = runtime.maintenanceResolver ?? UPDATE;
        const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
          resolveProviderMaintenanceCapabilitiesEffect(maintenanceResolver, {
            binaryPath: effectiveConfig.binaryPath,
            env: effectiveEnvironment,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        );
        const orchestrationAdapter = yield* makeGrokAdapterV2ForInstance(
          {
            ...input,
            config: effectiveConfig,
          },
          effectiveEnvironment,
          runtime.application ?? options.application,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: input.instanceId,
                detail: "Failed to build Grok orchestration adapter.",
                cause,
              }),
          ),
        );
        const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, effectiveEnvironment);

        const checkProvider = checkGrokProviderStatus(
          effectiveConfig,
          effectiveEnvironment,
          cwd,
        ).pipe(
          Effect.flatMap((snapshot) =>
            effectiveConfig.enabled &&
            snapshot.installed &&
            snapshot.auth.status === "authenticated"
              ? readGrokAccount(effectiveEnvironment).pipe(
                  Effect.map(({ email, usageLimits }) => ({
                    ...snapshot,
                    auth: email ? { ...snapshot.auth, email } : snapshot.auth,
                    usageLimits,
                  })),
                )
              : Effect.succeed(snapshot),
          ),
          Effect.map(decorateSnapshot),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialGrokProviderSnapshot(settings.provider).pipe(Effect.map(decorateSnapshot)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichGrokSnapshot({
                  snapshot: currentSnapshot,
                  maintenanceCapabilities,
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                  publishSnapshot,
                  httpClient,
                }),
              ),
            ),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: input.instanceId,
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
                discoverGrokSkills(effectiveConfig, effectiveEnvironment, workspaceCwd).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId: input.instanceId,
                        detail: `Failed to discover Grok skills for '${workspaceCwd}'`,
                        cause,
                      }),
                  ),
                ),
              ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

        const instance = {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName: input.displayName,
          accentColor: input.accentColor,
          enabled: input.enabled,
          snapshot,
          snapshotForCwd,
          orchestrationAdapter,
          textGeneration,
        } satisfies ProviderInstance;

        return yield* runtime.composeInstance(instance);
      }),
  };
}

export const GrokDriver = makeGrokDriver();
