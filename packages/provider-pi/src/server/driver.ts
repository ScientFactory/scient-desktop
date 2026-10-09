/**
 * Pi provider driver. Runtime policy and app-owned model/lifecycle behavior
 * enter through the optional resolver; protocol, probing and sessions remain
 * provider-package code.
 */
import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { PiSettings } from "../settings.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makePiTextGeneration } from "./textGeneration.ts";
import {
  makePiAdapterV2,
  piContinuationRequestsIfProvided,
  type PiAdapterV2Options,
  type PiAdapterV2DriverEnv,
} from "./adapter.ts";
import { makePiRpcClient } from "./rpcClient.ts";
import { makePiRpcConnection } from "./rpc.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  discoverPiCommandsForCwd,
  enrichPiSnapshot,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
export type PiRpcClientFactory = typeof makePiRpcClient;

const decodePiSettings = Schema.decodeSync(PiSettings);
const DRIVER_KIND = ProviderDriverKind.make("pi");
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@earendil-works/pi-coding-agent",
  nativeUpdate: { args: ["update", "--self"] },
});

export type PiDriverEnv =
  | PiAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost;

export interface PiRuntimeResolverInput extends ProviderDriverCreateInput<PiSettings> {
  readonly baseDir: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly providerStatusCacheDir: string;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly processEnv: NodeJS.ProcessEnv;
}

export interface PiRuntimeResolution<Requirements = never, Extension extends object = {}> {
  readonly effectiveConfig: PiSettings;
  readonly effectiveEnvironment: NodeJS.ProcessEnv;
  /** Host-owned runtime/auth summary to stamp on provider snapshots. */
  readonly runtimeSummary?: NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;
  readonly maintenanceResolver?: ProviderMaintenanceCapabilitiesResolver;
  /** Typed RPC client that carries existing custom-model and credential policy. */
  readonly makeRpcClient?: PiRpcClientFactory;
  /** Native connection factory for app-owned custom model connections. */
  readonly makeConnection?: typeof makePiRpcConnection;
  /** Maps host settings to the app-owned custom-model discovery snapshot. */
  readonly customModelSnapshot?: (settings: ServerSettings, instanceId: string) => unknown;
  /** Optional app-owned prompt, canonical tool projection, and receipt behavior. */
  readonly adapterOptions?: Pick<
    PiAdapterV2Options,
    "runtimeGuidance" | "toolNameMap" | "mapTurnStartError"
  >;
  /** Add lifecycle/action fields without moving their authority into this package. */
  readonly composeInstance: (
    instance: ProviderInstance,
  ) => Effect.Effect<ProviderInstance & Extension, ProviderDriverError, Requirements>;
  readonly decorateSnapshot?: (snapshot: ServerProvider) => ServerProvider;
}

export interface PiDriverOptions<Requirements = never, Extension extends object = {}> {
  readonly resolveRuntime?: (
    input: PiRuntimeResolverInput,
  ) => Effect.Effect<
    PiRuntimeResolution<Requirements, Extension>,
    ProviderDriverError,
    Requirements
  >;
}

export interface PiDriverFactory<
  Requirements = never,
  Extension extends object = {},
> extends ProviderDriver<PiSettings, PiDriverEnv | Requirements> {
  readonly create: (
    input: ProviderDriverCreateInput<PiSettings>,
  ) => Effect.Effect<
    ProviderInstance & Extension,
    ProviderDriverError,
    PiDriverEnv | Requirements | import("effect/Scope").Scope
  >;
}

export function makePiDriver<Requirements = never, Extension extends object = {}>(
  options: PiDriverOptions<Requirements, Extension> = {},
): PiDriverFactory<Requirements, Extension> {
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Pi", supportsMultipleInstances: true },
    configSchema: PiSettings,
    defaultConfig: (): PiSettings => decodePiSettings({}),
    create: (input) =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const httpClient = yield* HttpClient.HttpClient;
        // References have a default process.env value. Reading through the
        // current context keeps host overrides while leaving this defaulted
        // reference out of the required provider-driver environment.
        const hostContext = yield* Effect.context<never>();
        const hostEnvironment = Context.get(hostContext, HostProcessEnvironment);
        const processEnv = mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
        const runtime: PiRuntimeResolution<Requirements, Extension> = options.resolveRuntime
          ? yield* options.resolveRuntime({
              ...input,
              baseDir: host.paths.baseDir,
              cwd: host.paths.cwd,
              stateDir: host.paths.stateDir,
              providerStatusCacheDir: host.paths.providerStatusCacheDir,
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
        } satisfies PiSettings;
        const effectiveEnvironment = runtime.effectiveEnvironment;
        const makeRpcClient = runtime.makeRpcClient ?? makePiRpcClient;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId: input.instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          displayName: input.displayName ?? "Pi",
          accentColor: input.accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const stampSnapshot = (draft: ServerProviderDraft): ServerProvider => {
          const identified = stampIdentity({
            ...draft,
            ...(runtime.runtimeSummary === undefined || draft.connection === undefined
              ? {}
              : {
                  connection: {
                    ...draft.connection,
                    runtime: runtime.runtimeSummary,
                  },
                }),
          });
          return runtime.decorateSnapshot?.(identified) ?? identified;
        };

        const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
          resolveProviderMaintenanceCapabilitiesEffect(runtime.maintenanceResolver ?? UPDATE, {
            ...(effectiveConfig.binaryPath === undefined
              ? {}
              : { binaryPath: effectiveConfig.binaryPath }),
            env: effectiveEnvironment,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        );
        const continuationRequests = yield* piContinuationRequestsIfProvided;
        const orchestrationAdapter = yield* makePiAdapterV2({
          instanceId: input.instanceId,
          settings: effectiveConfig,
          environment: effectiveEnvironment,
          ...(runtime.makeConnection === undefined
            ? {}
            : { makeConnection: runtime.makeConnection }),
          ...(runtime.adapterOptions ?? {}),
          ...(continuationRequests === undefined ? {} : { continuationRequests }),
        });
        const textGeneration = yield* makePiTextGeneration(
          effectiveConfig,
          effectiveEnvironment,
          makeRpcClient,
        );
        const checkProvider = checkPiProviderStatus(
          effectiveConfig,
          effectiveEnvironment,
          host.paths.cwd,
          makeRpcClient,
        ).pipe(
          Effect.map(stampSnapshot),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const mapSettings = (settings: ServerSettings) => ({
          provider: effectiveConfig,
          enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          ...(runtime.customModelSnapshot === undefined
            ? {}
            : { customModels: runtime.customModelSnapshot(settings, input.instanceId) }),
        });
        const snapshotSettings = {
          getSettings: host.settings.get.pipe(Effect.map(mapSettings)),
          streamSettings: host.settings.changes.pipe(Stream.map(mapSettings)),
        };
        const snapshot = yield* makeManagedServerProvider<
          ProviderSnapshotSettings<PiSettings> & { readonly customModels?: unknown }
        >({
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichPiSnapshot({
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
                detail: "Failed to build Pi snapshot.",
                cause,
              }),
          ),
        );
        const instance = {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName: input.displayName,
          accentColor: input.accentColor,
          enabled: input.enabled,
          snapshot,
          orchestrationAdapter,
          textGeneration,
          snapshotForCwd: (cwd: string) =>
            !effectiveConfig.enabled
              ? snapshot.getSnapshot
              : Effect.all([
                  snapshot.getSnapshot,
                  discoverPiCommandsForCwd(
                    effectiveConfig,
                    effectiveEnvironment,
                    cwd,
                    makeRpcClient,
                  ).pipe(
                    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                    Effect.mapError(
                      (cause) =>
                        new ProviderDriverError({
                          driver: DRIVER_KIND,
                          instanceId: input.instanceId,
                          detail: "Failed to discover Pi workspace commands.",
                          cause,
                        }),
                    ),
                  ),
                ]).pipe(
                  Effect.map(([machineSnapshot, commands]) => ({
                    ...machineSnapshot,
                    ...commands,
                  })),
                ),
        } satisfies ProviderInstance;
        return yield* runtime.composeInstance(instance);
      }),
  };
}

export const PiDriver = makePiDriver();
