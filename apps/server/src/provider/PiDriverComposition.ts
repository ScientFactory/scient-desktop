import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
  type ServerProvider,
  type ServerSettings as ServerSettingsData,
} from "@t3tools/contracts";
import type { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makePiDriver,
  type PiDriverEnv,
  type PiRuntimeResolution,
  type PiRuntimeResolverInput,
} from "@t3tools/provider-pi/server";
import type { PiSettings } from "@t3tools/provider-pi/settings";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { customModelDiscoverySnapshot } from "../customModelCapabilities.ts";
import { toMcpCapabilities } from "../mcp/McpInvocationContext.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makePiCustomModelsClientFactory } from "./pi/PiCustomModels.ts";
import { makePiCustomModelsConnectionFactory } from "./pi/PiCustomModelsConnection.ts";
import { PiRpcProtocolError, type PiRpcSpawnOptions } from "./pi/PiRpcClient.ts";
import { makePiManagedRuntimeResolution } from "../scient/providerLifecycle/PiManagedRuntimeActions.ts";
import { turnStartErrorKeepingReceipt } from "../orchestration-v2/scient-provider/NativeTurnReceipts.ts";
import { buildScientAwareness } from "./ScientAwareness.ts";
import { scientToolProjectionForProvider } from "./ScientToolProjection.ts";
import { SCIENT_ORCHESTRATION_INSTRUCTIONS } from "./ScientProviderInstructions.ts";
import type { ScientProviderDriver, ScientProviderInstance } from "./ScientProviderInstance.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");

export type PiCompositionRequirements = PiDriverEnv | ServerConfig | ServerSettingsService;

type PiCompositionExtension = Pick<ScientProviderInstance, "managedRuntimeActions">;

const piToolProjection = scientToolProjectionForProvider("pi");

/** Pi's native before-agent-start hook is its supported Scient guidance seam. */
export const buildPiRuntimeGuidance = (capabilities?: ReadonlySet<string>): string =>
  buildScientAwareness(
    capabilities === undefined ? undefined : toMcpCapabilities(capabilities),
    piToolProjection,
  );

/** Keep Pi's provider-settings fingerprint scoped to custom models assigned to this instance. */
export const piCustomModelSnapshot = (
  settings: Pick<ServerSettingsData, "customModels">,
  instanceId: ProviderInstanceId,
) => customModelDiscoverySnapshot(settings.customModels.connections, instanceId);

/** Keep a native turn receipt if Pi's prompt failure already carried one. */
export const mapPiTurnStartError = (
  input: {
    readonly threadId: ThreadId;
    readonly providerThread: { readonly id: ProviderThreadId };
    readonly runId: RunId;
  },
  cause: unknown,
): ProviderAdapterTurnStartError => turnStartErrorKeepingReceipt(PI_DRIVER, input)(cause);

const resolvePiRuntime = (
  input: PiRuntimeResolverInput,
): Effect.Effect<
  PiRuntimeResolution<PiCompositionRequirements, PiCompositionExtension>,
  ProviderDriverError,
  PiCompositionRequirements
> =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverSettings = yield* ServerSettingsService;
    const managedRuntime = yield* makePiManagedRuntimeResolution({
      settings: input.config,
      baseDir: input.baseDir,
      environment: input.processEnv,
      spawner,
      managedInstallationAllowed: serverConfig.mode === "desktop",
    });
    const effectiveConfig = {
      ...input.config,
      enabled: input.enabled,
      binaryPath: expandHomePath(
        managedRuntime.effectiveBinaryPath,
        yield* HostProcess.HomeDirectory,
      ),
    } satisfies PiSettings;
    const customModelClientFactory = yield* makePiCustomModelsClientFactory(
      serverSettings,
      input.instanceId,
      input.stateDir,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: PI_DRIVER,
            instanceId: input.instanceId,
            detail: "Could not prepare custom models.",
            cause,
          }),
      ),
    );
    const makeRpcClient = (options: PiRpcSpawnOptions) =>
      customModelClientFactory(options).pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({
              detail: "Pi custom-model RPC failed.",
              cause,
            }),
        ),
      );
    const makeConnection = yield* makePiCustomModelsConnectionFactory(
      serverSettings,
      input.instanceId,
      input.stateDir,
    );

    return {
      effectiveConfig,
      effectiveEnvironment: input.processEnv,
      runtimeSummary: managedRuntime.summary,
      makeRpcClient,
      makeConnection,
      customModelSnapshot: (settings: ServerSettingsData) =>
        piCustomModelSnapshot(settings, input.instanceId),
      adapterOptions: {
        runtimeGuidance: buildPiRuntimeGuidance,
        orchestrationInstructions: SCIENT_ORCHESTRATION_INSTRUCTIONS,
        // Omit toolNameMap: Pi's MCP extension defaults to each canonical tool name.
        mapTurnStartError: mapPiTurnStartError,
      },
      decorateSnapshot: (snapshot: ServerProvider) => ({
        ...snapshot,
        connection: {
          methods: [],
          canDisconnect: false,
          operation: snapshot.connection?.operation ?? null,
          runtime: managedRuntime.summary,
        },
      }),
      composeInstance: (instance) =>
        Effect.succeed({
          ...instance,
          managedRuntimeActions: managedRuntime.actions,
        }),
    };
  });

/** Production Pi driver with Scient-owned runtime, model and prompt policy. */
export const PiDriver: ScientProviderDriver<PiSettings, PiCompositionRequirements> = makePiDriver<
  PiCompositionRequirements,
  PiCompositionExtension
>({ resolveRuntime: resolvePiRuntime });
