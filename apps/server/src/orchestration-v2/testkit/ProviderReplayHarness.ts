import { ContextHandoffPolicyOverride } from "../ScientContextHandoffPolicy.ts";
import type { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ScientMigrationError } from "../scient-fork/scientMigrator.ts";
import type { V2DatabaseImportError } from "../../persistence/initializeV2Database.ts";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import type * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as CheckpointCaptureService from "../CheckpointCaptureService.ts";
import * as CheckpointService from "../CheckpointService.ts";
import * as CheckpointRollbackService from "../CheckpointRollbackService.ts";
import * as CommandPolicy from "../CommandPolicy.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import * as ProviderAuthService from "../../provider/Services/ProviderAuthService.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import * as ProviderContinuationService from "../ProviderContinuationService.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as ProviderRuntimeRecoveryService from "../ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ProviderSwitchService from "../ProviderSwitchService.ts";
import * as ProviderTurnControlService from "../ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../ProviderTurnStartService.ts";
import { worktreeRepairDependenciesTestLayer } from "../ProviderTurnStartService.testkit.ts";
import * as RunExecutionService from "../RunExecutionService.ts";
import * as RunFinalizationService from "../RunFinalizationService.ts";
import * as ThreadTitleRegenerationService from "../ThreadTitleRegenerationService.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as TurnItemPositionStore from "../TurnItemPositionStore.ts";
import * as RuntimeRequestService from "../RuntimeRequestService.ts";
import * as ThreadForkService from "../ThreadForkService.ts";
import * as ConversationForks from "../scient-fork/ConversationForkService.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { ScientForkCheckpointBaselineLive } from "../scient-fork/ForkCheckpointBaseline.ts";
import { ScientForkAttachmentCopierLive } from "../scient-fork/ForkAttachmentCopier.ts";
import { layer as threadCommandExecutorLayer } from "../ThreadCommandExecutor.ts";
import {
  runOrchestratorV2Scenario,
  type OrchestratorV2ScenarioStepError,
  type OrchestratorV2Scenario,
  type OrchestratorV2ScenarioResult,
} from "./OrchestratorScenario.ts";
import { makeProviderReplayGate, type ProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

export function makeReplayServerConfig(
  scenario: string,
): Effect.Effect<
  ServerConfig.ServerConfig["Service"],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const safeScenario = scenario.replace(/[^a-z0-9_-]+/gi, "-");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectory({
      prefix: `t3-orchestration-v2-replay-${safeScenario}-`,
    });
    const stateDir = path.join(baseDir, "userdata");
    const logsDir = path.join(stateDir, "logs");
    const providerLogsDir = path.join(logsDir, "provider");
    const terminalLogsDir = path.join(logsDir, "terminals");
    const attachmentsDir = path.join(stateDir, "attachments");
    const environmentThemesDir = path.join(stateDir, "themes");
    const worktreesDir = path.join(baseDir, "worktrees");
    const providerStatusCacheDir = path.join(baseDir, "caches");

    for (const directory of [
      stateDir,
      logsDir,
      providerLogsDir,
      terminalLogsDir,
      attachmentsDir,
      environmentThemesDir,
      worktreesDir,
      providerStatusCacheDir,
    ]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }

    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: false,
      startupPresentation: "browser",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      stateDir,
      dbPath: path.join(stateDir, "state.sqlite"),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      settingsPath: path.join(stateDir, "settings.json"),
      providerStatusCacheDir,
      worktreesDir,
      attachmentsDir,
      browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
      environmentThemesDir,
      logsDir,
      serverLogPath: path.join(logsDir, "server.log"),
      serverTracePath: path.join(logsDir, "server.trace.ndjson"),
      providerLogsDir,
      providerEventLogPath: path.join(providerLogsDir, "events.log"),
      terminalLogsDir,
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
      environmentIdPath: path.join(stateDir, "environment-id"),
      serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
      secretsDir: path.join(stateDir, "secrets"),
      analysisDir: path.join(stateDir, "analysis"),
      computeDir: path.join(stateDir, "compute"),
      latexDir: path.join(stateDir, "latex"),
      documentArtifactsDir: path.join(stateDir, "document-artifacts"),
    };
  });
}

export interface OrchestratorV2ProviderReplayScenario<
  Transcript extends ProviderReplayTranscript = ProviderReplayTranscript,
> extends OrchestratorV2Scenario {
  readonly transcript: Transcript;
  readonly runtimePolicyOverride?: RuntimePolicy.RuntimePolicyV2Override;
}

export interface OrchestratorV2ProviderReplayHarness<
  Transcript extends ProviderReplayTranscript = ProviderReplayTranscript,
  Error = never,
> {
  readonly driver: ProviderDriverKind;
  readonly decodeTranscript: (
    transcript: ProviderReplayTranscript,
  ) => Effect.Effect<Transcript, Error>;
  readonly makeProviderAdapterRegistryLayer: (
    transcript: Transcript,
    options?: { readonly replayGate?: ProviderReplayGate },
  ) => Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2, Error>;
}

export function runOrchestratorV2ProviderReplayScenario<
  Transcript extends ProviderReplayTranscript,
  Error,
>(
  scenario: OrchestratorV2ProviderReplayScenario<Transcript>,
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
  options: {
    readonly databaseLayer?: Layer.Layer<
      SqlClient.SqlClient,
      | MigrationError
      | PlatformError.PlatformError
      | SqlError
      | ScientMigrationError
      | V2DatabaseImportError
    >;
    readonly runEffectWorker?: boolean;
    /** Exercise production session credential issuance; disabled for recorded transports. */
    readonly configureMcp?: boolean;
    readonly mcpSessionRegistryLayer?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
    /** Auth integration tests must supply the actual snapshot registry. */
    readonly providerRegistryLayer?: Layer.Layer<ProviderRegistry.ProviderRegistry>;
    readonly runtimePolicyLayer?: Layer.Layer<RuntimePolicy.RuntimePolicyV2>;
    // Start continuation runs for provider wake turns, as the live runtime does.
    // Off by default: most fixtures record no wake turn.
    readonly runContinuationWorker?: boolean;
    // Reconcile a previous runtime's state before the effect worker starts,
    // as server startup does after a crash or restart.
    readonly recoverOnStartup?: boolean;
    readonly continueThreadsAfterServerUpdate?: boolean;
    /** Existing conservative byte-policy fixtures can opt out of Scient preset budgets. */
    readonly contextHandoffPolicy?: "scient" | "byte";
  } = {},
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  | Orchestrator.OrchestratorV2Error
  | OrchestratorV2ScenarioStepError
  | Error
  | MigrationError
  | PlatformError.PlatformError
  | SqlError
  | ScientMigrationError
  | V2DatabaseImportError,
  never
> {
  const replayGate = makeProviderReplayGate(
    scenario.steps?.flatMap((step) =>
      step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting"
        ? [step.label]
        : [],
    ) ?? [],
  );
  const layer = makeOrchestratorV2ProviderReplayLayer(scenario, harness, {
    ...options,
    replayGate,
  });

  return runOrchestratorV2Scenario(scenario, { replayGate }).pipe(Effect.provide(layer));
}

export function makeOrchestratorV2ProviderReplayLayer<
  Transcript extends ProviderReplayTranscript,
  Error,
>(
  scenario: OrchestratorV2ProviderReplayScenario<Transcript>,
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
  options: {
    readonly databaseLayer?: Layer.Layer<
      SqlClient.SqlClient,
      | MigrationError
      | PlatformError.PlatformError
      | SqlError
      | ScientMigrationError
      | V2DatabaseImportError
    >;
    readonly runEffectWorker?: boolean;
    /** Exercise production session credential issuance; disabled for recorded transports. */
    readonly configureMcp?: boolean;
    readonly mcpSessionRegistryLayer?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
    /** Auth integration tests must supply the actual snapshot registry. */
    readonly providerRegistryLayer?: Layer.Layer<ProviderRegistry.ProviderRegistry>;
    // Start continuation runs for provider wake turns, as the live runtime does.
    // Off by default: most fixtures record no wake turn.
    readonly runContinuationWorker?: boolean;
    // Reconcile a previous runtime's state before the effect worker starts,
    // as server startup does after a crash or restart.
    readonly recoverOnStartup?: boolean;
    readonly continueThreadsAfterServerUpdate?: boolean;
    /** Existing conservative byte-policy fixtures can opt out of Scient preset budgets. */
    readonly contextHandoffPolicy?: "scient" | "byte";
    readonly replayGate?: ProviderReplayGate;
  } = {},
): Layer.Layer<
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProviderTurnStartService.ProviderTurnStartServiceV2
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectWorker.OrchestrationEffectWorkerV2
  | EventSink.EventSinkV2
  | EventStore.EventStoreV2
  | CheckpointService.CheckpointServiceV2
  | CheckpointStore.CheckpointStore
  | ConversationForks.ConversationForkService
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService,
  | Error
  | MigrationError
  | PlatformError.PlatformError
  | SqlError
  | ScientMigrationError
  | V2DatabaseImportError
> {
  const registryLayer = harness.makeProviderAdapterRegistryLayer(
    scenario.transcript,
    options.replayGate === undefined ? {} : { replayGate: options.replayGate },
  );
  return makeOrchestratorV2ReplayLayerWithRegistry(scenario, registryLayer, options);
}

export function makeOrchestratorV2ReplayLayerWithRegistry<Error>(
  scenario: Pick<OrchestratorV2ProviderReplayScenario, "name" | "runtimePolicyOverride">,
  registryLayer: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2, Error>,
  options: {
    /** Preserve one disposable profile across file-backed restart and recovery tests. */
    readonly serverConfigLayer?: Layer.Layer<ServerConfig.ServerConfig>;
    readonly serverSettingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>;
    readonly databaseLayer?: Layer.Layer<
      SqlClient.SqlClient,
      | MigrationError
      | PlatformError.PlatformError
      | SqlError
      | ScientMigrationError
      | V2DatabaseImportError
    >;
    readonly runEffectWorker?: boolean;
    /** Inject a fault around the production copier without replacing native provisioning. */
    readonly forkAttachmentCopierLayer?: typeof ScientForkAttachmentCopierLive;
    /** Run actual attachment cleanup on isolated test profiles. */
    readonly resourceCleanupLayer?: Layer.Layer<
      never,
      never,
      ServerConfig.ServerConfig | FileSystem.FileSystem
    >;
    /** Exercise native fork checkout with the production Git workflow. */
    readonly forkGitWorkflowLayer?: Layer.Layer<
      GitWorkflowService,
      never,
      ServerConfig.ServerConfig
    >;
    /** Exercise production session credential issuance; disabled for recorded transports. */
    readonly configureMcp?: boolean;
    readonly mcpSessionRegistryLayer?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
    /** Auth integration tests must supply the actual snapshot registry. */
    readonly providerRegistryLayer?: Layer.Layer<ProviderRegistry.ProviderRegistry>;
    readonly runtimePolicyLayer?: Layer.Layer<RuntimePolicy.RuntimePolicyV2>;
    // Start continuation runs for provider wake turns, as the live runtime does.
    // Off by default: most fixtures record no wake turn.
    readonly runContinuationWorker?: boolean;
    // Reconcile a previous runtime's state before the effect worker starts,
    // as server startup does after a crash or restart.
    readonly recoverOnStartup?: boolean;
    readonly continueThreadsAfterServerUpdate?: boolean;
    /** Existing conservative byte-policy fixtures can opt out of Scient preset budgets. */
    readonly contextHandoffPolicy?: "scient" | "byte";
  } = {},
): Layer.Layer<
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProviderTurnStartService.ProviderTurnStartServiceV2
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectWorker.OrchestrationEffectWorkerV2
  | EffectOutbox.EffectOutboxV2
  | EventSink.EventSinkV2
  | EventStore.EventStoreV2
  | CheckpointService.CheckpointServiceV2
  | CheckpointStore.CheckpointStore
  | ConversationForks.ConversationForkService
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService,
  | Error
  | MigrationError
  | PlatformError.PlatformError
  | SqlError
  | ScientMigrationError
  | V2DatabaseImportError
> {
  const serverConfigLayer =
    options.serverConfigLayer ??
    Layer.effect(
      ServerConfig.ServerConfig,
      makeReplayServerConfig(scenario.name).pipe(Effect.orDie),
    ).pipe(Layer.provide(NodeServices.layer));
  const runtimeLayer =
    options.runtimePolicyLayer ??
    (scenario.runtimePolicyOverride === undefined
      ? RuntimePolicy.layer
      : RuntimePolicy.layerWithOverride(scenario.runtimePolicyOverride).pipe(
          Layer.provide(RuntimePolicy.layer),
        ));
  const databaseLayer = options.databaseLayer ?? SqlitePersistenceMemory;
  // One queue shared by the adapters, the orchestrator, and the worker, like
  // runtimeLayer.ts; layer memoization keeps it a single instance.
  const continuationRequestsLayer =
    options.runContinuationWorker === true ? ProviderContinuationRequests.layer : Layer.empty;
  const providedRegistryLayer = registryLayer.pipe(Layer.provide(continuationRequestsLayer));
  const serverSettingsLayer =
    options.serverSettingsLayer ??
    ServerSettings.layerTest({
      responseStreamingMode: "turn",
      ...(options.continueThreadsAfterServerUpdate === undefined
        ? {}
        : { continueThreadsAfterServerUpdate: options.continueThreadsAfterServerUpdate }),
    }).pipe(Layer.orDie);
  const handoffSettingsLayer = Layer.merge(
    serverSettingsLayer,
    options.contextHandoffPolicy === "byte"
      ? Layer.succeed(ContextHandoffPolicyOverride, "byte")
      : Layer.empty,
  );
  const storesLayer = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    CommandReceiptStore.layer,
    EffectOutbox.layer,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provide(databaseLayer));
  const eventSinkProvided = EventSink.layerFromStores.pipe(
    Layer.provide(Layer.mergeAll(storesLayer, databaseLayer)),
  );
  const commandReceiptStoreProvided = CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer));
  const legacyImporterProvided = LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(eventSinkProvided, databaseLayer)),
  );
  const providerEventIngestorProvided = ProviderEventIngestor.layer.pipe(
    Layer.provide(Layer.mergeAll(storesLayer, eventSinkProvided, IdAllocator.layer)),
  );
  const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(serverConfigLayer),
    Layer.provide(NodeServices.layer),
  );
  const checkpointStoreLayer = CheckpointStore.layer.pipe(
    Layer.provide(vcsDriverRegistryLayer),
    Layer.provide(NodeServices.layer),
  );
  const checkpointServiceProvided = CheckpointService.layer.pipe(
    Layer.provide(Layer.mergeAll(checkpointStoreLayer, IdAllocator.layer)),
  );
  const contextHandoffServiceProvided = ContextHandoffService.layer.pipe(
    Layer.provide(Layer.mergeAll(IdAllocator.layer, handoffSettingsLayer)),
  );
  const persistenceLayer = Layer.mergeAll(
    storesLayer,
    eventSinkProvided,
    commandReceiptStoreProvided,
    IdAllocator.layer,
    providerEventIngestorProvided,
  );
  // Recorded transports have no snapshot instance registry. Unexpected auth
  // control must fail visibly; dedicated auth proofs provide the live registry.
  const snapshotRegistryLayer =
    options.providerRegistryLayer ??
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      ...makeProviderRegistryMock(),
      setProviderAuthenticationFailure: () =>
        Effect.die("Unexpected authentication invalidation in recorded provider replay."),
    });
  const providerSessionManagerProvided = ProviderSessionManager.layerWithOptions({
    configureMcp: options.configureMcp ?? false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        providedRegistryLayer,
        snapshotRegistryLayer,
        eventSinkProvided,
        IdAllocator.layer,
        options.mcpSessionRegistryLayer ?? McpSessionRegistryTestkit.layer,
        providerEventIngestorProvided,
        storesLayer,
      ),
    ),
  );
  const providerSwitchServiceProvided = ProviderSwitchService.layer.pipe(
    Layer.provide(Layer.mergeAll(providedRegistryLayer, runtimeLayer)),
  );
  const runExecutionServiceProvided = RunExecutionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceProvided,
        eventSinkProvided,
        IdAllocator.layer,
        providerEventIngestorProvided,
        serverSettingsLayer,
      ),
    ),
  );
  const providerTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        contextHandoffServiceProvided,
        handoffSettingsLayer,
        databaseLayer,
        eventSinkProvided,
        IdAllocator.layer,
        storesLayer,
        providerSessionManagerProvided,
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        runExecutionServiceProvided,
        runtimeLayer,
      ),
    ),
  );
  const providerTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
    Layer.provide(Layer.merge(storesLayer, providerSessionManagerProvided)),
  );
  const runtimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
    Layer.provide(Layer.merge(storesLayer, providerSessionManagerProvided)),
  );
  const checkpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceProvided,
        eventSinkProvided,
        IdAllocator.layer,
        storesLayer,
        providerSessionManagerProvided,
        runtimeLayer,
      ),
    ),
  );
  const checkpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(checkpointServiceProvided, eventSinkProvided, IdAllocator.layer, storesLayer),
    ),
  );
  const runFinalizationServiceProvided = RunFinalizationService.layer.pipe(
    Layer.provide(Layer.merge(checkpointCaptureServiceProvided, storesLayer)),
  );
  const threadTitleRegenerationTestLayer = Layer.succeed(
    ThreadTitleRegenerationService.ThreadTitleRegenerationService,
    ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
      execute: () => Effect.void,
    }),
  );
  const orchestratorProvided = Orchestrator.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        serverConfigLayer,
        checkpointServiceProvided,
        CommandPolicy.layer,
        contextHandoffServiceProvided,
        persistenceLayer,
        providedRegistryLayer,
        continuationRequestsLayer,
        runtimeLayer,
        providerSessionManagerProvided,
        providerSwitchServiceProvided,
        runExecutionServiceProvided,
        ThreadForkService.layer,
      ),
    ),
  );
  const threadManagementProvided = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
        getThreadProjection: orchestrator.getThreadProjection,
      });
    }),
  ).pipe(Layer.provide(orchestratorProvided));
  const continuationWorkerProvided =
    options.runContinuationWorker === true
      ? ProviderContinuationService.workerLive.pipe(
          Layer.provide(
            Layer.mergeAll(continuationRequestsLayer, threadManagementProvided, IdAllocator.layer),
          ),
        )
      : Layer.empty;
  const conversationForkProvided = ConversationForks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        storesLayer,
        eventSinkProvided,
        commandReceiptStoreProvided,
        threadCommandExecutorLayer,
        legacyImporterProvided,
        ScientForkCheckpointBaselineLive,
        options.forkAttachmentCopierLayer ?? ScientForkAttachmentCopierLive,
      ),
    ),
    Layer.provide(Layer.mergeAll(checkpointStoreLayer, serverConfigLayer, VcsProcess.layer)),
  );
  const effectExecutorProvided = EffectWorker.executorLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        options.resourceCleanupLayer?.pipe(
          Layer.provide(Layer.merge(serverConfigLayer, NodeServices.layer)),
        ) ?? Layer.empty,
        runFinalizationServiceProvided,
        checkpointRollbackServiceProvided,
        providerSessionManagerProvided,
        providerTurnControlServiceProvided,
        providerTurnStartServiceProvided,
        runtimeRequestServiceProvided,
        threadTitleRegenerationTestLayer,
        serverSettingsLayer,
        threadManagementProvided,
        conversationForkProvided,
      ),
    ),
  );
  const effectWorkerProvided = EffectWorker.layer.pipe(
    Layer.provide(Layer.merge(storesLayer, effectExecutorProvided)),
  );
  const replayRuntime = Layer.mergeAll(
    serverSettingsLayer,
    commandReceiptStoreProvided,
    checkpointServiceProvided,
    checkpointStoreLayer,
    legacyImporterProvided,
    serverConfigLayer,
    conversationForkProvided,
    storesLayer,
    orchestratorProvided,
    providerSessionManagerProvided,
    providerTurnStartServiceProvided,
    effectWorkerProvided,
    eventSinkProvided,
    continuationWorkerProvided,
  ).pipe(
    Layer.provide(
      Layer.merge(
        worktreeRepairDependenciesTestLayer,
        (options.forkGitWorkflowLayer ?? Layer.empty).pipe(Layer.provide(serverConfigLayer)),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

  // Build the daemon from the exact worker instance exposed alongside the
  // orchestrator. Keeping this acquisition in the replay layer makes the
  // outbox lifecycle explicit and prevents test-only command-side draining.
  if (options.runEffectWorker === false) {
    return replayRuntime;
  }
  // Built before the runtime it shares stores with, so recovery commits before
  // the effect worker claims anything, as in serverRuntimeStartup.
  const startupRecovery: Layer.Layer<
    never,
    | MigrationError
    | PlatformError.PlatformError
    | SqlError
    | ScientMigrationError
    | V2DatabaseImportError
  > =
    options.recoverOnStartup === true
      ? Layer.effectDiscard(
          ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService.use(
            (recovery) => recovery.recover,
          ).pipe(Effect.orDie),
        ).pipe(
          Layer.provide(ProviderRuntimeRecoveryService.layer),
          Layer.provide(
            Layer.mergeAll(storesLayer, eventSinkProvided, IdAllocator.layer, serverSettingsLayer),
          ),
        )
      : Layer.empty;
  return Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
      return orchestrator;
    }),
  ).pipe(Layer.provideMerge(replayRuntime), Layer.provide(startupRecovery));
}
