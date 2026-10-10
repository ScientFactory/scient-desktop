// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  type DeviceServiceState,
  AuthAccessTokenType,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadLaunchInput,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ShellStreamItem,
  DEFAULT_SERVER_SETTINGS,
  DroidSettings,
  type CustomModelsSettings,
  EnvironmentFilePath,
  type DpopFailureReason,
  EnvironmentId,
  EventId,
  TurnItemId,
  ThreadSectionId,
  GitCommandError,
  VcsUnsupportedOperationError,
  VcsCheckpointUnavailableError,
  KeybindingRule,
  MessageId,
  ExternalLauncherCommandNotFoundError,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2HttpThreadBoundedSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2TurnItem,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
  COMPACT_THREAD_SNAPSHOT_FORMAT,
  THREAD_SNAPSHOT_FORMAT_HEADER,
  OrchestrationV2ThreadHistoryPage,
  TerminalNotRunningError,
  TextGenerationError,
  OrchestrationDispatchCommandError,
  ScientThreadQueueOperationError,
  ScientThreadQueueSnapshot,
  ORCHESTRATION_WS_METHODS,
  type PreviewEvent,
  ProjectId,
  type ProviderAuthState,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderInstallState,
  ProviderSetupError,
  ResolvedKeybindingRule,
  type ServerProvider,
  type ServerLifecycleStreamEvent,
  ThreadId,
  RunId,
  TurnId,
  UsageLimitSourceId,
  WS_METHODS,
  WsRpcGroup,
  type WorktreeSetupSnapshot,
  EditorId,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { RELAY_HEALTH_REQUEST_TYP, RELAY_MINT_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import * as RelayClient from "@t3tools/shared/relayClient";
import {
  projectedSubagentsToRuntime,
  deriveAgentPanelModel,
} from "../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { applyOrchestrationV2ProjectionEvent } from "../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import { projectThreadProjectionForWire } from "./orchestration-v2/WireProjection.ts";
import { historicalSubagentsToRuntime } from "../../../packages/client-runtime/src/state/historicalSubagentRuntime.ts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, beforeAll, vi } from "vite-plus/test";

const decodeWorkflowSubagent = Schema.decodeUnknownSync(OrchestrationV2SubagentJson);
const encodeWorkflowSubagent = Schema.encodeSync(OrchestrationV2SubagentJson);
const decodeWorkflowTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const SUCCESSFUL_GIT_EXECUTION = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const decodeTransferThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2HttpThreadBoundedSnapshot)),
);
const decodeLegacyThreadBoundedSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const encodeTurnItemJson = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
const decodeQueueOperationError = Schema.decodeUnknownEffect(ScientThreadQueueOperationError);
const decodeQueueSnapshot = Schema.decodeUnknownEffect(ScientThreadQueueSnapshot);
const decodeSnapshotWireAssertions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      snapshotFormat: Schema.optionalKey(Schema.String),
      projection: Schema.Struct({
        turnItems: Schema.Array(Schema.Unknown),
        visibleTurnItems: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    }),
  ),
);
const decodeTransferHistoryPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage)),
);
const decodeTransferShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellSnapshot)),
);
const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// The server-router suite exercises the inherited cloud protocol directly.
// Opt this test file into the otherwise-disabled D4 routes and restore the
// caller's environment when the file completes; this test-only switch does
// not make public cloud configuration appear in the route builder.
const previousScientNextCloudRouteTest = process.env.SCIENT_NEXT_CLOUD_ROUTE_TEST;
const previousNodeEnv = process.env.NODE_ENV;
beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.SCIENT_NEXT_CLOUD_ROUTE_TEST = "true";
});
afterAll(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousScientNextCloudRouteTest === undefined)
    delete process.env.SCIENT_NEXT_CLOUD_ROUTE_TEST;
  else process.env.SCIENT_NEXT_CLOUD_ROUTE_TEST = previousScientNextCloudRouteTest;
});

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ServerConfig from "./config.ts";
import type { DroidAcpRuntime } from "./provider/acp/DroidAcpSupport.ts";
import { droidCustomModelId } from "./provider/droid/DroidCustomModels.ts";
import { makeDroidTextGeneration } from "./textGeneration/DroidTextGeneration.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { HTTP_ROUTER_CONFIG, layerMakeRoutes } from "./server.ts";
import {
  coalesceProviderStatusUpdates,
  resolveAvailableEditorsForConfig,
  resolveFileManagerRevealKindForConfig,
} from "./ws.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as OrchestratorV2 from "./orchestration-v2/Orchestrator.ts";
import * as ThreadManagementV2 from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchV2 from "./orchestration-v2/ThreadLaunchService.ts";
import * as EventSinkV2 from "./orchestration-v2/EventSink.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStoreV2 from "./orchestration-v2/ProjectStore.ts";
import * as EffectWorkerV2 from "./orchestration-v2/EffectWorker.ts";
import * as EffectOutboxV2 from "./orchestration-v2/EffectOutbox.ts";
import * as ConversationFork from "./orchestration-v2/scient-fork/ConversationForkService.ts";
import * as ProviderSessionsV2 from "./orchestration-v2/ProviderSessionManager.ts";
import * as IdAllocatorV2 from "@t3tools/provider-core/server/IdAllocator";
import * as CommandReceiptsV2 from "./orchestration-v2/CommandReceiptStore.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ResourceCleanupV2 from "./orchestration-v2/ResourceCleanupService.ts";
import * as ThreadSearchV2 from "./orchestration-v2/ThreadSearch.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderLifecycleCoordinator from "./scient/providerLifecycle/ProviderLifecycleCoordinator.ts";
import * as McpSessionRegistryTestkit from "./mcp/McpSessionRegistry.testkit.ts";
import * as OrchestrationRuntime from "./orchestration-v2/runtimeLayer.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import {
  threadCreated as transferV2ThreadCreated,
  turnEvents as transferV2TurnEvents,
  THREAD_ID as transferV2ThreadId,
} from "../integration/TransferBudgetV2Fixture.integration.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { layer as orchestrationEventStoreLayer } from "./persistence/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "./persistence/OrchestrationEventStore.ts";
import type { ProviderVoiceTranscriptCorrection } from "./provider/ScientProviderInstanceSeams.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeNativeSessionAdapterV2 } from "./orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ModelManifest from "./provider/ModelManifest.ts";
import {
  ProviderAuthService,
  type ProviderAuthController,
} from "./provider/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import {
  AntigravityInstallation,
  AntigravityInstallationError,
} from "./provider/AntigravityInstallation.ts";
import { CodexInstallation } from "./provider/CodexInstallation.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as StorageCleanup from "./storageCleanup.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import { ASSET_ROUTE_PREFIX } from "./assets/AssetAccess.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as GeneratedDocumentStore from "./scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as WorkspaceBindingResolver from "./scient/projectScope/WorkspaceBindingResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriver from "./vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as ServerSourceControlHost from "./sourceControl/ServerSourceControlHost.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import * as CloudLink from "./cloud/CloudLink.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as Data from "effect/Data";
import { registerAnalysisRpcTests } from "./scient/analysis/AnalysisRpcServerTests.ts";
import { registerComputeRpcTests } from "./scient/compute/ComputeRpcServerTests.ts";
import { registerMarkdownTransportTests } from "./scient/markdown/MarkdownTransportServerTests.ts";

import {
  measureHttpGet,
  attributeSnapshotTransfer,
  openMeasuredWsClient,
  transferDelta,
} from "../integration/NetworkTransferMeasurement.integration.ts";
import { THREAD_HISTORY_PAGE_POLICY } from "./orchestration-v2/threadHistoryPaging.ts";
import { makeSqlStatementCounter } from "../integration/SqlStatementCounter.integration.ts";
import {
  awaitSubscriptionSynchronized,
  collectQueueUntil,
  expectedMeasuredAssistantText,
  commitMeasuredTransferTurn,
  seedTransferBudgetHistory,
  subscribeShellItems,
  subscribeThreadItems,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_THREAD_ID,
} from "../integration/TransferBudgetScenario.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  type TransferBudgetRun,
  transferBudgetViolations,
} from "../integration/TransferBudgetReport.integration.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { DEFAULT_SIGNAL_EXPORT, layerOtlpSerialization } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const nativeAdmissionInstance: ProviderInstance = {
  instanceId: defaultModelSelection.instanceId,
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
  displayName: "Synthetic Codex admission",
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: "synthetic-codex",
  },
  orchestrationAdapter: {
    instanceId: defaultModelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("This route fixture must not open a provider session"),
  },
  snapshot: {
    getSnapshot: Effect.succeed({
      instanceId: defaultModelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "synthetic",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    }),
    refresh: Effect.die("Native admission must not refresh the provider"),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: ProviderDriverKind.make("codex"),
          packageName: null,
        }),
      ),
  },
  get textGeneration(): never {
    throw new Error("Native admission must not generate text");
  },
};

const providerSetupInstanceId = ProviderInstanceId.make("antigravity-custom-profile");
const providerSetupDriver = ProviderDriverKind.make("antigravity");
const providerSetupInstallState: ProviderInstallState = {
  driver: providerSetupDriver,
  operationId: "install-operation",
  phase: "downloading",
  downloadedBytes: 128,
  totalBytes: 256,
  version: "test-release",
  installedVersion: null,
  canRemove: false,
  message: null,
};
const providerSetupAuthState: ProviderAuthState = {
  instanceId: providerSetupInstanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
const providerSetupInstance: ProviderInstance = {
  instanceId: providerSetupInstanceId,
  driverKind: providerSetupDriver,
  enabled: false,
  displayName: "Google account",
  continuationIdentity: {
    driverKind: providerSetupDriver,
    continuationKey: providerSetupInstanceId,
  },
  get orchestrationAdapter(): never {
    throw new Error("Provider setup must not start a V2 chat session.");
  },
  get snapshot(): never {
    throw new Error("Installation routing must not probe the provider.");
  },
  get textGeneration(): never {
    throw new Error("Provider setup must not generate text.");
  },
};

const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const makeAuthTestLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
        getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
      }),
    ),
  );

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    // The exporter's batch fiber is forked while the layer builds and ticks on
    // a wall-clock interval, so the whole tracer runs on the live clock.
    yield* Layer.build(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3code-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    ).pipe(
      Effect.flatMap((tracing) =>
        Effect.void.pipe(Effect.withSpan(spanName), Effect.provideContext(tracing)),
      ),
      TestClock.withLive,
    );

    const request = yield* Effect.raceFirst(
      Effect.promise(() => collector.firstRequest).pipe(Effect.orDie),
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.andThen(Effect.die(new Error("Timed out waiting for OTLP trace export"))),
      ),
    );
    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  onPairingChangesSubscribed?: Effect.Effect<void>;
  config?: Partial<ServerConfig.ServerConfig["Service"]>;
  transformThreadManagementV2?: (
    threads: ThreadManagementV2.ThreadManagementService["Service"],
  ) => ThreadManagementV2.ThreadManagementService["Service"];
  transformThreadLaunchV2?: (
    launch: ThreadLaunchV2.ThreadLaunchService["Service"],
  ) => ThreadLaunchV2.ThreadLaunchService["Service"];
  transformApplicationEventStore?: (
    events: OrchestrationEventStore["Service"],
  ) => OrchestrationEventStore["Service"];
  layers?: {
    keybindings?: Partial<Keybindings.Keybindings["Service"]>;
    environmentTheme?: Partial<EnvironmentTheme.EnvironmentThemeService["Service"]>;
    providerRegistry?: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
    modelManifest?: Partial<ModelManifest.ModelManifest["Service"]>;
    providerLatestVersions?: ProviderLatestVersions.ProviderLatestVersions["Service"];
    usageLimitSources?: Partial<UsageLimitSources.UsageLimitSources["Service"]>;
    providerAuth?: Partial<ProviderAuthService["Service"]>;
    providerInstanceRegistry?: Partial<ProviderInstanceRegistry["Service"]>;
    antigravityInstallation?: Partial<AntigravityInstallation["Service"]>;
    codexInstallation?: Partial<CodexInstallation["Service"]>;
    serverSettings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher["Service"]>;
    vcsDriver?: Partial<VcsDriver.VcsDriver["Service"]>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry["Service"]>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
    gitManager?: Partial<GitManager.GitManager["Service"]>;
    sourceControlRepositoryService?: Partial<
      SourceControlRepositoryService.SourceControlRepositoryService["Service"]
    >;
    reviewService?: Partial<ReviewService.ReviewService["Service"]>;
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>;
    projectSetupScriptRunner?: Partial<
      ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
    >;
    terminalManager?: Partial<TerminalManager.TerminalManager["Service"]>;
    threadManagementV2?: Partial<ThreadManagementV2.ThreadManagementService["Service"]>;
    applicationEventStore?: Partial<OrchestrationEventStore["Service"]>;
    analyticsService?: Partial<AnalyticsService.AnalyticsService["Service"]>;
    conversationFork?: Partial<ConversationFork.ConversationForkService["Service"]>;
    checkpointDiffQuery?: Partial<CheckpointDiffQuery.CheckpointDiffQuery["Service"]>;
    browserTraceCollector?: Partial<BrowserTraceCollector.BrowserTraceCollector["Service"]>;
    serverLifecycleEvents?: Partial<ServerLifecycleEvents.ServerLifecycleEvents["Service"]>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartup.ServerRuntimeStartup["Service"]>;
    serverEnvironment?: Partial<ServerEnvironment.ServerEnvironment["Service"]>;
    workspaceBindingResolver?: Partial<
      WorkspaceBindingResolver.WorkspaceBindingResolver["Service"]
    >;
    repositoryIdentityResolver?: Partial<
      RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]
    >;
    cloudManagedEndpointRuntime?: Partial<
      CloudManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]
    >;
    relayClient?: Partial<RelayClient.RelayClient["Service"]>;
    agentAwarenessRelay?: Partial<AgentAwarenessRelay.AgentAwarenessRelay["Service"]>;
    cloudCliTokenManager?: Partial<CloudCliTokenManager.CloudCliTokenManager["Service"]>;
    httpClient?: HttpClient.HttpClient;
    nativeTelemetryClient?: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;
    desktopTelemetryReceiver?: Partial<
      DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]
    >;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otelEnvironment: OtelEnvironment.none,
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...options?.config,
    };
    const layerConfig = ServerConfig.layer(config);
    const defaultVcsDriver: VcsDriver.VcsDriver["Service"] = {
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    };
    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.filterOrElse(
            (repository) => repository !== null,
            () =>
              defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                Effect.map((isInsideWorkTree) =>
                  isInsideWorkTree
                    ? {
                        kind: "git" as const,
                        rootPath: input.cwd,
                        metadataPath: null,
                        freshness: {
                          source: "live-local" as const,
                          observedAt: TEST_EPOCH,
                          expiresAt: Option.none(),
                        },
                      }
                    : null,
                ),
              ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    });
    const serverSettingsLayer = Layer.mock(ServerSettings.ServerSettingsService)({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
      committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
      ...options?.layers?.serverSettings,
    });
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    });
    const gitManagerLayer = Layer.mock(GitManager.GitManager)({
      ...options?.layers?.gitManager,
    });
    const workspaceEntriesLayer = WorkspaceEntries.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provideMerge(vcsDriverRegistryLayer),
    );
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(workspaceEntriesLayer),
      ),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer,
    );
    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
      Layer.provideMerge(gitManagerLayer),
    );
    const vcsProvisioningLayer = VcsProvisioningService.layer.pipe(
      Layer.provide(vcsDriverRegistryLayer),
    );
    const reviewLayer = options?.layers?.reviewService
      ? Layer.mock(ReviewService.ReviewService)({
          ...options.layers.reviewService,
        })
      : ReviewService.layer.pipe(
          Layer.provideMerge(gitVcsDriverLayer),
          Layer.provide(vcsDriverRegistryLayer),
        );
    const vcsStatusBroadcasterLayer = options?.layers?.vcsStatusBroadcaster
      ? Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          ...options.layers.vcsStatusBroadcaster,
        })
      : VcsStatusBroadcaster.layer.pipe(Layer.provide(gitWorkflowLayer));
    const resourceTelemetryLayer = ResourceTelemetry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NativeTelemetryClient.layerTest(options?.layers?.nativeTelemetryClient),
          DesktopTelemetryReceiver.layerTest(options?.layers?.desktopTelemetryReceiver),
          ResourceAttribution.layer,
        ),
      ),
    );
    const serviceLauncherClientLayer = ServiceLauncherClient.layer.pipe(
      Layer.provide(Layer.succeed(HostProcess.Environment, {})),
    );
    const workspaceBindingResolverLayer = Layer.succeed(
      WorkspaceBindingResolver.WorkspaceBindingResolver,
      WorkspaceBindingResolver.WorkspaceBindingResolver.of({
        resolveWorkspaceRoot: () => Effect.die("Workspace root resolution is not stubbed"),
        assertCurrentWorkspaceScope: () => Effect.die("Workspace root revalidation is not stubbed"),
        resolveThread: () => Effect.die("Workspace binding resolution is not stubbed"),
        resolveTrustedChild: () => Effect.die("Workspace child binding resolution is not stubbed"),
        assertCurrentThreadScope: () => Effect.die("Workspace binding revalidation is not stubbed"),
        diagnosticsForThread: () => Effect.die("Workspace binding diagnostics are not stubbed"),
        ...options?.layers?.workspaceBindingResolver,
      }),
    );

    const servedRoutesLayer = HttpRouter.serve(
      // All routes use this fixture's synthetic, scoped in-memory database.
      layerMakeRoutes.pipe(
        Layer.provide(Layer.mergeAll(serviceLauncherClientLayer, SqlitePersistence.layerMemory)),
      ),
      {
        disableListenLog: true,
        disableLogger: true,
        routerConfig: HTTP_ROUTER_CONFIG,
      },
    )
      .pipe(
        Layer.provideMerge(
          Layer.effectContext(
            Layer.build(
              Layer.mergeAll(
                OrchestrationRuntime.layerProduction,
                OrchestrationRuntime.layerEventSink,
                ProjectionStoreV2.layer,
              ).pipe(Layer.provideMerge(ProjectStoreV2.layer)),
            ).pipe(
              Effect.flatMap((context) =>
                Effect.gen(function* () {
                  const threads = Context.get(context, ThreadManagementV2.ThreadManagementService);
                  const events = Context.get(context, OrchestrationEventStore);
                  const forks = Context.get(context, ConversationFork.ConversationForkService);
                  let launch = Context.get(context, ThreadLaunchV2.ThreadLaunchService);
                  if (options?.layers?.projectSetupScriptRunner !== undefined) {
                    // The production runtime owns its real setup service. For a
                    // controlled terminal boundary, build the actual launch
                    // service with the same native stores and management instance.
                    const controlled = yield* Layer.build(ThreadLaunchV2.layer).pipe(
                      Effect.provideService(
                        ProjectService.ProjectService,
                        Context.get(context, ProjectService.ProjectService),
                      ),
                      Effect.provideService(ThreadManagementV2.ThreadManagementService, threads),
                      Effect.provideService(
                        CommandReceiptsV2.CommandReceiptStoreV2,
                        Context.get(context, CommandReceiptsV2.CommandReceiptStoreV2),
                      ),
                      Effect.provideService(
                        ManagedProjectFolders.ManagedProjectFolders,
                        Context.get(context, ManagedProjectFolders.ManagedProjectFolders),
                      ),
                      Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
                        runForThread: () => Effect.succeed({ status: "no-script" as const }),
                        ...options.layers.projectSetupScriptRunner,
                      }),
                      Effect.provide(IdAllocatorV2.layer),
                    );
                    launch = Context.get(controlled, ThreadLaunchV2.ThreadLaunchService);
                  }
                  const cleanupContext = yield* Layer.build(StorageCleanup.layer).pipe(
                    Effect.provide(context),
                  );
                  context = Context.add(
                    context,
                    ThreadLaunchV2.ThreadLaunchService,
                    options?.transformThreadLaunchV2?.(launch) ?? launch,
                  );
                  return Context.merge(
                    cleanupContext,
                    Context.add(
                      Context.add(
                        Context.add(context, ConversationFork.ConversationForkService, {
                          ...forks,
                          ...options?.layers?.conversationFork,
                        }),
                        ThreadManagementV2.ThreadManagementService,
                        {
                          ...(options?.transformThreadManagementV2?.(threads) ?? threads),
                          ...options?.layers?.threadManagementV2,
                        },
                      ),
                      OrchestrationEventStore,
                      {
                        ...(options?.transformApplicationEventStore?.(events) ?? events),
                        ...options?.layers?.applicationEventStore,
                      },
                    ),
                  );
                }),
              ),
            ),
          ).pipe(
            Layer.provide(ResourceCleanupV2.layer),
            Layer.provideMerge(ProjectEnrichmentService.layer),
            Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcsDriverRegistryLayer))),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Keybindings.Keybindings)({
              loadConfigState: Effect.succeed({
                keybindings: [],
                issues: [],
              }),
              streamChanges: Stream.empty,
              ...options?.layers?.keybindings,
            }),
            Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
              current: Effect.succeed([]),
              streamChanges: Stream.empty,
              ...options?.layers?.environmentTheme,
            }),
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.succeed([]),
              streamChanges: Stream.make([]),
              refresh: Effect.void,
              ...options?.layers?.usageLimitSources,
            }),
          ),
        ),
        Layer.provideMerge(orchestrationEventStoreLayer),
        Layer.provideMerge(ProjectStoreV2.layer),
        Layer.provide(
          Layer.mergeAll(
            ThreadSearchV2.layer,
            TextGeneration.layer,
            ProviderLifecycleCoordinator.layer,
            AcpRegistryRuntimeCoordinator.layer,
            McpSessionRegistryTestkit.layer,
            Layer.mock(AcpRegistryCatalog)({
              search: () => Effect.succeed({ agents: [] }),
              inspect: () => Effect.succeed({ status: "unconfigured" }),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            discover: Effect.succeed([]),
            resolveLink: () =>
              Effect.die("Source control title links are not stubbed in this test"),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ModelManifest.ModelManifest)({
              forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
              ...options?.layers?.modelManifest,
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([]),
              refresh: () => Effect.succeed([]),
              refreshInstance: () => Effect.succeed([]),
              refreshInstanceAfterAccountChange: () => Effect.succeed([]),
              reloadInstance: () => Effect.succeed([]),
              getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
                ),
              getProviderConnectionActionsForInstance: () => Effect.succeed(undefined),
              getProviderManagedRuntimeActionsForInstance: () => Effect.succeed(undefined),
              getVoiceTranscriptCorrectionForInstance: () =>
                // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Exact optional return requires undefined, not void.
                Effect.succeed<ProviderVoiceTranscriptCorrection | undefined>(undefined),
              setProviderManagedRuntimeSummary: () => Effect.succeed([]),
              setProviderMaintenanceActionState: () => Effect.succeed([]),
              setProviderConnectionOperation: () => Effect.succeed([]),
              setProviderAuthenticationFailure: () => Effect.succeed([]),
              streamChanges: Stream.empty,
              ...options?.layers?.providerRegistry,
            }),
            Layer.mock(ProviderAuthService)({
              ...options?.layers?.providerAuth,
            }),
            Layer.mock(ProviderInstanceRegistry)({
              getInstance: () => Effect.undefined,
              listInstances: Effect.succeed([]),
              ...options?.layers?.providerInstanceRegistry,
            }),
            Layer.mock(CodexInstallation)({
              managedDirectory: "unused-test-codex-runtime",
              ...options?.layers?.codexInstallation,
            }),
            Layer.mock(AntigravityInstallation)({
              managedDirectory: "unused-test-antigravity-runtime",
              ...options?.layers?.antigravityInstallation,
            }),
            Layer.mock(DeviceService.DeviceService)({
              state: Effect.succeed(EMPTY_DEVICE_STATE),
              currentReadiness: () => Effect.succeed(null),
              sessionsForThread: () => Effect.succeed([]),
            }),
          ),
        ),
        Layer.provide(serverSettingsLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ExternalLauncher.ExternalLauncher)({
              resolveAvailableEditors: () => Effect.succeed([]),
              resolveFileManagerRevealKind: () => Effect.undefined,
              ...options?.layers?.externalLauncher,
            }),
            Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
              resolveTargets: () => Effect.succeed([]),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
            read: Effect.succeed({
              serverPid: process.pid,
              readAt: TEST_EPOCH,
              processCount: 0,
              totalRssBytes: 0,
              totalCpuPercent: 0,
              processes: [],
              error: Option.none(),
            }),
            signal: (input) =>
              Effect.succeed({
                pid: input.pid,
                signal: input.signal,
                signaled: true,
                message: Option.none(),
              }),
          }),
        ),
        Layer.provide([
          HostResources.layer,
          Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
            readHistory: (input) =>
              Effect.succeed({
                readAt: TEST_EPOCH,
                windowMs: input.windowMs,
                bucketMs: input.bucketMs,
                sampleIntervalMs: 5_000,
                retainedSampleCount: 0,
                totalCpuSecondsApprox: 0,
                buckets: [],
                topProcesses: [],
                error: Option.none(),
              }),
          }),
        ]),
      )
      .pipe(
        Layer.provide(
          Layer.mock(TraceDiagnostics.TraceDiagnostics)({
            read: () =>
              Effect.succeed({
                traceFilePath: "",
                scannedFilePaths: [],
                readAt: TEST_EPOCH,
                recordCount: 0,
                parseErrorCount: 0,
                firstSpanAt: Option.none(),
                lastSpanAt: Option.none(),
                failureCount: 0,
                interruptionCount: 0,
                slowSpanThresholdMs: 1_000,
                slowSpanCount: 0,
                logLevelCounts: {},
                topSpansByCount: [],
                slowestSpans: [],
                commonFailures: [],
                latestFailures: [],
                latestWarningAndErrorLogs: [],
                partialFailure: Option.none(),
                error: Option.none(),
              }),
          }),
        ),
        Layer.provide(gitManagerLayer),
        Layer.provide(gitVcsDriverLayer),
        Layer.provide(gitWorkflowLayer),
        Layer.provide(reviewLayer),
        Layer.provide(vcsProvisioningLayer),
        Layer.provide(
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
            ...options?.layers?.sourceControlRepositoryService,
          }),
        ),
        Layer.provideMerge(vcsStatusBroadcasterLayer),
        Layer.provide(
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
            ...options?.layers?.projectSetupScriptRunner,
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(TerminalManager.TerminalManager)({
              hasRunningSessionsForThread: () => Effect.succeed(false),
              subscribeMetadata: (listener) =>
                listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => undefined)),
              ...options?.layers?.terminalManager,
            }),
            WorktreeSetupTracker.layer,
            ProjectCloneTracker.layer.pipe(
              Layer.provide(
                Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
                  ...options?.layers?.sourceControlRepositoryService,
                }),
              ),
            ),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PreviewManager.PreviewManager)({
              open: () => Effect.die("PreviewManager not stubbed in this test"),
              navigate: () => Effect.die("PreviewManager not stubbed in this test"),
              resize: () => Effect.die("PreviewManager not stubbed in this test"),
              reportStatus: () => Effect.void,
              refresh: () => Effect.void,
              close: () => Effect.void,
              list: () => Effect.succeed({ sessions: [], serverEpoch: "test-server", revision: 0 }),
              events: Stream.empty,
              subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            }),
            Layer.mock(PortScanner.PortDiscovery)({
              scan: () => Effect.succeed([]),
              subscribe: () => Effect.void,
              retain: Effect.void,
              registerTerminalProcesses: () => Effect.void,
              unregisterTerminal: () => Effect.void,
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({
              start: () => Effect.void,
              drain: Effect.void,
              requestSync: () => Effect.void,
            }),
          ),
        ),
      )
      .pipe(
        Layer.provide(
          Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
            getTurnDiff: () =>
              Effect.succeed({
                threadId: defaultThreadId,
                fromTurnCount: 0,
                toTurnCount: 0,
                diff: "",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: defaultThreadId,
                fromTurnCount: 0,
                toTurnCount: 0,
                diff: "",
              }),
            ...options?.layers?.checkpointDiffQuery,
          }),
        ),
      );

    const appLayer = servedRoutesLayer
      .pipe(
        Layer.provide(CloudLink.layer),
        Layer.provide(DirectEndpoints.layer),
        Layer.provide(workspaceBindingResolverLayer),
        Layer.provide(GeneratedDocumentStore.layer),
        Layer.provide(resourceTelemetryLayer),
        Layer.provide(UsageService.layerTest),
        Layer.provide(
          Layer.mock(AnalyticsService.AnalyticsService)({
            record: () => Effect.void,
            flush: Effect.void,
            ...options?.layers?.analyticsService,
          }),
        ),
        Layer.provide(
          Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
            record: () => Effect.void,
            ...options?.layers?.browserTraceCollector,
          }),
        ),
        Layer.provide(layerOtlpSerialization(config.otlpTracesExport.protocol)),
        Layer.provide(
          Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
            publish: (event) => Effect.succeed({ ...event, sequence: 1 }),
            snapshot: Effect.succeed({ sequence: 0, events: [] }),
            stream: Stream.empty,
            ...options?.layers?.serverLifecycleEvents,
          }),
        ),
        Layer.provide(
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            awaitCommandReady: Effect.void,
            markHttpListening: Effect.void,
            enqueueCommand: (effect) => effect,
            ...options?.layers?.serverRuntimeStartup,
          }),
        ),
        Layer.provide(
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            reportClientActivity: () => Effect.void,
            removeRpcClient: () => Effect.void,
            reportHostPowerState: () => Effect.void,
            snapshot: Effect.succeed({
              hostPower: {
                source: "unknown",
                idle: "unknown",
                idleSeconds: null,
                locked: "unknown",
                suspended: false,
                onBattery: "unknown",
                lowPowerMode: "unknown",
                thermalState: "unknown",
                stale: true,
                updatedAt: TEST_EPOCH,
              },
              leases: [],
              activeForegroundLeaseCount: 0,
              activeScopeKeys: [],
              shouldRunOpportunisticWork: false,
              updatedAt: TEST_EPOCH,
            }),
            streamChanges: Stream.empty,
            subscribe: Effect.succeed({
              latest: {
                hostPower: {
                  source: "unknown",
                  idle: "unknown",
                  idleSeconds: null,
                  locked: "unknown",
                  suspended: false,
                  onBattery: "unknown",
                  lowPowerMode: "unknown",
                  thermalState: "unknown",
                  stale: true,
                  updatedAt: TEST_EPOCH,
                },
                leases: [],
                activeForegroundLeaseCount: 0,
                activeScopeKeys: [],
                shouldRunOpportunisticWork: false,
                updatedAt: TEST_EPOCH,
              },
              changes: Stream.empty,
            }),
            hasDemand: () => Effect.succeed(false),
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
            getDescriptor: Effect.succeed(testEnvironmentDescriptor),
            ...options?.layers?.serverEnvironment,
          }),
        ),
        Layer.provide(
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () => Effect.succeed(null),
            ...options?.layers?.repositoryIdentityResolver,
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              CloudManagedEndpointRuntime.CloudManagedEndpointRuntime,
              CloudManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
                applyConfig: () => Effect.succeed({ status: "disabled" }),
                // Managed endpoint recovery stays inert in tests: no requests, no
                // side effects, and the link-state lock is a pass-through.
                recoveryRequests: Stream.empty,
                tunnelConnected: Stream.empty,
                requestRecovery: () => Effect.void,
                withLinkStateLock: (effect) => effect,
                ...options?.layers?.cloudManagedEndpointRuntime,
              }),
            ),
            // Upstream applies relay config through this relay; the mock keeps
            // that a no-op so no test reaches the awareness channel.
            Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({
              requestCatchUp: () => Effect.void,
              ...options?.layers?.agentAwarenessRelay,
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            RelayClient.RelayClient,
            RelayClient.RelayClient.of({
              resolve: Effect.succeed({
                status: "missing",
                version: RelayClient.CLOUDFLARED_VERSION,
              }),
              install: Effect.die("unused relay-client install"),
              installWithProgress: () => Effect.die("unused relay-client install"),
              pruneManagedVersions: Effect.die("unused relay-client prune"),
              ...options?.layers?.relayClient,
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(CloudCliTokenManager.CloudCliTokenManager)({
            get: Effect.die(new Error("Unexpected T3 Connect CLI authorization request.")),
            getExisting: Effect.succeed(Option.none()),
            hasCredential: Effect.succeed(false),
            clear: Effect.void,
            ...options?.layers?.cloudCliTokenManager,
          }),
        ),
      )
      .pipe(
        Layer.updateService(PairingGrantStore.PairingGrantStore, (grants) => {
          const subscribed = options?.onPairingChangesSubscribed;
          if (!subscribed) return grants;
          return {
            ...grants,
            streamChanges: Stream.unwrap(
              Effect.gen(function* () {
                const changes =
                  yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
                yield* grants.streamChanges.pipe(
                  Stream.runForEach((change) => Queue.offer(changes, change)),
                  Effect.forkScoped({ startImmediately: true }),
                );
                yield* subscribed;
                return Stream.fromQueue(changes);
              }),
            ),
          };
        }),
        Layer.provideMerge(makeAuthTestLayer()),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(workspaceAndProjectServicesLayer),
      )
      .pipe(
        // Reuse the same fixture owners for dependencies introduced by later layers.
        Layer.provide(gitVcsDriverLayer),
        Layer.provide(serverSettingsLayer),
      )
      .pipe(
        // Honour an injected client so relay-route tests can stub the upstream
        // response instead of reaching the network. Without this the option is
        // silently ignored and the cloud seam tests exercise the real client.
        Layer.provideMerge(
          options?.layers?.httpClient === undefined
            ? FetchHttpClient.layer
            : Layer.succeed(HttpClient.HttpClient, options.layers.httpClient),
        ),
        Layer.provide(
          GitHubApi.layerWithDependencies.pipe(
            Layer.provide(ServerSourceControlHost.layer),
            Layer.provide(VcsDriverRegistry.layer),
            Layer.provideMerge(VcsProcess.layer),
          ),
        ),
        Layer.provide(gitVcsDriverLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(ThreadCommandExecutor.layer),
        Layer.provide(VcsProcess.layer),
        Layer.provideMerge(McpProviderSessions.layer),
        Layer.provideMerge(
          options?.layers?.providerLatestVersions === undefined
            ? ProviderLatestVersions.layer
            : Layer.succeed(
                ProviderLatestVersions.ProviderLatestVersions,
                options.layers.providerLatestVersions,
              ),
        ),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(IdAllocatorV2.layer),
        Layer.provide(layerConfig),
      );

    const services = yield* Layer.build(appLayer);
    return {
      ...config,
      auth: Context.get(services, EnvironmentAuth.EnvironmentAuth),
      v2: {
        threads: Context.get(services, ThreadManagementV2.ThreadManagementService),
        orchestrator: Context.get(services, OrchestratorV2.OrchestratorV2),
        eventSink: Context.get(services, EventSinkV2.EventSinkV2),
        events: Context.get(services, OrchestrationEventStore),
        projects: Context.get(services, ProjectService.ProjectService),
        worker: Context.get(services, EffectWorkerV2.OrchestrationEffectWorkerV2),
        outbox: Context.get(services, EffectOutboxV2.EffectOutboxV2),
        sql: Context.get(services, SqlClient.SqlClient),
        providerSessions: Context.get(services, ProviderSessionsV2.ProviderSessionManagerV2),
        idAllocator: Context.get(services, IdAllocatorV2.IdAllocatorV2),
        forks: Context.get(services, ConversationFork.ConversationForkService),
      },
    };
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return {
    cookie,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (wsUrl: string, onMessage?: (message: string) => void) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      // Socket.makeWebSocket only ever passes its `protocols` option here.
      const socket = new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols as string | string[] | undefined,
        cookie ? { headers: { cookie } } : undefined,
      );
      if (onMessage) socket.on("message", (data) => onMessage(data.toString()));
      return socket as unknown as globalThis.WebSocket;
    },
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = Effect.Success<typeof makeWsRpcClient>;

const withWsRpcClient = <A, E, R, E2 = never, R2 = never>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R> | Effect.Effect<A, E2, R2>,
  onMessage?: (message: string) => void,
) =>
  makeWsRpcClient.pipe(
    Effect.flatMap((client) =>
      Effect.gen(function* () {
        return yield* f(client);
      }),
    ),
    Effect.provide(wsRpcProtocolLayer(wsUrl, onMessage)),
  );

const withFirstWsAckHeld = (
  wsUrl: string,
  held: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
  ready?: Deferred.Deferred<void>,
) => {
  let holdNextAck = true;
  return Layer.effect(RpcClient.Protocol)(
    Effect.map(RpcClient.Protocol, (protocol) =>
      RpcClient.Protocol.of({
        ...protocol,
        send: (clientId, request, transferables) => {
          const send = protocol.send(clientId, request, transferables);
          if (request._tag !== "Ack" || !holdNextAck) {
            return send;
          }
          return Effect.gen(function* () {
            // Shell metadata prefixes must drain before the live producer attaches.
            if (ready !== undefined && !(yield* Deferred.isDone(ready))) return yield* send;
            holdNextAck = false;
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            return yield* send;
          });
        },
      }),
    ),
  ).pipe(Layer.provide(wsRpcProtocolLayer(wsUrl)));
};

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/browser-session");
    const response = yield* fetchEffect(bootstrapUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options?.headers,
      },
      body: jsonRequestBody({
        credential,
      }),
    });
    const body = yield* responseJsonEffect<{
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    }>(response);
    return {
      response,
      body,
      cookie: response.headers["set-cookie"],
    };
  });

const exchangeAccessToken = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
    readonly scope?: string;
    readonly clientMetadata?: {
      readonly label?: string;
      readonly deviceType?: string;
      readonly os?: string;
    };
  },
) =>
  Effect.gen(function* () {
    const tokenUrl = yield* getHttpServerUrl("/oauth/token");
    const response = yield* fetchEffect(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options?.headers,
      },
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope:
          options?.scope ??
          "orchestration:read orchestration:operate terminal:operate relay:read access:read access:write relay:write",
        ...(options?.clientMetadata?.label ? { client_label: options.clientMetadata.label } : {}),
        ...(options?.clientMetadata?.deviceType
          ? { client_device_type: options.clientMetadata.deviceType }
          : {}),
        ...(options?.clientMetadata?.os ? { client_os: options.clientMetadata.os } : {}),
      }).toString(),
    });
    const body = yield* responseJsonEffect<{
      readonly access_token?: string;
      readonly issued_token_type?: string;
      readonly token_type?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly _tag?: string;
      readonly code?: string;
      readonly reason?: string;
      readonly dpopFailureReason?: DpopFailureReason;
      readonly traceId?: string;
    }>(response);
    return {
      response,
      body,
    };
  });

const makeDpopProof = (input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly accessToken?: string;
  readonly jti?: string;
  readonly privateKey?: NodeCrypto.KeyObject;
  readonly publicJwk?: DpopPublicJwk;
}) => {
  const keyPair =
    input.privateKey && input.publicJwk
      ? { privateKey: input.privateKey, publicJwk: input.publicJwk }
      : (() => {
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk };
        })();
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti ?? "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(keyPair.publicJwk),
    privateKey: keyPair.privateKey,
    publicJwk: keyPair.publicJwk,
  };
};

const makeCloudMintCredentialRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly clientProofKeyThumbprint: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:connect">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t3-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-mint-jti-1",
    environmentId: input.environmentId,
    clientProofKeyThumbprint: input.clientProofKeyThumbprint,
    cnf: {
      jkt: input.clientProofKeyThumbprint,
    },
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:connect"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_MINT_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const makeCloudEnvironmentHealthRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:status">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t3-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-health-jti-1",
    environmentId: input.environmentId,
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:status"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_HEALTH_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const decodeCompactJwtPayload = <A>(token: string): A => {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    throw new Error("JWT does not contain a payload.");
  }
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as A;
};

class AuthenticationGetterError extends Data.TaggedError("AuthenticationGetterError")<{
  readonly message: string;
}> {}

class TestHttpRequestError extends Data.TaggedError("TestHttpRequestError")<{
  readonly cause: unknown;
}> {}

const testRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  const value = input.toString();
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

const fetchEffect = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = HttpClientRequest.make((init?.method ?? "GET") as "GET" | "POST")(
    testRequestUrl(input),
    {
      headers: init?.headers as Record<string, string> | undefined,
    },
  ).pipe(
    typeof init?.body === "string"
      ? HttpClientRequest.bodyText(
          init.body,
          (init.headers as Record<string, string> | undefined)?.["content-type"] ??
            "application/json",
        )
      : (request) => request,
  );
  const effect = HttpClient.execute(request);
  return (
    init?.redirect === "manual"
      ? effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
      : effect
  ).pipe(Effect.mapError((cause) => new TestHttpRequestError({ cause })));
};

const jsonRequestBody = (value: unknown): string => {
  return JSON.stringify(value);
};

const responseJsonEffect = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) => json as A),
    Effect.mapError((cause) => new TestHttpRequestError({ cause })),
  );

const responseOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bootstrap session response to succeed, got ${response.status}`,
      });
    }

    if (!cookie) {
      return yield* new AuthenticationGetterError({
        message: "Expected bootstrap session response to set a cookie.",
      });
    }

    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* exchangeAccessToken(credential, {
      scope: AuthAdministrativeScopes.join(" "),
    });
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bearer bootstrap response to succeed, got ${response.status}`,
      });
    }

    if (!body.access_token) {
      return yield* new AuthenticationGetterError({
        message: "Expected token exchange response to include an access token.",
      });
    }

    return body.access_token;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const assertBrowserApiCorsResponseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assert.equal(headers["access-control-allow-origin"], options?.origin ?? "*");
  assert.equal(
    headers["access-control-allow-credentials"],
    options?.credentials ? "true" : undefined,
  );
};

const assertBrowserApiCorsPreflightHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assertBrowserApiCorsResponseHeaders(headers, options);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-methods"] ?? null), [
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
  ]);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-headers"]), [
    "authorization",
    "b3",
    "content-type",
    "dpop",
    "range",
    "traceparent",
    THREAD_SNAPSHOT_FORMAT_HEADER,
    ORCHESTRATION_PROTOCOL_HEADER,
  ]);
};
const crossOriginClientOrigin = "http://remote-client.test:3773";

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string; protocol?: number | null },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    const url = new URL(`ws://127.0.0.1:${address.port}${pathname}`);
    if (options?.protocol !== null)
      url.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(options?.protocol ?? ORCHESTRATION_PROTOCOL_VERSION),
      );
    const baseUrl = url.toString();
    if (options?.authenticated === false) {
      return baseUrl;
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    );
  });

// Keep Scient-owned integration cases on the exact inherited server harness.
export type ScientRpcServerTestHarness = {
  readonly buildAppUnderTest: typeof buildAppUnderTest;
  readonly exchangeAccessToken: typeof exchangeAccessToken;
  readonly fetchEffect: typeof fetchEffect;
  readonly getHttpServerUrl: typeof getHttpServerUrl;
  readonly getWsServerUrl: typeof getWsServerUrl;
  readonly withWsRpcClient: typeof withWsRpcClient;
};

// Mirrors NodeHttpServer.layerTest, which does not expose server options,
// with the production `websocket: { perMessageDeflate: true }` setting.
const NodeHttpServerTestWithWsDeflate = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.map(
        Effect.promise(() => import("node:http")),
        (NodeHttp) =>
          NodeHttpServer.layer(NodeHttp.createServer, {
            port: 0,
            websocket: { perMessageDeflate: true },
          }),
      ),
    ),
  ),
);

const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "disabled",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: DeviceService.DEVICE_HUB_ROUTE_PREFIX,
  revision: 0,
};

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("parks HTTP ingress until command readiness", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-gate-" });
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "ready");
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        config: { staticDir },
        layers: {
          serverRuntimeStartup: {
            awaitCommandReady: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(ready)),
            ),
          },
        },
      });
      const request = yield* HttpClient.get("/").pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      assert.isFalse(yield* Deferred.isDone(completed));

      yield* Deferred.succeed(ready, undefined);
      assert.equal((yield* Fiber.join(request)).status, 200);
      assert.isTrue(yield* Deferred.isDone(completed));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revalidates static files without sending unchanged bodies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-cache-" });
      const assetPath = path.join(staticDir, "app.js");
      yield* fileSystem.writeFileString(assetPath, 'export const build = "first";');
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/app.js");
      assert.equal(initial.status, 200);
      assert.equal(initial.headers["cache-control"], "no-cache");
      assert.include(yield* initial.text, "first");
      const etag = initial.headers.etag;
      assert.isDefined(etag);
      assert.isDefined(initial.headers["last-modified"]);

      for (const headers of [
        { "if-none-match": etag! },
        { "if-none-match": `"older", ${etag!.replace(/^W\//, "")}` },
        { "if-none-match": "*" },
        { "if-modified-since": initial.headers["last-modified"]! },
      ]) {
        const response = yield* HttpClient.get("/app.js", { headers });
        assert.equal(response.status, 304);
        assert.equal(response.headers.etag, etag);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(yield* response.text, "");
      }

      const mismatched = yield* HttpClient.get("/app.js", {
        headers: {
          "if-none-match": '"another-build"',
          "if-modified-since": initial.headers["last-modified"]!,
        },
      });
      assert.equal(mismatched.status, 200);
      assert.include(yield* mismatched.text, "first");

      yield* fileSystem.writeFileString(assetPath, 'export const build = "the next build";');
      const changed = yield* HttpClient.get("/app.js", { headers: { "if-none-match": etag! } });
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.etag, etag);
      assert.include(yield* changed.text, "next build");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves changed HTML with the same size and timestamp", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-html-" });
      const indexPath = path.join(staticDir, "index.html");
      const modifiedAt = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
      yield* fileSystem.writeFileString(indexPath, "<html>old build</html>");
      yield* fileSystem.utimes(indexPath, modifiedAt, modifiedAt);
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/");
      assert.equal(yield* initial.text, "<html>old build</html>");
      const previousEtag = initial.headers.etag ?? '"previous-html"';
      const nextHtml = "<html>new build</html>";
      yield* fileSystem.writeFileString(indexPath, nextHtml);
      yield* fileSystem.utimes(indexPath, modifiedAt, modifiedAt);

      for (const [resource, headers] of [
        ["/", { "if-none-match": previousEtag }],
        ["/threads/example", { "if-modified-since": modifiedAt.toUTCString() }],
        ["/", { "if-none-match": "*" }],
      ] as const) {
        const response = yield* HttpClient.get(resource, { headers });
        assert.equal(response.status, 200);
        assert.equal(yield* response.text, nextHtml);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.isUndefined(response.headers.etag);
        assert.isUndefined(response.headers["last-modified"]);
      }

      const head = yield* HttpClient.head("/", {
        headers: { "if-none-match": previousEtag, "accept-encoding": "identity" },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-length"], String(Buffer.byteLength(nextHtml)));
      assert.equal(yield* head.text, "");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caches hashed static assets without freezing mutable files or SPA fallbacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-hashes-" });
      yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
      yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
      yield* fileSystem.writeFileString(
        path.join(staticDir, ".vite", "manifest.json"),
        `{
          "index.html": { "file": "assets/index-AbCd0123.js", "isEntry": true },
          "large.js": { "file": "assets/large-aBcD9876.js" }
        }`,
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html>app</html>");
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "index-AbCd0123.js"),
        "export const app = true;",
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "assets", "config.json"), "{}");
      const largeAsset = "export const value = 123;\n".repeat(8192);
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "large-aBcD9876.js"),
        largeAsset,
      );
      yield* buildAppUnderTest({ config: { staticDir } });

      const asset = yield* HttpClient.get("/assets/index-AbCd0123.js");
      assert.equal(asset.status, 200);
      assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(yield* asset.text, "export const app = true;");

      const head = yield* HttpClient.head("/assets/index-AbCd0123.js", {
        headers: { "accept-encoding": "identity" },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.etag, asset.headers.etag);
      assert.equal(head.headers["content-length"], String("export const app = true;".length));
      assert.equal(yield* head.text, "");

      const compressed = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(compressed.headers["content-encoding"], "gzip");
      assert.equal(compressed.headers.vary, "Accept-Encoding");
      assert.equal(yield* compressed.text, largeAsset);
      const compressedHead = yield* HttpClient.head("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(compressedHead.status, 200);
      assert.equal(compressedHead.headers["content-encoding"], "gzip");
      assert.equal(compressedHead.headers.vary, "Accept-Encoding");
      assert.equal(compressedHead.headers.etag, compressed.headers.etag);
      assert.equal(compressedHead.headers["content-length"], compressed.headers["content-length"]);
      assert.equal(yield* compressedHead.text, "");
      const unchanged = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "identity", "if-none-match": compressed.headers.etag! },
      });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.vary, "Accept-Encoding");
      assert.equal(yield* unchanged.text, "");

      for (const resource of [
        "/assets/config.json",
        "/threads/example",
        "/assets/old-ZyXw9876.js",
      ]) {
        const response = yield* HttpClient.get(resource);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(
          yield* response.text,
          resource.endsWith("config.json") ? "{}" : "<html>app</html>",
        );
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    [
      { label: "missing", contents: null },
      { label: "nonmatching", contents: '{"other.js":{"file":"assets/other-AbCd0123.js"}}' },
      { label: "malformed", contents: "{not-json" },
    ].map((manifest) => ({
      caseTitle: `revalidates hash-like static filenames with a ${manifest.label} manifest`,
      manifest,
    })),
  )("$caseTitle", ({ manifest }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-static-mutable-",
      });
      yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
      if (manifest.contents !== null) {
        yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
        yield* fileSystem.writeFileString(
          path.join(staticDir, ".vite", "manifest.json"),
          manifest.contents,
        );
      }
      const filePath = path.join(staticDir, "assets", "config-20260904.js");
      yield* fileSystem.writeFileString(filePath, "first config");
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/assets/config-20260904.js");
      assert.equal(initial.headers["cache-control"], "no-cache");
      assert.equal(yield* initial.text, "first config");

      yield* fileSystem.writeFileString(filePath, "replacement config");
      const changed = yield* HttpClient.get("/assets/config-20260904.js", {
        headers: { "if-none-match": initial.headers.etag! },
      });
      assert.equal(changed.status, 200);
      assert.equal(changed.headers["cache-control"], "no-cache");
      assert.notEqual(changed.headers.etag, initial.headers.etag);
      assert.equal(yield* changed.text, "replacement config");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("binds static metadata and bytes to one file across atomic replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-replace-" });
      const beforeOpenPath = path.join(staticDir, "before-open.txt");
      const afterOpenPath = path.join(staticDir, "after-open.txt");
      const afterOpenSnapshotPath = path.join(staticDir, "after-open-snapshot.txt");
      const windowsHost = HostProcess.Platform.defaultValue() === "win32";
      const original = "original bytes";
      const replacement = "replacement bytes with a different size";
      for (const filePath of [beforeOpenPath, afterOpenPath]) {
        yield* fileSystem.writeFileString(filePath, original);
        yield* fileSystem.writeFileString(`${filePath}.next`, replacement);
      }
      if (windowsHost) {
        // Windows cannot replace an open destination, so model the race with its original handle.
        yield* fileSystem.writeFileString(afterOpenSnapshotPath, original);
      }
      const replaced = new Set<string>();
      const replaceOnce = Effect.fnUntraced(function* (filePath: string) {
        if (replaced.has(filePath)) return;
        replaced.add(filePath);
        yield* fileSystem.rename(`${filePath}.next`, filePath);
      });
      const replacingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (filePath) =>
          fileSystem
            .stat(filePath)
            .pipe(
              Effect.tap(() => (filePath === beforeOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
        open: (filePath, options) =>
          fileSystem
            .open(
              filePath === afterOpenPath && windowsHost ? afterOpenSnapshotPath : filePath,
              options,
            )
            .pipe(
              Effect.tap(() => (filePath === afterOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
      });
      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, replacingFileSystem),
      );

      for (const [name, expected] of [
        ["before-open.txt", replacement],
        ["after-open.txt", original],
      ] as const) {
        const response = yield* HttpClient.get(`/${name}`, {
          headers: { "accept-encoding": "identity" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers["content-length"], String(expected.length));
        assert.isTrue(response.headers.etag?.startsWith(`W/"${expected.length.toString(16)}-`));
        assert.equal(yield* response.text, expected);
        assert.isTrue(replaced.has(path.join(staticDir, name)));
        assert.equal(yield* fileSystem.readFileString(path.join(staticDir, name)), replacement);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes static file handles after GET, HEAD, 304, and request cancellation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-close-" });
      const filePath = path.join(staticDir, "app.txt");
      const body = "file content\n".repeat(1024);
      yield* fileSystem.writeFileString(filePath, body);
      const closed = yield* Queue.unbounded<FileSystem.File>();
      const blocked = yield* Deferred.make<void>();
      const active = new Set<FileSystem.File>();
      let blockAfterOpen = false;
      let bodyReads = 0;
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fileSystem.open(candidate, options);
            let opened: FileSystem.File | undefined;
            // Registered first, so this signal runs after the real descriptor-close finalizer.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (opened === undefined) return;
                active.delete(opened);
                yield* Queue.offer(closed, opened);
              }),
            );
            const file = yield* fileSystem.open(candidate, options);
            opened = file;
            active.add(file);
            if (blockAfterOpen) {
              yield* Deferred.succeed(blocked, undefined);
              return yield* Effect.never;
            }
            return new Proxy(file, {
              get(target, key) {
                if (key === "readAlloc") {
                  return (size: number) => {
                    bodyReads += 1;
                    return target.readAlloc(size);
                  };
                }
                return Reflect.get(target, key, target);
              },
            });
          }),
      });
      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );

      const get = yield* HttpClient.get("/app.txt");
      assert.equal(yield* get.text, body);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.isAbove(bodyReads, 0);
      const readsAfterGet = bodyReads;

      const head = yield* HttpClient.head("/app.txt", { headers: { "accept-encoding": "gzip" } });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-encoding"], "gzip");
      assert.equal(yield* head.text, "");
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      const unchanged = yield* HttpClient.get("/app.txt", {
        headers: { "if-none-match": get.headers.etag! },
      });
      assert.equal(unchanged.status, 304);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      blockAfterOpen = true;
      const cancelled = yield* HttpClient.get("/app.txt").pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      assert.equal(active.size, 1);
      yield* Fiber.interrupt(cancelled);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* fetchEffect(url, { redirect: "manual" });

      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "http://127.0.0.1:5173/foo/bar?token=test-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the public environment descriptor without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url);
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves snapshots for MCP handoff thread IDs above the router default", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(
        "thread:mcp:abfba0d2-b591-4b7e-aad1-e943d89811fa:handoff%3A0ae5edf4-2ea3-4ee3-ba7c-48de3ac92896%3A2026-08-24T17%3A08%3A52.138Z:0",
      );
      const app = yield* buildAppUnderTest();
      yield* seedV2StreamThread(app, threadId);

      const response = yield* fetchEffect(
        yield* getHttpServerUrl(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
        },
      );
      const snapshot = yield* responseJsonEffect<{
        readonly projection: { readonly thread: { readonly id: ThreadId } };
      }>(response);

      assert.equal(response.status, 200, encodeTestJson(snapshot));
      assert.equal(snapshot.projection.thread.id, threadId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("compresses large JSON responses through the composed routes", () =>
    Effect.gen(function* () {
      const descriptor = {
        ...testEnvironmentDescriptor,
        label: "Test environment".repeat(100),
      };
      yield* buildAppUnderTest({
        layers: {
          serverEnvironment: {
            getDescriptor: Effect.succeed(descriptor),
          },
        },
      });

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url, {
        headers: {
          "accept-encoding": "gzip",
        },
      });
      const body = yield* responseJsonEffect<typeof descriptor>(response);

      assert.equal(response.status, 200);
      assert.equal(response.headers["content-encoding"], "gzip");
      assert.equal(response.headers.vary, "Accept-Encoding");
      assert.deepEqual(body, descriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on public environment descriptor responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url, {
        headers: {
          origin: crossOriginClientOrigin,
        },
      });
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

      assert.equal(response.status, 200);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports unauthenticated session state without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(url);
      const body = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
          readonly sessionMethods: ReadonlyArray<string>;
          readonly sessionCookieName: string;
        };
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.equal(body.auth.policy, "desktop-managed-local");
      assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
      assert.deepEqual(body.auth.sessionMethods, [
        "browser-session-cookie",
        "bearer-access-token",
        "dpop-access-token",
      ]);
      // Desktop, so port-scoped: instances scan for a free port and share
      // 127.0.0.1, and cookies are not scoped by port.
      assert.isTrue(body.auth.sessionCookieName.startsWith("t3_session_"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bootstraps a browser session and authenticates the session endpoint via cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
      assert.isDefined(setCookie);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          cookie: setCookie?.split(";")[0] ?? "",
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("migrates a valid legacy remote-web session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { mode: "web", host: "192.168.1.50" } });

      const { cookie } = yield* bootstrapBrowserSession();
      const currentCookie = cookie?.split(";")[0] ?? "";
      const legacyCookie = currentCookie.replace(/^t3_session_[^=]+=/, "t3_session=");
      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(sessionUrl, {
        headers: { cookie: legacyCookie },
      });
      const body = yield* responseJsonEffect<{ readonly authenticated: boolean }>(response);

      assert.equal(body.authenticated, true);
      assert.equal(response.headers["set-cookie"], cookie);
      assert.equal(response.headers["cache-control"], "no-store");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(["cookie", "bearer"])(
    "does not migrate a stale legacy cookie when %s auth succeeds",
    (source) =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ config: { mode: "web", host: "192.168.1.50" } });

        const { cookie } = yield* bootstrapBrowserSession();
        const sessionCookie = cookie?.split(";")[0] ?? "";
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(sessionUrl, {
          headers:
            source === "cookie"
              ? { cookie: `${sessionCookie}; t3_session=stale` }
              : { authorization: `Bearer ${sessionToken}`, cookie: "t3_session=stale" },
        });
        const body = yield* responseJsonEffect<{ readonly authenticated: boolean }>(response);

        assert.equal(body.authenticated, true);
        assert.isUndefined(response.headers["set-cookie"]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("exchanges a bootstrap grant for a scoped bearer access token", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken();

      assert.equal(tokenResponse.status, 200);
      assert.equal(tokenBody.issued_token_type, AuthAccessTokenType);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(
        tokenBody.scope,
        "orchestration:read orchestration:operate terminal:operate relay:read access:read access:write relay:write",
      );
      assert.equal(typeof tokenBody.access_token, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
        readonly scopes?: ReadonlyArray<string>;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");
      assert.deepEqual(sessionBody.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("replaces the local desktop credential on repeated bootstrap exchanges", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const first = yield* exchangeAccessToken();
      const second = yield* exchangeAccessToken();
      const third = yield* exchangeAccessToken();
      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);
      assert.equal(third.response.status, 200);

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: { authorization: `Bearer ${third.body.access_token}` },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly current: boolean;
        readonly subject: string;
      }>;
      assert.equal(clientsResponse.status, 200);
      assert.equal(clients.length, 1);
      assert.equal(clients[0]?.current, true);
      assert.equal(clients[0]?.subject, "desktop-bootstrap");

      for (const previous of [first, second]) {
        const response = yield* HttpClient.get("/api/auth/session", {
          headers: { authorization: `Bearer ${previous.body.access_token}` },
        });
        const state = (yield* response.json) as { readonly authenticated: boolean };
        assert.equal(state.authenticated, false);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("persists token exchange client display metadata for authorized-client listings", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };

      const { response } = yield* exchangeAccessToken(pairingBody.credential, {
        headers: {
          "user-agent": "undici",
        },
        scope: "orchestration:read orchestration:operate terminal:operate",
        clientMetadata: {
          label: "Scient Mobile",
          deviceType: "mobile",
          os: "iOS",
        },
      });

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly userAgent?: string;
        };
      }>;
      const mobileClient = clients.find((client) => !client.current);

      assert.equal(pairingResponse.status, 200);
      assert.equal(response.status, 200);
      assert.equal(clientsResponse.status, 200);
      assert.deepInclude(mobileClient?.client, {
        label: "Scient Mobile",
        deviceType: "mobile",
        os: "iOS",
        ipAddress: "127.0.0.1",
        userAgent: "undici",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "exchanges a bootstrap credential for a DPoP-bound access token without bearer downgrade",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as { readonly credential: string };
        const tokenUrl = yield* getHttpServerUrl("/oauth/token");
        const now = yield* DateTime.now;
        const tokenProof = makeDpopProof({
          method: "POST",
          url: tokenUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: "token-exchange-proof",
        });
        const tokenResponse = yield* fetchEffect(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: tokenProof.proof,
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: credential.credential,
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            scope: "orchestration:read orchestration:operate terminal:operate",
          }).toString(),
        });
        const token = yield* responseJsonEffect<{
          readonly access_token: string;
          readonly token_type: string;
        }>(tokenResponse);

        assert.equal(tokenResponse.status, 200);
        assert.equal(tokenResponse.headers["cache-control"], "no-store");
        assert.equal(token.token_type, "DPoP");

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const bearerResponse = yield* fetchEffect(sessionUrl, {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        const bearerState = yield* responseJsonEffect<{ readonly authenticated: boolean }>(
          bearerResponse,
        );
        assert.equal(bearerState.authenticated, false);

        const sessionProof = makeDpopProof({
          method: "GET",
          url: sessionUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: "session-proof",
          accessToken: token.access_token,
          privateKey: tokenProof.privateKey,
          publicJwk: tokenProof.publicJwk,
        });
        const dpopResponse = yield* fetchEffect(sessionUrl, {
          headers: {
            authorization: `DPoP ${token.access_token}`,
            dpop: sessionProof.proof,
          },
        });
        const dpopState = yield* responseJsonEffect<{
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        }>(dpopResponse);
        assert.equal(dpopState.authenticated, true);
        assert.equal(dpopState.sessionMethod, "dpop-access-token");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports clock skew for a future-dated DPoP token exchange proof", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000) + 25,
      });

      const exchange = yield* exchangeAccessToken(credential.credential, {
        headers: { dpop: dpop.proof },
        scope: "orchestration:read orchestration:operate terminal:operate",
      });

      assert.equal(exchange.response.status, 401);
      assert.equal(exchange.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(exchange.body.code, "auth_invalid");
      assert.equal(exchange.body.reason, "invalid_credential");
      assert.equal(exchange.body.dpopFailureReason, "time_window");
      assert.equal(typeof exchange.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed DPoP proofs across token exchanges", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const firstCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const firstCredential = (yield* firstCredentialResponse.json) as {
        readonly credential: string;
      };
      const secondCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const secondCredential = (yield* secondCredentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const firstBootstrap = yield* exchangeAccessToken(firstCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: "orchestration:read orchestration:operate terminal:operate",
      });
      const replayBootstrap = yield* exchangeAccessToken(secondCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: "orchestration:read orchestration:operate terminal:operate",
      });

      assert.equal(firstBootstrap.response.status, 200);
      assert.equal(replayBootstrap.response.status, 401);
      assert.equal(replayBootstrap.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(replayBootstrap.body.code, "auth_invalid");
      assert.equal(replayBootstrap.body.reason, "invalid_credential");
      assert.equal(replayBootstrap.body.dpopFailureReason, "replay");
      assert.equal(typeof replayBootstrap.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores forwarded host headers when validating token exchange DPoP URLs", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          "x-forwarded-host": "environment.example.test",
        },
        scope: "orchestration:read orchestration:operate terminal:operate",
      });

      assert.equal(bootstrap.response.status, 200);
      assert.equal(bootstrap.body.token_type, "DPoP");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects token exchange DPoP proofs bound to spoofed forwarded hosts", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const spoofedUrl = new URL(tokenUrl);
      spoofedUrl.hostname = "environment.example.test";
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: spoofedUrl.href,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          "x-forwarded-host": spoofedUrl.host,
        },
        scope: "orchestration:read orchestration:operate terminal:operate",
      });

      assert.equal(bootstrap.response.status, 401);
      assert.equal(bootstrap.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(bootstrap.body.code, "auth_invalid");
      assert.equal(bootstrap.body.reason, "invalid_credential");
      assert.equal(bootstrap.body.dpopFailureReason, "request_mismatch");
      assert.equal(typeof bootstrap.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs for non-loopback managed endpoint origins", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "manual",
          },
          origin: {
            localHttpHost: "192.168.1.42",
            localHttpPort: 3773,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400, encodeTestJson(body));
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs for unsupported endpoint providers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: linkProofUrl.replace("/api/connect/link-proof", ""),
            wsBaseUrl: linkProofUrl
              .replace("http://", "ws://")
              .replace("/api/connect/link-proof", "/ws"),
            // "manual" and "cloudflare_tunnel" are supported; "t3_relay" is not.
            providerKind: "t3_relay",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: serverPort,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs requested through a public managed endpoint", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          host: "environment.example.test",
          "x-forwarded-host": "environment.example.test",
          "x-forwarded-proto": "https",
        },
        body: HttpBody.text(
          jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "manual",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
          "application/json",
        ),
      });
      const body = (yield* linkProofResponse.json) as {
        readonly _tag?: string;
        readonly message?: string;
      };

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects cloud link proofs when a public request spoofs loopback forwarded headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
        const serverPort = Number(new URL(linkProofUrl).port);
        const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
            host: "environment.example.test",
            "x-forwarded-host": `127.0.0.1:${serverPort}`,
            "x-forwarded-proto": "http",
          },
          body: HttpBody.text(
            jsonRequestBody({
              challenge: "relay-link-challenge",
              relayIssuer: "https://relay.example.test",
              endpoint: {
                httpBaseUrl: "https://environment.example.test/",
                wsBaseUrl: "wss://environment.example.test/ws",
                providerKind: "manual",
              },
              origin: {
                localHttpHost: "127.0.0.1",
                localHttpPort: serverPort,
              },
            }),
            "application/json",
          ),
        });
        const body = (yield* linkProofResponse.json) as {
          readonly _tag?: string;
          readonly message?: string;
        };

        assert.equal(linkProofResponse.status, 400);
        assert.equal(body._tag, "EnvironmentHttpBadRequestError");
        assert.equal(body.message, "Invalid managed endpoint origin.");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs with malformed forwarded request hosts", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          host: "bad host",
          "x-forwarded-host": "bad host",
          "x-forwarded-proto": "https",
        },
        body: HttpBody.text(
          jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "manual",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
          "application/json",
        ),
      });
      const body = (yield* linkProofResponse.json) as {
        readonly _tag?: string;
        readonly message?: string;
      };

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects local cloud link proofs for a different loopback port", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "manual",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: serverPort === 65_535 ? serverPort - 1 : serverPort + 1,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows standard clients to read managed relay configuration state", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const response = yield* fetchEffect(linkStateUrl, {
        headers: { cookie: pairedCookie },
      });
      const body = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly publishAgentActivity?: boolean;
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(body.linked, false);
      assert.equal(body.publishAgentActivity, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "reports relay client status and streams installation progress over environment RPC",
    () =>
      Effect.gen(function* () {
        const installedRelayClient = {
          status: "available" as const,
          executablePath: "/tmp/t3/tools/cloudflared",
          source: "managed" as const,
          version: RelayClient.CLOUDFLARED_VERSION,
        };
        yield* buildAppUnderTest({
          layers: {
            relayClient: {
              resolve: Effect.succeed({
                status: "missing",
                version: RelayClient.CLOUDFLARED_VERSION,
              }),
              install: Effect.succeed(installedRelayClient),
              installWithProgress: (report) =>
                report({ type: "progress", stage: "checking" }).pipe(
                  Effect.andThen(report({ type: "progress", stage: "downloading" })),
                  Effect.as(installedRelayClient),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const status = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.cloudGetRelayClientStatus]({})),
        );
        const installEvents = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.cloudInstallRelayClient]({}).pipe(Stream.runCollect),
          ),
        );

        assert.equal(status.status, "missing");
        assert.deepEqual(Array.from(installEvents), [
          { type: "progress", stage: "checking" },
          { type: "progress", stage: "downloading" },
          { type: "complete", status: installedRelayClient },
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires relay write scope to update agent activity publication", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const preferencesUrl = yield* getHttpServerUrl("/api/connect/preferences");
      const ownerResponse = yield* fetchEffect(preferencesUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({ publishAgentActivity: true }),
      });
      const ownerBody = yield* responseJsonEffect<{
        readonly publishAgentActivity?: boolean;
      }>(ownerResponse);
      assert.equal(ownerResponse.status, 200);
      assert.equal(ownerBody.publishAgentActivity, true);

      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
      const pairedResponse = yield* fetchEffect(preferencesUrl, {
        method: "POST",
        headers: {
          cookie: pairedCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({ publishAgentActivity: false }),
      });
      const pairedBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly requiredScope?: string;
      }>(pairedResponse);
      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
      assert.equal(pairedBody.requiredScope, "relay:write");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config with an invalid cloud mint public key", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: "not-a-public-key",
          endpointRuntime: null,
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(relayConfigResponse);

      assert.equal(relayConfigResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Cloud mint public key must be a valid Ed25519 public key.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config with insecure relay metadata or empty credentials", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const postRelayConfig = (body: {
        readonly relayUrl: string;
        readonly relayIssuer?: string;
        readonly cloudUserId: string;
        readonly environmentCredential: string;
      }) =>
        fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            ...body,
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });

      const insecureRelayUrl = yield* postRelayConfig({
        relayUrl: "http://relay.example.test",
        cloudUserId: "user_123",
        environmentCredential: "t3env_test_credential",
      });
      const insecureRelayIssuer = yield* postRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user_123",
        relayIssuer: "http://relay.example.test",
        environmentCredential: "t3env_test_credential",
      });
      const nonOriginRelayUrl = yield* postRelayConfig({
        relayUrl: "https://relay.example.test/path",
        cloudUserId: "user_123",
        environmentCredential: "t3env_test_credential",
      });
      const emptyCredential = yield* postRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user_123",
        environmentCredential: "   ",
      });
      const insecureRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
        insecureRelayUrl,
      );
      const insecureRelayIssuerBody = yield* responseJsonEffect<{ readonly message?: string }>(
        insecureRelayIssuer,
      );
      const nonOriginRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
        nonOriginRelayUrl,
      );
      const emptyCredentialBody = yield* responseJsonEffect<{ readonly message?: string }>(
        emptyCredential,
      );

      assert.equal(insecureRelayUrl.status, 400);
      assert.equal(insecureRelayUrlBody.message, "Relay URL must be a secure absolute HTTPS URL.");
      assert.equal(insecureRelayIssuer.status, 400);
      assert.equal(
        insecureRelayIssuerBody.message,
        "Relay issuer must be a secure absolute HTTPS URL.",
      );
      assert.equal(nonOriginRelayUrl.status, 400);
      assert.equal(nonOriginRelayUrlBody.message, "Relay URL must be a secure absolute HTTPS URL.");
      assert.equal(emptyCredential.status, 400);
      assert.equal(emptyCredentialBody.message, "Relay environment credential is required.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config replacement from a different cloud account", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const postRelayConfig = (cloudUserId: string, environmentCredential: string) =>
        fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://relay.example.test",
            cloudUserId,
            environmentCredential,
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });

      const firstResponse = yield* postRelayConfig("user_123", "t3env_first_credential");
      const replacementResponse = yield* postRelayConfig("user_456", "t3env_second_credential");
      const replacementBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replacementResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replacementResponse.status, 409);
      assert.equal(replacementBody._tag, "EnvironmentHttpConflictError");
      assert.equal(
        replacementBody.message,
        "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects a non-Cloudflare managed endpoint runtime without persisting the link", () =>
    Effect.gen(function* () {
      const appliedRuntimeConfigs: Array<unknown> = [];
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: (config) =>
              Effect.sync(() => {
                appliedRuntimeConfigs.push(config);
                return config === null
                  ? ({ status: "disabled" } as const)
                  : ({ status: "unsupported", providerKind: config.providerKind } as const);
              }),
          },
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "manual",
            connectorToken: "manual-token",
          },
        }),
      });
      const relayConfigBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly endpointRuntimeStatus?: { readonly status?: string };
      }>(relayConfigResponse);
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const linkStateResponse = yield* fetchEffect(linkStateUrl, {
        headers: { cookie: ownerCookie },
      });
      const linkStateBody = yield* responseJsonEffect<{ readonly linked?: boolean }>(
        linkStateResponse,
      );

      assert.equal(relayConfigResponse.status, 503);
      assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "unsupported");
      // The connector is never touched for a rejected runtime.
      assert.deepEqual(appliedRuntimeConfigs, []);
      assert.equal(linkStateResponse.status, 200);
      assert.equal(linkStateBody.linked, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports local cloud link state from persisted relay config", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");

      const initialResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const initialBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
      }>(initialResponse);
      assert.equal(initialResponse.status, 200);
      assert.equal(initialBody.linked, false);
      assert.equal(initialBody.cloudUserId, null);

      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://transport.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const linkedResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const linkedBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
        readonly relayUrl?: string | null;
        readonly relayIssuer?: string | null;
      }>(linkedResponse);

      assert.equal(linkedResponse.status, 200);
      assert.equal(linkedBody.linked, true);
      assert.equal(linkedBody.cloudUserId, "user_123");
      assert.equal(linkedBody.relayUrl, "https://transport.example.test");
      assert.equal(linkedBody.relayIssuer, "https://relay.example.test");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not expose internal cloud reconciliation over HTTP", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const reconcileUrl = yield* getHttpServerUrl("/api/connect/reconcile");
      const response = yield* fetchEffect(reconcileUrl, {
        method: "POST",
      });

      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("unlinks local cloud state and disables the managed endpoint runtime", () =>
    Effect.gen(function* () {
      const appliedRuntimeConfigs: Array<unknown> = [];
      const requestedRecoveryConfigs: Array<unknown> = [];
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: (config) => {
              appliedRuntimeConfigs.push(config);
              if (!config) {
                return Effect.succeed({ status: "disabled" });
              }
              return Effect.succeed({
                status: "running",
                providerKind: "cloudflare_tunnel",
                pid: 123,
                ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
                ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
              });
            },
            requestRecovery: (config) =>
              Effect.sync(() => {
                requestedRecoveryConfigs.push(config);
              }),
          },
          httpClient: HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ status: "ready" }))),
          ),
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const unlinkUrl = yield* getHttpServerUrl("/api/connect/unlink");
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");

      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://transport.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
          },
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const unlinkResponse = yield* fetchEffect(unlinkUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
        },
      });
      const unlinkBody = yield* responseJsonEffect<{
        readonly ok?: boolean;
        readonly endpointRuntimeStatus?: { readonly status?: string };
      }>(unlinkResponse);
      assert.equal(unlinkResponse.status, 200);
      assert.equal(unlinkBody.ok, true);
      assert.equal(unlinkBody.endpointRuntimeStatus?.status, "disabled");

      const linkStateResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const linkStateBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
        readonly relayUrl?: string | null;
        readonly relayIssuer?: string | null;
      }>(linkStateResponse);
      assert.equal(linkStateResponse.status, 200);
      assert.equal(linkStateBody.linked, false);
      assert.equal(linkStateBody.cloudUserId, null);
      assert.equal(linkStateBody.relayUrl, null);
      assert.equal(linkStateBody.relayIssuer, null);
      assert.deepEqual(appliedRuntimeConfigs, [
        null,
        {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: "tunnel-name",
        },
        null,
      ]);
      assert.deepEqual(requestedRecoveryConfigs, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed cloud mint requests atomically", () => {
    // This is a cloud protocol regression test; opt the test process into
    // the otherwise-disabled D4 cloud route explicitly.
    const previousCloudEnv = {
      enabled: process.env.SCIENT_NEXT_CLOUD_ENABLED,
      relay: process.env.T3CODE_RELAY_URL,
      clerk: process.env.T3CODE_CLERK_PUBLISHABLE_KEY,
      oauth: process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
    };
    const restoreCloudEnv = Effect.sync(() => {
      for (const [name, value] of [
        ["SCIENT_NEXT_CLOUD_ENABLED", previousCloudEnv.enabled],
        ["T3CODE_RELAY_URL", previousCloudEnv.relay],
        ["T3CODE_CLERK_PUBLISHABLE_KEY", previousCloudEnv.clerk],
        ["T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", previousCloudEnv.oauth],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    return Effect.gen(function* () {
      process.env.SCIENT_NEXT_CLOUD_ENABLED = "true";
      process.env.T3CODE_RELAY_URL = "https://relay.example.test";
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY = "pk_test_example";
      process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID = "oauth_test";
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudMintCredentialRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        nonce: "cloud-mint-nonce-1",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const mintUrl = yield* getHttpServerUrl("/api/connect/mint-credential");
      const postMint = () =>
        fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const firstResponse = yield* postMint();
      const replayResponse = yield* postMint();
      const replayBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 409);
      assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
      assert.equal(replayBody.message, "Cloud mint request was already consumed.");
    }).pipe(Effect.ensuring(restoreCloudEnv), Effect.provide(NodeHttpServer.layerTest));
  });

  it.effect("serves the documented T3 Connect mint credential endpoint", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudMintCredentialRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        jti: "cloud-mint-jti-documented-endpoint",
        nonce: "cloud-mint-nonce-documented-endpoint",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(request),
      });

      assert.equal(response.status, 200);
      const body = yield* responseJsonEffect<{
        readonly credential?: string;
        readonly proof?: string;
      }>(response);
      assert.equal(typeof body.credential, "string");
      assert.equal(typeof body.proof, "string");
      assert.equal(
        decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
        "cloud-mint-nonce-documented-endpoint",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves signed T3 Connect environment health checks", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        jti: "cloud-health-jti-documented-endpoint",
        nonce: "cloud-health-nonce-documented-endpoint",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(request),
      });

      assert.equal(response.status, 200);
      const body = yield* responseJsonEffect<{
        readonly status?: string;
        readonly descriptor?: { readonly environmentId?: string };
        readonly proof?: string;
      }>(response);
      assert.equal(body.status, "online");
      assert.equal(body.descriptor?.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(typeof body.proof, "string");
      assert.equal(
        decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
        "cloud-health-nonce-documented-endpoint",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed cloud health requests atomically", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        jti: "cloud-health-jti-replay",
        nonce: "cloud-health-nonce-replay",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const postHealth = () =>
        fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const firstResponse = yield* postHealth();
      const replayResponse = yield* postHealth();
      const replayBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 409);
      assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
      assert.equal(replayBody.message, "Cloud health request was already consumed.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "validates cloud proofs against the configured relay issuer, not the transport URL",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://transport.example.test",
            cloudUserId: "user_123",
            relayIssuer: "https://relay.example.test",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
        const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
          fetchEffect(mintUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: jsonRequestBody(request),
          });

        const acceptedResponse = yield* postMint(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            issuer: "https://relay.example.test",
            jti: "cloud-mint-jti-explicit-relay-issuer",
            nonce: "cloud-mint-nonce-explicit-relay-issuer",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        );
        const rejectedResponse = yield* postMint(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            issuer: "https://transport.example.test",
            jti: "cloud-mint-jti-transport-url",
            nonce: "cloud-mint-nonce-transport-url",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        );

        assert.equal(acceptedResponse.status, 200);
        assert.equal(rejectedResponse.status, 401);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps a managed connector stopped when relay registration fails", () =>
    Effect.gen(function* () {
      const appliedRuntimeConfigs: Array<unknown> = [];
      const relayRequests: Array<HttpClientRequest.HttpClientRequest> = [];
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: (config) =>
              Effect.sync(() => {
                appliedRuntimeConfigs.push(config);
                return config === null
                  ? ({ status: "disabled" } as const)
                  : ({ status: "running", providerKind: "cloudflare_tunnel", pid: 123 } as const);
              }),
          },
          httpClient: HttpClient.make((request) =>
            Effect.sync(() => {
              relayRequests.push(request);
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ message: "relay unavailable" }, { status: 503 }),
              );
            }),
          ),
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-1",
          },
        }),
      });
      const relayConfigBody = yield* responseJsonEffect<{ readonly _tag?: string }>(
        relayConfigResponse,
      );

      assert.equal(relayConfigResponse.status, 500);
      assert.equal(relayConfigBody._tag, "EnvironmentHttpInternalServerError");
      assert.equal(relayRequests.length, 3);
      assert.deepEqual(appliedRuntimeConfigs, [null]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "queues recovery without starting a connector when relay registration requires it",
    () =>
      Effect.gen(function* () {
        const appliedRuntimeConfigs: Array<unknown> = [];
        const requestedRecoveryConfigs: Array<unknown> = [];
        const relayRequests: Array<HttpClientRequest.HttpClientRequest> = [];
        yield* buildAppUnderTest({
          layers: {
            cloudManagedEndpointRuntime: {
              applyConfig: (config) =>
                Effect.sync(() => {
                  appliedRuntimeConfigs.push(config);
                  return config === null
                    ? ({ status: "disabled" } as const)
                    : ({ status: "running", providerKind: "cloudflare_tunnel", pid: 123 } as const);
                }),
              requestRecovery: (config) =>
                Effect.sync(() => {
                  requestedRecoveryConfigs.push(config);
                }),
            },
            httpClient: HttpClient.make((request) =>
              Effect.sync(() => {
                relayRequests.push(request);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status: "recovery_required" }),
                );
              }),
            ),
          },
        });

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "connector-token",
              tunnelId: "tunnel-1",
            },
          }),
        });
        const relayConfigBody = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly endpointRuntimeStatus?: { readonly status?: string };
        }>(relayConfigResponse);

        assert.equal(relayConfigResponse.status, 503);
        assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
        assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "disabled");
        assert.equal(relayRequests.length, 1);
        assert.deepEqual(appliedRuntimeConfigs, [null]);
        assert.deepEqual(requestedRecoveryConfigs, [
          {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-1",
          },
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("fails relay config when the managed endpoint connector cannot start", () =>
    Effect.gen(function* () {
      const appliedRuntimeConfigs: Array<unknown> = [];
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: (config) =>
              Effect.sync(() => {
                appliedRuntimeConfigs.push(config);
                return config === null
                  ? ({ status: "disabled" } as const)
                  : ({
                      status: "failed",
                      providerKind: "cloudflare_tunnel",
                      failure: "not-installed",
                      reason: "cloudflared missing",
                      tunnelId: "tunnel-1",
                    } as const);
              }),
          },
          httpClient: HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ status: "ready" }))),
          ),
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-1",
          },
        }),
      });

      assert.equal(relayConfigResponse.status, 503);
      const relayConfigBody = yield* responseJsonEffect<{
        _tag?: string;
        message?: string;
        endpointRuntimeStatus?: { status?: string; reason?: string };
      }>(relayConfigResponse);
      assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
      assert.equal(relayConfigBody.message, "Managed endpoint runtime could not be started.");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "failed");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.reason, "cloudflared missing");
      assert.deepEqual(appliedRuntimeConfigs, [
        null,
        {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-1",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests with the wrong issuer or audience", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/connect/mint-credential");
      const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
        fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const wrongIssuer = yield* postMint(
        makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          issuer: "https://attacker.example.test",
          jti: "cloud-mint-jti-wrong-issuer",
          nonce: "cloud-mint-nonce-wrong-issuer",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );
      const wrongAudience = yield* postMint(
        makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          audience: "t3-env:other-environment",
          jti: "cloud-mint-jti-wrong-audience",
          nonce: "cloud-mint-nonce-wrong-audience",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );

      assert.equal(wrongIssuer.status, 401);
      assert.equal(wrongAudience.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests for a cloud subject other than the linked user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            subject: "user_other",
            jti: "cloud-mint-jti-wrong-subject",
            nonce: "cloud-mint-nonce-wrong-subject",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests without the exact connect scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            jti: "cloud-mint-jti-duplicate-scope",
            nonce: "cloud-mint-nonce-duplicate-scope",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            scope: ["environment:connect", "environment:connect"],
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests with the wrong issuer or audience", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const postHealth = (request: ReturnType<typeof makeCloudEnvironmentHealthRequest>) =>
        fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const wrongIssuer = yield* postHealth(
        makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          issuer: "https://attacker.example.test",
          jti: "cloud-health-jti-wrong-issuer",
          nonce: "cloud-health-nonce-wrong-issuer",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );
      const wrongAudience = yield* postHealth(
        makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          audience: "t3-env:other-environment",
          jti: "cloud-health-jti-wrong-audience",
          nonce: "cloud-health-nonce-wrong-audience",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );

      assert.equal(wrongIssuer.status, 401);
      assert.equal(wrongAudience.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests for a cloud subject other than the linked user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudEnvironmentHealthRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            subject: "user_other",
            jti: "cloud-health-jti-wrong-subject",
            nonce: "cloud-health-nonce-wrong-subject",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests without the exact status scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudEnvironmentHealthRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            jti: "cloud-health-jti-duplicate-scope",
            nonce: "cloud-health-nonce-duplicate-scope",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            scope: ["environment:status", "environment:status"],
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    (
      [
        ["absent", null],
        ["old", String(ORCHESTRATION_PROTOCOL_VERSION - 1)],
        ["newer", String(ORCHESTRATION_PROTOCOL_VERSION + 1)],
        ["invalid", "not-a-protocol"],
      ] as const
    ).map(([label, protocol]) => ({
      caseTitle: `rejects ${label} WebSocket protocol before authentication or RPC`,
      label,
      protocol,
    })),
  )("$caseTitle", ({ label, protocol }) =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      // Observe the exact memoized live auth service; the spy delegates rather
      // than replacing the production authentication decision.
      const authenticate = vi.spyOn(app.auth, "authenticateWebSocketUpgrade");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          authenticate.mockRestore();
        }),
      );
      const url = new URL(yield* getHttpServerUrl("/ws"));
      if (protocol !== null) url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, protocol);
      const response = yield* fetchEffect(url.toString(), {
        headers: {
          authorization: "Bearer synthetic-invalid-protocol-credential",
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
      });
      const body = yield* response.json;
      assert.equal(response.status, 426);
      assert.deepEqual(body, {
        code: "orchestration_protocol_incompatible",
        message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      });
      assert.equal(authenticate.mock.calls.length, 0);
      assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("preserves authentication and real RPC for the current WebSocket protocol", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const authenticate = vi.spyOn(app.auth, "authenticateWebSocketUpgrade");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          authenticate.mockRestore();
        }),
      );
      const url = new URL(yield* getHttpServerUrl("/ws"));
      url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
      const response = yield* fetchEffect(url.toString());
      const body = yield* responseJsonEffect<{
        readonly _tag: string;
        readonly code: string;
        readonly reason: string;
        readonly traceId: string;
      }>(response);
      assert.equal(response.status, 401);
      assert.equal(body._tag, "EnvironmentAuthInvalidError");
      assert.equal(body.code, "auth_invalid");
      assert.equal(body.reason, "missing_credential");
      assert.isString(body.traceId);
      assert.equal(authenticate.mock.calls.length, 1);

      const config = yield* Effect.scoped(
        withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          client[WS_METHODS.serverGetConfig]({}),
        ),
      );
      assert.equal(config.environment.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(config.auth.policy, "desktop-managed-local");
      assert.equal(authenticate.mock.calls.length, 2);
      assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("negotiates permessage-deflate with clients that offer it", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { cookie, url } = parseSessionCookieFromWsUrl(yield* getWsServerUrl("/ws"));
      const openSocket = (perMessageDeflate: boolean) =>
        Effect.acquireRelease(
          Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume) => {
            const socket = new NodeSocket.NodeWS.WebSocket(url, {
              perMessageDeflate,
              ...(cookie ? { headers: { cookie } } : {}),
            });
            socket.on("open", () => resume(Effect.succeed(socket)));
            socket.on("error", (error) => resume(Effect.fail(error)));
          }),
          (socket) => Effect.sync(() => socket.close()),
        );

      const compressed = yield* openSocket(true);
      // The ws client records the negotiated extension only when the server's
      // 101 response accepted the offer.
      assert.include(compressed.extensions, "permessage-deflate");

      const plain = yield* openSocket(false);
      assert.notInclude(plain.extensions, "permessage-deflate");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServerTestWithWsDeflate)),
  );

  it.effect("issues short-lived websocket tickets for authenticated bearer sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
        readonly expiresAt: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assert.equal(typeof wsTicketBody.ticket, "string");
      assert.isTrue(wsTicketBody.ticket.length > 0);
      assert.equal(typeof wsTicketBody.expiresAt, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not allow management-only access tokens to operate the environment", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: exchangeResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        { scope: "access:write" },
      );
      assert.equal(exchangeResponse.status, 200);
      assert.equal(tokenBody.scope, "access:write");
      assert.isDefined(tokenBody.access_token);

      const overbroadPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({}),
      });
      const overbroadPairingBody = (yield* overbroadPairingResponse.json) as {
        readonly requiredScope: string;
      };
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({ scopes: ["access:write"] }),
      });
      const wsTicketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const wsTicketBody = (yield* wsTicketResponse.json) as { readonly ticket: string };
      assert.equal(overbroadPairingResponse.status, 403);
      assert.equal(overbroadPairingBody.requiredScope, "orchestration:read");
      assert.equal(pairingResponse.status, 200);
      assert.equal(wsTicketResponse.status, 200);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;
      const rpcError = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );
      assert.equal(rpcError._tag, "EnvironmentAuthorizationError");
      if (rpcError._tag === "EnvironmentAuthorizationError") {
        assert.equal(rpcError.requiredScope, "orchestration:read");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote auth success responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const origin = crossOriginClientOrigin;
      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        {
          headers: { origin },
        },
      );

      assert.equal(tokenResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(tokenResponse.headers);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(typeof tokenBody.access_token, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(sessionResponse.headers);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(wsTicketResponse.headers);
      assert.equal(typeof wsTicketBody.ticket, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-ticket preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const response = yield* fetchEffect(wsTicketUrl, {
          method: "OPTIONS",
          headers: {
            origin: crossOriginClientOrigin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows credentialed cloud link proof preflights from the configured dev UI", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL(crossOriginClientOrigin) },
      });

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const response = yield* fetchEffect(linkProofUrl, {
        method: "OPTIONS",
        headers: {
          origin: crossOriginClientOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: crossOriginClientOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows configured development origins through ServerConfig", () =>
    Effect.gen(function* () {
      const tailnetOrigin = "https://host.example.ts.net";
      yield* buildAppUnderTest({
        config: {
          devUrl: new URL(crossOriginClientOrigin),
          devAllowedOrigins: [tailnetOrigin],
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(sessionUrl, {
        method: "OPTIONS",
        headers: {
          origin: tailnetOrigin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: tailnetOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    ["scient://app", "scient-next-dev://app"].map((desktopOrigin) => ({
      caseTitle: `allows credentialed preflights from ${desktopOrigin} in development`,
      desktopOrigin,
    })),
  )("$caseTitle", ({ desktopOrigin }) =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL(crossOriginClientOrigin) },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(sessionUrl, {
        method: "OPTIONS",
        headers: {
          origin: desktopOrigin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: desktopOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote websocket-ticket auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const response = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          origin: crossOriginClientOrigin,
        },
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly code?: string;
        readonly reason?: string;
        readonly traceId?: string;
      }>(response);

      assert.equal(response.status, 401);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.equal(body._tag, "EnvironmentAuthInvalidError");
      assert.equal(body.code, "auth_invalid");
      assert.equal(body.reason, "missing_credential");
      assert.equal(typeof body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly expiresAt: string;
      };

      assert.equal(response.status, 200);
      assert.equal(typeof body.credential, "string");
      assert.isTrue(body.credential.length > 0);
      assert.equal(typeof body.expiresAt, "string");

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(bootstrapResult.response.status, 200);

      const reusedResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(reusedResult.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues pairing credentials for bearer sessions with access management scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
        body: yield* HttpBody.json({ label: "Hosted web" }),
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly label?: string;
      };

      assert.equal(response.status, 200);
      assert.isTrue(body.credential.length > 0);
      assert.equal(body.label, "Hosted web");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credentials with an empty scope grant", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({ scopes: [] }),
      });
      const body = (yield* response.json) as {
        readonly code: string;
        readonly reason: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "invalid_request");
      assert.equal(body.reason, "invalid_scope");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unauthenticated pairing credential requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        body: yield* HttpBody.json({}),
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns only pairing metadata to access-read HTTP sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "access:read",
      });
      assert.equal(reader.response.status, 200);
      assert.equal(reader.body.scope, "access:read");
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: yield* getAuthenticatedSessionCookieHeader() },
        body: yield* HttpBody.json({ label: "Synthetic phone" }),
      });
      const created = (yield* createdResponse.json) as { id: string; credential: string };
      assert.equal(createdResponse.status, 200);
      const response = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
      });
      assert.equal(response.status, 200);
      const responseText = yield* response.text;
      assert.notInclude(responseText, '"credential"');
      assert.notInclude(responseText, created.credential);
      const links = yield* responseJsonEffect<
        ReadonlyArray<{
          readonly id: string;
          readonly label?: string;
          readonly scopes: ReadonlyArray<string>;
          readonly permissions: ReadonlyArray<string>;
        }>
      >(response);
      const listed = links.find((link) => link.id === created.id);
      assert.isDefined(listed);
      assert.deepInclude(listed, {
        label: "Synthetic phone",
        // Frozen legacy scope metadata and the full granular grant are distinct.
        scopes: ["orchestration:read", "orchestration:operate", "terminal:operate", "relay:read"],
        permissions: [...AuthStandardClientScopes],
      });

      const unauthorizedCreate = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
        body: yield* HttpBody.json({}),
      });
      assert.equal(unauthorizedCreate.status, 403);
      const idExchange = yield* exchangeAccessToken(created.id, { scope: "terminal:operate" });
      assert.equal(idExchange.response.status, 401);
      const authorized = yield* exchangeAccessToken(created.credential, {
        scope: AuthStandardClientScopes.join(" "),
      });
      assert.equal(authorized.response.status, 200);
      assert.equal(authorized.body.scope, AuthStandardClientScopes.join(" "));
      const reused = yield* exchangeAccessToken(created.credential, { scope: "terminal:operate" });
      assert.equal(reused.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns only pairing metadata in access-read WebSocket snapshots and updates", () =>
    Effect.gen(function* () {
      const changesSubscribed = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        onPairingChangesSubscribed: Deferred.succeed(changesSubscribed, undefined).pipe(
          Effect.asVoid,
        ),
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createLink = Effect.gen(function* () {
        const response = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        assert.equal(response.status, 200);
        return (yield* response.json) as { id: string; credential: string };
      });
      const initialLink = yield* createLink;
      const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "access:read",
      });
      assert.equal(reader.body.scope, "access:read");
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
      });
      assert.equal(ticketResponse.status, 200);
      const { ticket } = (yield* ticketResponse.json) as { ticket: string };
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(ticket)}`;
      const frames: string[] = [];
      yield* withWsRpcClient(
        wsUrl,
        (client) =>
          Effect.gen(function* () {
            const snapshotReceived = yield* Deferred.make<void>();
            const eventsFiber = yield* client.subscribeAuthAccess({}).pipe(
              Stream.tap((event) =>
                event.type === "snapshot"
                  ? Deferred.succeed(snapshotReceived, undefined)
                  : Effect.void,
              ),
              Stream.takeUntil((event) => event.type === "pairingLinkUpserted"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Deferred.await(snapshotReceived);
            yield* Deferred.await(changesSubscribed);
            const liveLink = yield* createLink;
            const events = yield* Fiber.join(eventsFiber);
            const snapshot = events.find((event) => event.type === "snapshot");
            const update = events.find((event) => event.type === "pairingLinkUpserted");
            assert.isDefined(snapshot);
            assert.isDefined(update);
            assert.isTrue(
              snapshot?.payload.pairingLinks.some((link) => link.id === initialLink.id),
            );
            assert.equal(update?.payload.id, liveLink.id);
            // Inspect the wire frames so client schema decoding cannot hide a leak.
            assert.notInclude(frames.join(""), '"credential"');
            assert.notInclude(frames.join(""), initialLink.credential);
            assert.notInclude(frames.join(""), liveLink.credential);
            const paired = yield* exchangeAccessToken(liveLink.credential, {
              scope: AuthStandardClientScopes.join(" "),
            });
            assert.equal(paired.response.status, 200);
          }),
        (frame) => frames.push(frame),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and revokes pairing links for access management sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string;
        readonly credential: string;
      };

      const listResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string;
      }>;

      const revokeResponse = yield* HttpClient.post("/api/auth/pairing-links/revoke", {
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: HttpBody.text(jsonRequestBody({ id: createdBody.id }), "application/json"),
      });
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

      assert.equal(createdResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokedBootstrap.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credential requests without access management scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      });
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string;
      };
      assert.equal(ownerResponse.status, 200);

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential);
      const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairedBody = (yield* pairedResponse.json) as {
        readonly _tag: string;
        readonly code: string;
        readonly requiredScope: string;
        readonly traceId: string;
      };

      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
      assert.equal(pairedBody.code, "insufficient_scope");
      assert.equal(pairedBody.requiredScope, "access:write");
      assert.equal(typeof pairedBody.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists paired clients and revokes other sessions while keeping the administrator", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* fetchEffect(pairingTokenUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          label: "Julius iPhone",
        }),
      });
      const ownerPairingBody = yield* responseJsonEffect<{
        readonly credential: string;
        readonly label?: string;
      }>(ownerPairingResponse);
      assert.equal(ownerPairingResponse.status, 200);
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        },
      });
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
      assert.isDefined(pairedSessionCookie);

      const pairedSessionCookieHeader = pairedSessionCookie ?? "";
      const listBeforeResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsBefore = (yield* listBeforeResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly browser?: string;
        };
      }>;
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

      const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number;
      };

      const listAfterResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;

      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
        body: yield* HttpBody.json({}),
      });
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly _tag: string;
        readonly code: string;
        readonly reason: string;
        readonly traceId: string;
      };

      assert.equal(listBeforeResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Julius iPhone");
      assert.lengthOf(clientsBefore, 2);
      assert.isDefined(pairedSessionId);
      assert.isDefined(pairedClientBefore);
      assert.deepInclude(pairedClientBefore?.client, {
        label: "Julius iPhone",
        deviceType: "mobile",
        os: "iOS",
        browser: "Safari",
        ipAddress: "127.0.0.1",
      });
      assert.equal(revokeOthersResponse.status, 200);
      assert.equal(revokeOthersBody.revokedCount, 1);
      assert.equal(listAfterResponse.status, 200);
      assert.lengthOf(clientsAfter, 1);
      assert.equal(clientsAfter[0]?.current, true);
      assert.equal(pairedClientPairingResponse.status, 401);
      assert.equal(pairedClientPairingBody._tag, "EnvironmentAuthInvalidError");
      assert.equal(pairedClientPairingBody.code, "auth_invalid");
      assert.equal(pairedClientPairingBody.reason, "invalid_credential");
      assert.equal(typeof pairedClientPairingBody.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("separates access inventory reads from credential management writes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const issueScopedSession = Effect.fnUntraced(function* (
        scope: "access:read" | "access:write",
      ) {
        const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({ scopes: [scope] }),
        });
        assert.equal(pairingResponse.status, 200);
        const pairingBody = (yield* pairingResponse.json) as {
          readonly credential: string;
        };
        return yield* getAuthenticatedSessionCookieHeader(pairingBody.credential);
      });

      const readCookie = yield* issueScopedSession("access:read");
      const readListResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: readCookie,
        },
      });
      const readWriteResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: readCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const readWriteBody = (yield* readWriteResponse.json) as {
        readonly requiredScope: string;
      };

      const writeCookie = yield* issueScopedSession("access:write");
      const writeListResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: writeCookie,
        },
      });
      const writeListBody = (yield* writeListResponse.json) as {
        readonly requiredScope: string;
      };

      assert.equal(readListResponse.status, 200);
      assert.equal(readWriteResponse.status, 403);
      assert.equal(readWriteBody.requiredScope, "access:write");
      assert.equal(writeListResponse.status, 403);
      assert.equal(writeListBody.requiredScope, "access:read");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes an individual paired client session", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
        pairingBody.credential,
      );

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
      assert.isDefined(pairedSessionId);

      const revokeResponse = yield* HttpClient.post("/api/auth/clients/revoke", {
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: HttpBody.text(jsonRequestBody({ sessionId: pairedSessionId }), "application/json"),
      });
      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      });

      assert.equal(revokeResponse.status, 200);
      assert.equal(pairedClientPairingResponse.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows reusing the desktop bootstrap credential", () =>
    Effect.gen(function* () {
      // The desktop-bootstrap grant is delivered over trusted IPC at
      // backend launch and needs to stay claimable after a renderer
      // refresh, so it's intentionally reusable (unlike user-facing
      // one-time pairing credentials).
      yield* buildAppUnderTest();

      const first = yield* bootstrapBrowserSession();
      const second = yield* bootstrapBrowserSession();

      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake with a bootstrapped browser session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.isDefined(cookie);

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(response.auth.policy, "desktop-managed-local");
      assert.equal(response.shellResumeCompletionMarker, true);
      assert.isUndefined(response.shellRevealInFileManager);
      assert.isUndefined(response.shellRevealInFileManagerKind);
      assert.equal(response.threadResumeCompletionMarker, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // SCIENT-FORK:START — Upstream T3 added threads without a project (#13612)
  // and projects created from a name (#14527). Scratch is approved but still
  // withheld in Git data directories; create-from-name remains gated off.
  it.effect("withholds threads without a project inside a Git data directory", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
        },
      });

      yield* Effect.scoped(
        withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});

            assert.isUndefined(config.scratchWorkspaceRoot);

            const ensure = yield* Effect.flip(client[WS_METHODS.projectsEnsureScratch]({}));
            assert.include(String(ensure.message), "not available");
          }),
        ),
      );
      assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
      assert.deepEqual((yield* app.v2.threads.getShellSnapshot()).threads, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("withholds projects created from a name while the Scient gate is off", () =>
    Effect.gen(function* () {
      const gitCalls: Array<string> = [];
      const app = yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            readConfigValue: () => Effect.succeed(null),
            execute: (input) =>
              Effect.sync(() => {
                gitCalls.push(input.args.join(" "));
                return {
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          },
        },
      });

      yield* Effect.scoped(
        withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});

            assert.isUndefined(config.newProjectsRoot);

            const created = yield* Effect.flip(
              client[WS_METHODS.projectsCreateNew]({ name: "Pinball Stats" }),
            );
            assert.include(String(created.message), "not available");
          }),
        ),
      );
      assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
      assert.deepEqual((yield* app.v2.threads.getShellSnapshot()).threads, []);
      assert.deepEqual(gitCalls, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
  // SCIENT-FORK:END

  it.effect("advertises the usable file manager and its reveal label", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
            resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
          },
        },
      });

      const { cookie } = yield* bootstrapBrowserSession();
      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.deepEqual(response.availableEditors, ["file-manager"]);
      assert.equal(response.shellRevealInFileManager, true);
      assert.equal(response.shellRevealInFileManagerKind, "file-explorer");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not block server config when editor discovery never resolves", () =>
    Effect.gen(function* () {
      const discoveryInterrupted = yield* Deferred.make<void>();
      const responseFiber = yield* resolveAvailableEditorsForConfig(
        Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
        ),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(5));

      const availableEditors = yield* Fiber.join(responseFiber);
      yield* Deferred.await(discoveryInterrupted);
      assert.deepEqual(availableEditors, []);
    }),
  );

  it.effect("does not block server config when file manager reveal discovery never resolves", () =>
    Effect.gen(function* () {
      const discoveryInterrupted = yield* Deferred.make<void>();
      const responseFiber = yield* resolveFileManagerRevealKindForConfig(
        Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
        ),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(5));

      const revealKind = yield* Fiber.join(responseFiber);
      yield* Deferred.await(discoveryInterrupted);
      assert.isUndefined(revealKind);
    }),
  );

  it.effect(
    "rejects websocket rpc handshake when a session token is only provided via query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&token=${encodeURIComponent(sessionToken)}`;

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );

        assert.equal(error._tag, "RpcClientError");
        assertInclude(String(error), "SocketOpenError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "accepts websocket rpc handshake with a dedicated websocket ticket in the query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        });
        const wsTicketBody = yield* responseJsonEffect<{
          readonly ticket: string;
        }>(wsTicketResponse);
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies browser OTLP trace exports through the server", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "t3code-web" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "effect",
                  version: "4.0.0-beta.43",
                },
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    parentSpanId: "3333333333333333",
                    name: "RpcClient.server.getSettings",
                    kind: 3,
                    startTimeUnixNano: "1000000",
                    endTimeUnixNano: "2000000",
                    attributes: [
                      {
                        key: "rpc.method",
                        value: { stringValue: "server.getSettings" },
                      },
                    ],
                    events: [
                      {
                        name: "http.request",
                        timeUnixNano: "1500000",
                        attributes: [
                          {
                            key: "http.status_code",
                            value: { intValue: "200" },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: "STATUS_CODE_OK",
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      };

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          origin: "http://localhost:5733",
        },
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(localTraceRecords, [
        {
          type: "otlp-span",
          name: "RpcClient.server.getSettings",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          parentSpanId: "3333333333333333",
          sampled: true,
          kind: "client",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          durationMs: 1,
          attributes: {
            "rpc.method": "server.getSettings",
          },
          resourceAttributes: {
            "service.name": "t3code-web",
          },
          scope: {
            name: "effect",
            version: "4.0.0-beta.43",
            attributes: {},
          },
          events: [
            {
              name: "http.request",
              timeUnixNano: "1500000",
              attributes: {
                "http.status_code": "200",
              },
            },
          ],
          links: [],
          status: {
            code: "STATUS_CODE_OK",
          },
        },
      ]);
      assert.deepEqual(upstreamRequests, [
        {
          body: jsonRequestBody(payload),
          contentType: "application/json",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("forwards browser OTLP traces as protobuf when the protocol is http/protobuf", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      // Produced by effect's own tracer, so enum fields are numeric and the
      // protobuf encoder accepts them. The hand-written payload in the JSON
      // test uses enum names, which only the JSON path tolerates.
      const payload = yield* makeBrowserOtlpPayload("client.protobuf.test");

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
          otlpTracesExport: { ...DEFAULT_SIGNAL_EXPORT, protocol: "http/protobuf" },
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
        },
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      // The local collector still decodes the browser's JSON before forwarding.
      assert.equal(localTraceRecords.length, 1);
      assert.equal(upstreamRequests.length, 1);
      const forwarded = upstreamRequests[0];
      assert.notEqual(forwarded, undefined);
      if (!forwarded) {
        return;
      }
      assert.equal(forwarded.contentType, "application/x-protobuf");
      // Protobuf strings are raw UTF-8, so the span and service names survive
      // the stub's utf8 decode even though the surrounding bytes don't.
      assert.notEqual(forwarded.body[0], "{");
      assert.include(forwarded.body, "client.protobuf.test");
      assert.include(forwarded.body, "t3code-web");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.options("/api/observability/v1/traces", {
        headers: {
          origin: "http://localhost:5733",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-methods"]), [
        "GET",
        "HEAD",
        "OPTIONS",
        "POST",
      ]);
      assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-headers"]), [
        "authorization",
        "b3",
        "content-type",
        "dpop",
        "range",
        "traceparent",
        THREAD_SNAPSHOT_FORMAT_HEADER,
        ORCHESTRATION_PROTOCOL_HEADER,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores browser OTLP trace exports locally when no upstream collector is configured",
    () =>
      Effect.gen(function* () {
        const localTraceRecords: Array<unknown> = [];
        const payload = yield* makeBrowserOtlpPayload("client.test");
        const resourceSpan = payload.resourceSpans[0];
        const scopeSpan = resourceSpan?.scopeSpans[0];
        const span = scopeSpan?.spans[0];

        assert.notEqual(resourceSpan, undefined);
        assert.notEqual(scopeSpan, undefined);
        assert.notEqual(span, undefined);
        if (!resourceSpan || !scopeSpan || !span) {
          return;
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        assert.equal(localTraceRecords.length, 1);
        const record = localTraceRecords[0] as {
          readonly type: string;
          readonly name: string;
          readonly traceId: string;
          readonly spanId: string;
          readonly kind: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly events: ReadonlyArray<unknown>;
          readonly links: ReadonlyArray<unknown>;
          readonly scope: {
            readonly name?: string;
            readonly attributes: Readonly<Record<string, unknown>>;
          };
          readonly resourceAttributes: Readonly<Record<string, unknown>>;
          readonly status?: {
            readonly code?: string;
          };
        };

        assert.equal(record.type, "otlp-span");
        assert.equal(record.name, span.name);
        assert.equal(record.traceId, span.traceId);
        assert.equal(record.spanId, span.spanId);
        assert.equal(record.kind, "internal");
        assert.deepEqual(record.attributes, {});
        assert.deepEqual(record.events, []);
        assert.deepEqual(record.links, []);
        assert.equal(record.scope.name, scopeSpan.scope.name);
        assert.deepEqual(record.scope.attributes, {});
        assert.equal(record.resourceAttributes["service.name"], "t3code-web");
        assert.equal(record.status?.code, String(span.status.code));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.removeKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            removeKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverRemoveKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes custom model mutations without returning the API key", () =>
    Effect.gen(function* () {
      let catalog: CustomModelsSettings = { revision: 0, connections: [] };
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            saveCustomModel: (input) =>
              Effect.sync(() => {
                assert.equal(Redacted.value(input.apiKey!), "synthetic-wire-key");
                catalog = {
                  revision: input.revision + 1,
                  connections: [{ ...input.connection, credentialId: "opaque-ref" }],
                };
                return catalog;
              }),
            removeCustomModel: (input) =>
              Effect.sync(() => {
                assert.equal(input.connectionId, "wire-connection");
                assert.equal(input.revision, 1);
                catalog = { revision: 2, connections: [] };
                return catalog;
              }),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const saved = yield* client[WS_METHODS.serverSaveCustomModel]({
              revision: 0,
              apiKey: Redacted.make("synthetic-wire-key"),
              connection: {
                id: "wire-connection",
                name: "Wire test",
                protocol: "openai-completions",
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            });
            assert.deepEqual(saved, catalog);
            assert.notProperty(saved.connections[0], "apiKey");
            const removed = yield* client[WS_METHODS.serverRemoveCustomModel]({
              revision: 1,
              connectionId: "wire-connection",
            });
            assert.deepEqual(removed, { revision: 2, connections: [] });
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires operate scope for every custom model mutation and connection test", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("droid");
      const catalog: CustomModelsSettings = {
        revision: 1,
        connections: [
          {
            id: "wire-connection",
            name: "Wire test",
            baseUrl: "https://example.test/v1",
            protocol: "openai-completions",
            credentialId: "opaque-ref",
            models: [
              {
                id: "one",
                modelId: "one",
                name: "One",
                configurationMode: "automatic",
                contextWindow: 32000,
                maxOutputTokens: 128,
                images: false,
                reasoning: false,
                instanceIds: [id],
              },
            ],
          },
        ],
      };
      const calls = { reads: 0, saves: 0, removes: 0, resolves: 0, generations: 0 };
      const instance: ProviderInstance = {
        instanceId: id,
        driverKind: ProviderDriverKind.make("droid"),
        enabled: true,
        displayName: "Droid",
        continuationIdentity: { driverKind: ProviderDriverKind.make("droid"), continuationKey: id },
        get orchestrationAdapter(): never {
          throw new Error("Must not start a chat session");
        },
        get snapshot(): never {
          throw new Error("Must not probe a provider");
        },
        textGeneration: {
          generateThreadTitle: () =>
            Effect.sync(() => {
              calls.generations += 1;
              return { title: "Synthetic connection test" };
            }),
          generateBranchName: (): never => {
            throw new Error("Unexpected generation");
          },
          generateCommitMessage: (): never => {
            throw new Error("Unexpected generation");
          },
          generatePrContent: (): never => {
            throw new Error("Unexpected generation");
          },
        },
      };
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.sync(() => {
              calls.reads += 1;
              return { ...DEFAULT_SERVER_SETTINGS, customModels: catalog };
            }),
            saveCustomModel: () =>
              Effect.sync(() => {
                calls.saves += 1;
                return catalog;
              }),
            removeCustomModel: () =>
              Effect.sync(() => {
                calls.removes += 1;
                return catalog;
              }),
            resolveCustomModels: () =>
              Effect.sync(() => {
                calls.resolves += 1;
                return [{ ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") }];
              }),
          },
          providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
        },
      });
      const token = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });
      assert.equal(token.response.status, 200);
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${token.body.access_token ?? ""}` },
      });
      assert.equal(ticketResponse.status, 200);
      const { ticket } = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const readerUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(ticket)}`;
      const save = {
        revision: 1,
        connection: catalog.connections[0]!,
        apiKey: Redacted.make("synthetic-key"),
      };
      const remove = { revision: 1, connectionId: "wire-connection" };
      const test = { revision: 1, connectionId: "wire-connection", modelId: "one", instanceId: id };
      yield* Effect.scoped(
        withWsRpcClient(readerUrl, (client) =>
          Effect.gen(function* () {
            const readable = yield* client[WS_METHODS.serverGetSettings]({});
            assert.equal(readable.customModels.revision, 1);
            const before = { ...calls };
            const results = [
              yield* client[WS_METHODS.serverSaveCustomModel](save).pipe(Effect.result),
              yield* client[WS_METHODS.serverRemoveCustomModel](remove).pipe(Effect.result),
              yield* client[WS_METHODS.serverTestCustomModel](test).pipe(Effect.result),
              // A stale revision must still be denied before configuration reads.
              yield* client[WS_METHODS.serverTestCustomModel]({ ...test, revision: 2 }).pipe(
                Effect.result,
              ),
            ];
            // The first three inputs are valid and attached: a setup error cannot conceal a missing guard.
            assert.deepEqual(calls, before);
            for (const result of results) {
              if (
                result._tag !== "Failure" ||
                result.failure._tag !== "EnvironmentAuthorizationError"
              )
                assert.fail("Expected an operate-scope denial before any custom model effect");
              assert.equal(result.failure.requiredScope, "orchestration:operate");
            }
            assert.equal(
              (yield* client[WS_METHODS.serverGetSettings]({})).customModels.revision,
              1,
            );
          }),
        ),
      );
      const operatorUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(operatorUrl, (client) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* client[WS_METHODS.serverSaveCustomModel](save), catalog);
            assert.deepEqual(yield* client[WS_METHODS.serverRemoveCustomModel](remove), catalog);
            assert.deepEqual(yield* client[WS_METHODS.serverTestCustomModel](test), {
              revision: 1,
            });
            assert.equal(
              (yield* client[WS_METHODS.serverGetSettings]({})).customModels.revision,
              1,
            );
          }),
        ),
      );
      assert.deepEqual(
        {
          saves: calls.saves,
          removes: calls.removes,
          resolves: calls.resolves,
          generations: calls.generations,
        },
        { saves: 1, removes: 1, resolves: 1, generations: 1 },
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects stale or unattached custom model tests through websocket rpc", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            for (const revision of [1, 0]) {
              const result = yield* client[WS_METHODS.serverTestCustomModel]({
                revision,
                connectionId: "missing",
                modelId: "missing",
                instanceId: ProviderInstanceId.make("pi"),
              }).pipe(Effect.result);
              if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
                assert.fail("Expected a custom model setup error");
              assert.equal(
                result.failure.message,
                revision === 1
                  ? "Custom models changed. Test the updated configuration."
                  : "Connect this model to an enabled Pi, Droid, Oh My Pi, or Scient agent first.",
              );
            }
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    [false, true].map((missingCapacity) => ({
      caseTitle: missingCapacity
        ? "delegates an explicit automatic-model test to Droid without requiring Scient limits"
        : "reports a missing custom model key before starting a paid test",
      missingCapacity,
    })),
  )("$caseTitle", ({ missingCapacity }) =>
    Effect.gen(function* () {
      const driver = missingCapacity ? "droid" : "pi";
      let generated = 0;
      const id = ProviderInstanceId.make(driver);
      const catalog: CustomModelsSettings = {
        revision: 1,
        connections: [
          {
            id: "broken",
            name: "Broken",
            baseUrl: "https://example.test/v1",
            protocol: "openai-completions",
            credentialId: "missing",
            models: [
              {
                id: "one",
                modelId: "one",
                name: "One",
                ...(missingCapacity ? { configurationMode: "automatic" as const } : {}),
                contextWindow: 32000,
                maxOutputTokens: 128,
                images: false,
                reasoning: false,
                instanceIds: [id],
              },
            ],
          },
        ],
      };
      const message = "Re-enter the API key for Broken in Custom models.";
      const instance: ProviderInstance = {
        instanceId: id,
        driverKind: ProviderDriverKind.make(driver),
        enabled: true,
        displayName: "Pi",
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(driver),
          continuationKey: id,
        },
        get orchestrationAdapter(): never {
          throw new Error("This fixture must not start a V2 chat session");
        },
        get snapshot(): never {
          throw new Error("Must not probe");
        },
        get textGeneration() {
          if (!missingCapacity) throw new Error("Must not make a paid request");
          return {
            generateThreadTitle: () =>
              Effect.sync(() => {
                generated += 1;
                return { title: "Synthetic test" };
              }),
            generateBranchName: (): never => {
              throw new Error("Unexpected generation");
            },
            generateCommitMessage: (): never => {
              throw new Error("Unexpected generation");
            },
            generatePrContent: (): never => {
              throw new Error("Unexpected generation");
            },
          };
        },
      };
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
            resolveCustomModels: () =>
              Effect.succeed([
                missingCapacity
                  ? { ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") }
                  : { ...catalog.connections[0]!, credentialError: message },
              ]),
          },
          providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.serverTestCustomModel]({
            revision: 1,
            connectionId: "broken",
            modelId: "one",
            instanceId: id,
          }).pipe(Effect.result),
        ),
      );
      if (missingCapacity) {
        assert.equal(result._tag, "Success");
        assert.equal(generated, 1);
        return;
      }
      if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
        assert.fail("Expected a credential setup error");
      assert.equal(result.failure.message, message);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns actionable ACP model-test failures without disconnecting websocket rpc", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("droid");
      const catalog: CustomModelsSettings = {
        revision: 1,
        connections: [
          {
            id: "openrouter",
            name: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            protocol: "openai-completions",
            credentialId: "saved-key",
            models: [
              {
                id: "restricted",
                modelId: "meta/muse-spark-1.3",
                name: "Muse Spark 1.3",
                images: false,
                reasoning: false,
                instanceIds: [id],
              },
            ],
          },
        ],
      };
      const providerFailure = new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error: Agent error",
        data: "403 Complete 18+ age confirmation in OpenRouter settings.",
      });
      const instance: ProviderInstance = {
        instanceId: id,
        driverKind: ProviderDriverKind.make("droid"),
        enabled: true,
        displayName: "Droid",
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("droid"),
          continuationKey: id,
        },
        get orchestrationAdapter(): never {
          throw new Error("This fixture must not start a V2 chat session");
        },
        get snapshot(): never {
          throw new Error("Must not probe");
        },
        textGeneration: {
          generateThreadTitle: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Droid ACP request failed.",
                cause: providerFailure,
              }),
            ),
          generateBranchName: (): never => {
            throw new Error("Unexpected generation");
          },
          generateCommitMessage: (): never => {
            throw new Error("Unexpected generation");
          },
          generatePrContent: (): never => {
            throw new Error("Unexpected generation");
          },
        },
      };
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
            resolveCustomModels: () =>
              Effect.succeed([
                { ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") },
              ]),
          },
          providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const result = yield* client[WS_METHODS.serverTestCustomModel]({
              revision: 1,
              connectionId: "openrouter",
              modelId: "restricted",
              instanceId: id,
            }).pipe(Effect.result);
            if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
              assert.fail("Expected an actionable model-test failure");
            assert.equal(
              result.failure.message,
              "Droid: 403 Complete 18+ age confirmation in OpenRouter settings.",
            );

            const settings = yield* client[WS_METHODS.serverGetSettings]({});
            assert.equal(settings.customModels.revision, 1);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("says why Droid ran no custom model test when its tool blocking is not confirmed", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("droid");
      const catalog: CustomModelsSettings = {
        revision: 1,
        connections: [
          {
            id: "lab",
            name: "Lab",
            baseUrl: "http://127.0.0.1:1/v1",
            protocol: "openai-completions",
            credentialId: "saved-key",
            models: [
              {
                id: "one",
                modelId: "one",
                name: "One",
                images: false,
                reasoning: false,
                instanceIds: [id],
              },
            ],
          },
        ],
      };
      const slug = droidCustomModelId("lab", "one");
      let prompts = 0;
      const current: Record<string, string> = { autonomy_level: "auto-high", model: "gpt-5.6-sol" };
      // Droid's own background generation, in a process whose organization
      // policy dropped the hook that refuses tool calls.
      const textGeneration = yield* makeDroidTextGeneration(
        yield* decodeDroidSettings({ binaryPath: "droid" }),
        {},
        () =>
          Effect.sync(
            () =>
              ({
                handleSessionUpdate: () => Effect.void,
                handleRequestPermission: () => Effect.void,
                handleElicitation: () => Effect.void,
                start: () => Effect.succeed({}),
                getConfigOptions: Effect.sync(() => [
                  {
                    id: "autonomy_level",
                    name: "Autonomy",
                    type: "select" as const,
                    currentValue: current.autonomy_level,
                    options: ["normal", "auto-high"].map((value) => ({ value, name: value })),
                  },
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select" as const,
                    currentValue: current.model,
                    options: ["gpt-5.6-sol", slug].map((value) => ({ value, name: value })),
                  },
                ]),
                setConfigOption: (configId: string, value: string) =>
                  Effect.sync(() => {
                    current[configId] = value;
                    return {};
                  }),
                setModel: (model: string) =>
                  Effect.sync(() => {
                    current.model = model;
                  }),
                backgroundToolGuard: () => Effect.succeed("disabled-by-policy" as const),
                prompt: () =>
                  Effect.sync(() => {
                    prompts += 1;
                    return { stopReason: "end_turn" as const };
                  }),
              }) as unknown as DroidAcpRuntime,
          ),
      ).pipe(Effect.provide(NodeServices.layer));
      const instance: ProviderInstance = {
        instanceId: id,
        driverKind: ProviderDriverKind.make("droid"),
        enabled: true,
        displayName: "Droid",
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("droid"),
          continuationKey: id,
        },
        get orchestrationAdapter(): never {
          throw new Error("This fixture must not start a V2 chat session");
        },
        get snapshot(): never {
          throw new Error("Must not probe");
        },
        textGeneration,
      };
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
            resolveCustomModels: () =>
              Effect.succeed([
                { ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") },
              ]),
          },
          providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.serverTestCustomModel]({
            revision: 1,
            connectionId: "lab",
            modelId: "one",
            instanceId: id,
          }).pipe(Effect.result),
        ),
      );
      if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
        assert.fail("Expected the test to be refused");
      // The Test runs through background generation, so it is refused too, in its own words.
      assert.equal(
        result.failure.message,
        "Droid: Your organization's Droid policy disables Scient's tool blocking, which the test needs, so the test was not run. To try this model, send a message in a Droid thread.",
      );
      assert.equal(prompts, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("says a custom model test timed out and names the agent", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("droid_work");
      const catalog: CustomModelsSettings = {
        revision: 1,
        connections: [
          {
            id: "slow",
            name: "Slow",
            baseUrl: "http://127.0.0.1:1/v1",
            protocol: "openai-completions",
            credentialId: null,
            models: [
              {
                id: "one",
                modelId: "one",
                name: "One",
                images: false,
                reasoning: false,
                instanceIds: [id],
              },
            ],
          },
        ],
      };
      const started = yield* Deferred.make<void>();
      const instance: ProviderInstance = {
        instanceId: id,
        driverKind: ProviderDriverKind.make("droid"),
        enabled: true,
        displayName: "Droid work",
        continuationIdentity: { driverKind: ProviderDriverKind.make("droid"), continuationKey: id },
        get orchestrationAdapter(): never {
          throw new Error("This fixture must not start a V2 chat session");
        },
        get snapshot(): never {
          throw new Error("Must not probe");
        },
        textGeneration: {
          generateThreadTitle: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          generateBranchName: (): never => {
            throw new Error("Unexpected generation");
          },
          generateCommitMessage: (): never => {
            throw new Error("Unexpected generation");
          },
          generatePrContent: (): never => {
            throw new Error("Unexpected generation");
          },
        },
      };
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
            resolveCustomModels: () =>
              Effect.succeed([{ ...catalog.connections[0]!, apiKey: null }]),
          },
          providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const pending = yield* client[WS_METHODS.serverTestCustomModel]({
              revision: 1,
              connectionId: "slow",
              modelId: "one",
              instanceId: id,
            }).pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(started);
            // The timeout's timer registers on the server's own schedule, and its
            // answer travels back in real time. Advance test time once past the
            // timeout and wait; advancing while the answer is on its way would add
            // minutes of test time and trip the connection's own timers.
            const waitLive = (millis: number) =>
              Effect.gen(function* () {
                for (
                  let waited = 0;
                  waited < millis && pending.pollUnsafe() === undefined;
                  waited += 20
                )
                  yield* Effect.sleep("20 millis").pipe(TestClock.withLive);
              });
            yield* waitLive(100);
            for (let attempt = 0; attempt < 3 && pending.pollUnsafe() === undefined; attempt += 1) {
              yield* TestClock.adjust("46 seconds");
              yield* waitLive(2_000);
            }
            return yield* Fiber.join(pending);
          }),
        ),
      );
      if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
        assert.fail("Expected a timed-out test");
      assert.equal(result.failure.message, "Droid work: No response within 45 s.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps agent session import project failures structured over websocket rpc", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const projectId = ProjectId.make("missing-import-project");
      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.agentSessionsImport]({ projectId }).pipe(Effect.flip),
        ),
      );

      assert.equal(error._tag, "AgentSessionImportProjectNotFoundError");
      if (error._tag === "AgentSessionImportProjectNotFoundError") {
        assert.equal(error.projectId, projectId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns scanner skip counts over websocket rpc", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-agent-import-rpc-codex-",
      });
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-agent-import-rpc-workspace-",
      });
      const transcriptDirectory = path.join(codexHome, "sessions", "2026", "08", "31");
      const transcriptPath = path.join(transcriptDirectory, "rollout-skipped.jsonl");
      yield* fileSystem.makeDirectory(transcriptDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        transcriptPath,
        encodeTestJson({
          timestamp: "2026-08-31T12:00:00.000Z",
          type: "session_meta",
          payload: { id: "rpc-skipped-session", cwd: workspaceRoot },
        }),
      );
      yield* fileSystem.utimes(transcriptPath, 0, 0);

      const projectId = ProjectId.make("agent-import-rpc-project");
      const app = yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome },
                },
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                  config: {},
                },
              },
            }),
          },
        },
      });

      yield* app.v2.projects.create({
        commandId: CommandId.make("scanner-native-project"),
        projectId,
        title: "Agent import RPC",
        workspaceRoot,
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const scan = yield* client[WS_METHODS.agentSessionsScan]({});
            assert.deepEqual(
              scan.candidates.map((candidate) => candidate.path),
              [workspaceRoot],
            );
            return yield* client[WS_METHODS.agentSessionsImport]({ projectId });
          }),
        ),
      );

      assert.deepEqual(result, { importedCount: 0, skippedCount: 1 });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads Codex thread feedback through websocket rpc", () =>
    Effect.gen(function* () {
      const input = {
        threadId: ThreadId.make("thread-feedback"),
        reason: "The agent stopped early.",
      };
      const uploadFeedback = vi.fn<NonNullable<ProviderAdapterV2SessionRuntime["uploadFeedback"]>>(
        () => Effect.succeed({ feedbackId: "codex-thread-feedback" }),
      );
      let instance: ProviderInstance | undefined;
      const app = yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: {
            getInstance: (instanceId) =>
              Effect.succeed(
                instanceId === defaultModelSelection.instanceId ? instance : undefined,
              ),
            listInstances: Effect.sync(() => (instance === undefined ? [] : [instance])),
          },
        },
      });
      const nativeAdapter = makeNativeSessionAdapterV2({
        instanceId: defaultModelSelection.instanceId,
        driver: ProviderDriverKind.make("codex"),
        idAllocator: app.v2.idAllocator,
        defaultCwd: app.cwd,
        capabilities: CodexProviderCapabilitiesV2,
        continuations: { offer: () => Effect.void },
        open: () =>
          Effect.succeed({
            nativeId: "controlled-feedback-thread",
            nativeThreadKnown: true,
            send: () => Effect.die("Feedback routing must not start a turn"),
            interrupt: Effect.void,
            respond: () => Effect.die("Feedback routing must not answer a request"),
            resume: () => Effect.void,
          }),
      });
      instance = {
        instanceId: nativeAdmissionInstance.instanceId,
        driverKind: nativeAdmissionInstance.driverKind,
        enabled: true,
        displayName: nativeAdmissionInstance.displayName,
        continuationIdentity: nativeAdmissionInstance.continuationIdentity,
        snapshot: nativeAdmissionInstance.snapshot,
        orchestrationAdapter: {
          ...nativeAdapter,
          openSession: (input) =>
            nativeAdapter
              .openSession(input)
              .pipe(Effect.map((runtime) => ({ ...runtime, uploadFeedback }))),
        },
        get textGeneration(): never {
          throw new Error("Feedback must not generate text");
        },
      };
      yield* seedV2StreamThread(app, input.threadId);
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: app.cwd,
      };
      const runtime = yield* app.v2.providerSessions.open({
        threadId: input.threadId,
        providerSessionId: ProviderSessionId.make("feedback-session"),
        modelSelection: defaultModelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: input.threadId,
        modelSelection: defaultModelSelection,
        runtimePolicy,
      });
      yield* app.v2.eventSink.write({
        events: [
          {
            id: EventId.make("feedback-provider-thread"),
            type: "provider-thread.updated",
            threadId: input.threadId,
            occurredAt: yield* DateTime.now,
            payload: providerThread,
          },
        ],
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.providerUploadFeedback](input)),
      );
      assert.deepStrictEqual(response, { feedbackId: "codex-thread-feedback" });
      const projection = yield* app.v2.threads.getThreadRecords(input.threadId, [
        "providerThreads",
      ]);
      const persistedProviderThread = projection.providerThreads.find(
        (row) => row.id === providerThread.id,
      );
      if (persistedProviderThread === undefined)
        return yield* Effect.die("Expected the feedback provider thread to be persisted");
      assert.deepStrictEqual(uploadFeedback.mock.calls, [
        [
          {
            providerThread: persistedProviderThread,
            reason: input.reason,
          },
        ],
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves absolute host media without a local thread and rejects relative media", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-host-media-" });
      const wsUrl = yield* getWsServerUrl("/ws");
      const threadId = ThreadId.make("thread-on-another-environment");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            for (const [name, mimeType] of [
              ["screenshot.png", "image/png"],
              ["recording.mp4", "video/mp4"],
            ] as const) {
              const filePath = path.join(directory, name);
              yield* fileSystem.writeFileString(filePath, "host media bytes");
              const issued = yield* client[WS_METHODS.assetsCreateUrl]({
                resource: { _tag: "media-file", threadId, path: filePath },
              });
              const response = yield* HttpClient.get(issued.relativeUrl);
              assert.equal(response.status, 200);
              assert.equal(response.headers["content-type"], mimeType);
              assert.equal(yield* response.text, "host media bytes");

              const error = yield* client[WS_METHODS.assetsCreateUrl]({
                resource: { _tag: "media-file", threadId, path: name },
              }).pipe(Effect.flip);
              assert.equal(error._tag, "AssetWorkspaceContextNotFoundError");
            }
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("preserves signed HTML asset MIME types through HTTP compression", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-compressed-asset-",
      });
      const htmlPath = path.join(directory, "report.html");
      const stylePath = path.join(directory, "assets", "report.css");
      const scriptPath = path.join(directory, "assets", "report.js");
      const html = `<!doctype html><title>Compressed report</title><link rel="stylesheet" href="assets/report.css"><script src="assets/report.js"></script>${"<p>report body</p>".repeat(128)}`;
      const style = `.report { color: navy; }\n${"/* compressible style */\n".repeat(128)}`;
      const script = `document.body.dataset.ready = "true";\n${"// compressible script\n".repeat(128)}`;
      yield* fileSystem.makeDirectory(path.dirname(scriptPath), { recursive: true });
      yield* fileSystem.writeFileString(htmlPath, html);
      yield* fileSystem.writeFileString(stylePath, style);
      yield* fileSystem.writeFileString(scriptPath, script);

      const wsUrl = yield* getWsServerUrl("/ws");
      const issued = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.assetsCreateUrl]({
            resource: {
              _tag: "environment-file",
              path: EnvironmentFilePath.make(htmlPath),
              access: "html-document",
            },
          }),
        ),
      );
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));
      const assetUrl = (assetPath: string) => `${ASSET_ROUTE_PREFIX}/${token}/${assetPath}`;

      for (const encoding of ["gzip", "br"] as const) {
        const requestHeaders = { "accept-encoding": encoding };
        const htmlResponse = yield* HttpClient.get(issued.relativeUrl, {
          headers: requestHeaders,
        });
        assert.equal(htmlResponse.status, 200);
        assert.equal(htmlResponse.headers["content-encoding"], encoding);
        assert.equal(htmlResponse.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(
          htmlResponse.headers["content-security-policy"],
          "sandbox allow-scripts allow-forms allow-popups allow-downloads",
        );
        assert.equal(htmlResponse.headers["x-content-type-options"], "nosniff");
        assert.equal(yield* htmlResponse.text, html);

        const styleResponse = yield* HttpClient.get(assetUrl("assets/report.css"), {
          headers: requestHeaders,
        });
        assert.equal(styleResponse.status, 200);
        assert.equal(styleResponse.headers["content-encoding"], encoding);
        assert.match(styleResponse.headers["content-type"] ?? "", /^text\/css/);
        assert.equal(styleResponse.headers["x-content-type-options"], "nosniff");
        assert.equal(yield* styleResponse.text, style);

        const scriptResponse = yield* HttpClient.get(assetUrl("assets/report.js"), {
          headers: requestHeaders,
        });
        assert.equal(scriptResponse.status, 200);
        assert.equal(scriptResponse.headers["content-encoding"], encoding);
        assert.match(scriptResponse.headers["content-type"] ?? "", /javascript/);
        assert.equal(scriptResponse.headers["x-content-type-options"], "nosniff");
        assert.equal(yield* scriptResponse.text, script);
      }

      const headResponse = yield* HttpClient.head(issued.relativeUrl, {
        headers: { "accept-encoding": "identity" },
      });
      assert.equal(headResponse.status, 200);
      assert.equal(headResponse.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(headResponse.headers["content-length"], String(Buffer.byteLength(html)));
      assert.equal(yield* headResponse.text, "");

      const rangeResponse = yield* HttpClient.get(issued.relativeUrl, {
        headers: { "accept-encoding": "br, gzip", range: "bytes=0-14" },
      });
      assert.equal(rangeResponse.status, 206);
      assert.isUndefined(rangeResponse.headers["content-encoding"]);
      assert.equal(rangeResponse.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(rangeResponse.headers["content-range"], `bytes 0-14/${Buffer.byteLength(html)}`);
      assert.equal(yield* rangeResponse.text, "<!doctype html>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
  );

  it.effect("serves draft workspace files without a thread", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wsUrl = yield* getWsServerUrl("/ws");
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-draft-media-" });
      yield* fileSystem.writeFileString(path.join(directory, "note.html"), "<p>draft</p>");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "draft-workspace-file", cwd: directory, path: "note.html" },
            });
            const response = yield* HttpClient.get(issued.relativeUrl);
            assert.equal(response.status, 200);
            assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
            assert.equal(yield* response.text, "<p>draft</p>");
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads image bytes through a signed URL issued by websocket rpc", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            const rejected = yield* HttpClient.post(issued.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3]), "image/png"),
            });
            assert.equal(rejected.status, 400);

            const response = yield* HttpClient.post(issued.relativeUrl, {
              headers: { origin: crossOriginClientOrigin },
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });
            assert.equal(response.status, 204);
            assertBrowserApiCorsResponseHeaders(response.headers);

            const attachmentPath = path.join(config.attachmentsDir, `${issued.attachmentId}.png`);
            assert.isTrue(yield* fileSystem.exists(attachmentPath));

            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId });
            assert.isFalse(yield* fileSystem.exists(attachmentPath));

            const streamed = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "streamed.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            const streamedResponse = yield* HttpClient.post(streamed.relativeUrl, {
              body: HttpBody.stream(Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])), "image/png"),
            });
            assert.equal(streamedResponse.status, 204);
            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: streamed.attachmentId });

            const uploadedFile = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              type: "file",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 6,
            });
            const fileResponse = yield* HttpClient.post(uploadedFile.relativeUrl, {
              body: HttpBody.stream(
                Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
                "application/pdf",
              ),
            });
            assert.equal(fileResponse.status, 204);
            const uploadedFilePath = path.join(
              config.attachmentsDir,
              `${uploadedFile.attachmentId}.pdf`,
            );
            assert.isTrue(yield* fileSystem.exists(uploadedFilePath));

            // A mint that carries the attachment's display name and mime
            // serves a real download filename and Content-Type.
            const download = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "attachment",
                attachmentId: uploadedFile.attachmentId,
                fileName: "report.pdf",
                mimeType: "application/pdf",
              },
            });
            const downloadResponse = yield* HttpClient.get(download.relativeUrl);
            assert.equal(downloadResponse.status, 200);
            assert.equal(
              downloadResponse.headers["content-disposition"],
              'attachment; filename="report.pdf"',
            );
            assert.equal(downloadResponse.headers["content-type"], "application/pdf");

            // Old clients mint without name or mime and still get a download.
            const bareDownload = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "attachment", attachmentId: uploadedFile.attachmentId },
            });
            const bareResponse = yield* HttpClient.get(bareDownload.relativeUrl);
            assert.equal(bareResponse.status, 200);
            assert.equal(bareResponse.headers["content-disposition"], "attachment");
            assert.equal(bareResponse.headers["content-type"], "application/octet-stream");

            yield* client[WS_METHODS.attachmentsDelete]({
              attachmentId: uploadedFile.attachmentId,
            });
            assert.isFalse(yield* fileSystem.exists(uploadedFilePath));
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects an over-limit chunked upload through the route without hanging", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              type: "file",
              name: "big.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 6,
            });
            const NodeHttp = yield* Effect.promise(() => import("node:http"));
            const uploadUrl = new URL(issued.relativeUrl, yield* getHttpServerUrl());
            const status = yield* Effect.callback<number, Error>((resume) => {
              let completed = false;
              const complete = (result: Effect.Effect<number, Error>) => {
                if (completed) return;
                completed = true;
                resume(result);
              };
              const request = NodeHttp.request(
                uploadUrl,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/octet-stream",
                    "transfer-encoding": "chunked",
                  },
                },
                (response) => {
                  request.end();
                  response.resume();
                  response.once("end", () => complete(Effect.succeed(response.statusCode ?? 0)));
                  response.once("error", (error) => complete(Effect.fail(error)));
                },
              );
              request.once("error", (error) => complete(Effect.fail(error)));
              request.flushHeaders();
              request.write(new Uint8Array(4), () => {
                request.write(new Uint8Array(4));
              });

              return Effect.sync(() => request.destroy());
            });
            assert.equal(status, 400);
            assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps feedback errors structured across websocket rpc", () =>
    Effect.gen(function* () {
      const input = {
        threadId: ThreadId.make("thread-feedback-failure"),
        reason: "The agent failed to upload feedback.",
      };
      const threadId = input.threadId;
      const uploadFeedback = vi.fn<NonNullable<ProviderAdapterV2SessionRuntime["uploadFeedback"]>>(
        () =>
          Effect.fail(
            new ProviderAdapterProtocolError({
              driver: ProviderDriverKind.make("codex"),
              detail: "private provider detail",
            }),
          ),
      );
      let instance: ProviderInstance | undefined;
      const app = yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: {
            getInstance: (instanceId) =>
              Effect.succeed(
                instanceId === defaultModelSelection.instanceId ? instance : undefined,
              ),
            listInstances: Effect.sync(() => (instance === undefined ? [] : [instance])),
          },
        },
      });
      const nativeAdapter = makeNativeSessionAdapterV2({
        instanceId: defaultModelSelection.instanceId,
        driver: ProviderDriverKind.make("codex"),
        idAllocator: app.v2.idAllocator,
        defaultCwd: app.cwd,
        capabilities: CodexProviderCapabilitiesV2,
        continuations: { offer: () => Effect.void },
        open: () =>
          Effect.succeed({
            nativeId: "controlled-feedback-failure-thread",
            nativeThreadKnown: true,
            send: () => Effect.die("Feedback routing must not start a turn"),
            interrupt: Effect.void,
            respond: () => Effect.die("Feedback routing must not answer a request"),
            resume: () => Effect.void,
          }),
      });
      instance = {
        instanceId: nativeAdmissionInstance.instanceId,
        driverKind: nativeAdmissionInstance.driverKind,
        enabled: true,
        displayName: nativeAdmissionInstance.displayName,
        continuationIdentity: nativeAdmissionInstance.continuationIdentity,
        snapshot: nativeAdmissionInstance.snapshot,
        orchestrationAdapter: {
          ...nativeAdapter,
          openSession: (input) =>
            nativeAdapter
              .openSession(input)
              .pipe(Effect.map((runtime) => ({ ...runtime, uploadFeedback }))),
        },
        get textGeneration(): never {
          throw new Error("Feedback must not generate text");
        },
      };
      yield* seedV2StreamThread(app, input.threadId);
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: app.cwd,
      };
      const runtime = yield* app.v2.providerSessions.open({
        threadId: input.threadId,
        providerSessionId: ProviderSessionId.make("feedback-failure-session"),
        modelSelection: defaultModelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: input.threadId,
        modelSelection: defaultModelSelection,
        runtimePolicy,
      });
      yield* app.v2.eventSink.write({
        events: [
          {
            id: EventId.make("feedback-failure-provider-thread"),
            type: "provider-thread.updated",
            threadId: input.threadId,
            occurredAt: yield* DateTime.now,
            payload: providerThread,
          },
        ],
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.providerUploadFeedback](input).pipe(Effect.flip),
        ),
      );

      assert.strictEqual(error._tag, "ProviderUploadFeedbackError");
      if (error._tag === "ProviderUploadFeedbackError") {
        assert.strictEqual(error.threadId, threadId);
        assert.strictEqual(error.message, `Failed to upload feedback for thread ${threadId}.`);
        assert.isDefined(error.cause);
      }
      const projection = yield* app.v2.threads.getThreadRecords(input.threadId, [
        "providerThreads",
      ]);
      const persistedProviderThread = projection.providerThreads.find(
        (row) => row.id === providerThread.id,
      );
      if (persistedProviderThread === undefined)
        return yield* Effect.die("Expected the feedback provider thread to be persisted");
      assert.deepStrictEqual(uploadFeedback.mock.calls, [
        [
          {
            providerThread: persistedProviderThread,
            reason: input.reason,
          },
        ],
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      const failureMessage = String(result.failure);
      assertTrue(
        failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
      );
      assertTrue(
        failureMessage.includes("Unauthorized") ||
          failureMessage.includes("An error occurred during Open"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects dormant Codex subscription-sharing RPCs before starting auth", () =>
    Effect.gen(function* () {
      let authCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          providerAuth: {
            start: () =>
              Effect.sync(() => {
                authCalls += 1;
                return providerSetupAuthState;
              }),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const exported = yield* client[WS_METHODS.chatGptReconnectProfile]({
              instanceId: providerSetupInstanceId,
              methodId: "chatgpt",
            }).pipe(Effect.flip);
            assert.equal(exported._tag, "ProviderSetupError");
            const handoff = yield* client[WS_METHODS.chatGptHandoffSubscribe]({
              instanceId: providerSetupInstanceId,
              environmentId: testEnvironmentDescriptor.environmentId,
              attemptId: "synthetic-handoff",
              returnUrl: "scient://auth-return",
              profile: null,
            }).pipe(Stream.runHead, Effect.flip);
            assert.equal(handoff._tag, "ProviderSetupError");
            const callback = yield* client[WS_METHODS.codexAuthCallbackSubscribe]({
              instanceId: providerSetupInstanceId,
              environmentId: testEnvironmentDescriptor.environmentId,
              flowId: "synthetic-callback",
              authorizationUrl: "https://example.com/authorize",
              returnUrl: "scient://auth-return",
            }).pipe(Stream.runHead, Effect.flip);
            assert.equal(callback._tag, "ProviderSetupError");
          }),
        ),
      );
      assert.equal(authCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provider setup lets read-only clients observe installation but not change setup", () =>
    Effect.gen(function* () {
      let installStarts = 0;
      let authCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: {
            getInstance: (instanceId) =>
              Effect.succeed(
                instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
              ),
          },
          antigravityInstallation: {
            start: Effect.sync(() => {
              installStarts += 1;
              return providerSetupInstallState;
            }),
            changes: Stream.succeed(providerSetupInstallState),
          },
          providerAuth: {
            start: () =>
              Effect.sync(() => {
                authCalls += 1;
                return providerSetupAuthState;
              }),
            subscribe: () =>
              Stream.fromEffect(
                Effect.sync(() => {
                  authCalls += 1;
                  return providerSetupAuthState;
                }),
              ),
          },
        },
      });
      const token = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });
      assert.equal(token.response.status, 200);
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${token.body.access_token ?? ""}` },
      });
      const { ticket } = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(ticket)}`;
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
              instanceId: providerSetupInstanceId,
            }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
            assert.deepEqual(observed, providerSetupInstallState);
            const errors = [
              yield* client[WS_METHODS.providerInstallStart]({
                instanceId: providerSetupInstanceId,
              }).pipe(Effect.flip),
              yield* client[WS_METHODS.providerAuthStart]({
                instanceId: providerSetupInstanceId,
              }).pipe(Effect.flip),
              yield* client[WS_METHODS.providerAuthSubscribe]({
                instanceId: providerSetupInstanceId,
              }).pipe(Stream.runHead, Effect.flip),
            ];
            for (const error of errors) {
              assert.equal(error._tag, "EnvironmentAuthorizationError");
              if (error._tag === "EnvironmentAuthorizationError") {
                assert.equal(error.requiredScope, "orchestration:operate");
              }
            }
          }),
        ),
      );
      assert.equal(installStarts, 0);
      assert.equal(authCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provider setup binds private sign-in to the authenticated websocket session", () =>
    Effect.gen(function* () {
      const flowId = "private-sign-in-flow";
      const callbackUrl = "http://127.0.0.1:51234/?state=test-state&code=test-code";
      const waiting: ProviderAuthState = {
        ...providerSetupAuthState,
        phase: "waiting",
        flowId,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
        expiresAt: "2026-09-02T00:05:00.000Z",
      };
      const calls: Array<{
        readonly operation: string;
        readonly instanceId: ProviderInstanceId;
        readonly ownerSessionId: string;
      }> = [];
      const forwardedCallbacks: string[] = [];
      const logoutInstances: ProviderInstanceId[] = [];
      let flowOwner = "";
      const controller: ProviderAuthController = {
        start: (ownerSessionId) =>
          Effect.sync(() => {
            flowOwner = ownerSessionId;
            calls.push({ operation: "start", instanceId: providerSetupInstanceId, ownerSessionId });
            return waiting;
          }),
        subscribe: (ownerSessionId) =>
          Stream.fromEffect(
            Effect.sync(() => {
              calls.push({
                operation: "subscribe",
                instanceId: providerSetupInstanceId,
                ownerSessionId,
              });
              return ownerSessionId === flowOwner
                ? waiting
                : { ...waiting, flowId: null, authorizationUrl: null, expiresAt: null };
            }),
          ),
        complete: (ownerSessionId, input) =>
          Effect.gen(function* () {
            calls.push({
              operation: "complete",
              instanceId: providerSetupInstanceId,
              ownerSessionId,
            });
            if (ownerSessionId !== flowOwner)
              return yield* new ProviderSetupError({
                instanceId: providerSetupInstanceId,
                operation: "complete",
                detail: "This sign-in belongs to another client.",
              });
            assert.equal(input.flowId, flowId);
            forwardedCallbacks.push(input.callbackUrl);
            return { ...waiting, phase: "verifying" as const, authorizationUrl: null };
          }),
        cancel: (ownerSessionId, cancelledFlowId) =>
          Effect.sync(() => {
            assert.equal(cancelledFlowId, flowId);
            calls.push({
              operation: "cancel",
              instanceId: providerSetupInstanceId,
              ownerSessionId,
            });
            return { ...providerSetupAuthState, phase: "cancelled" as const, flowId };
          }),
        logout: (stopSessions) =>
          stopSessions.pipe(
            Effect.andThen(
              Effect.sync(() => {
                logoutInstances.push(providerSetupInstanceId);
                return providerSetupAuthState;
              }),
            ),
          ),
      };
      const instance: ProviderInstance = {
        instanceId: providerSetupInstanceId,
        driverKind: providerSetupDriver,
        enabled: true,
        displayName: providerSetupInstance.displayName,
        continuationIdentity: providerSetupInstance.continuationIdentity,
        auth: controller,
        get orchestrationAdapter(): never {
          throw new Error("Sign-in must not open native sessions");
        },
        get snapshot(): never {
          throw new Error("Sign-in must not probe snapshots");
        },
        get textGeneration(): never {
          throw new Error("Sign-in must not generate text");
        },
      };
      const changes = yield* PubSub.unbounded<void>();
      yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === instance.instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            subscribeChanges: PubSub.subscribe(changes),
          },
        },
      });
      const firstCookie = yield* getAuthenticatedSessionCookieHeader();
      const secondCookie = yield* getAuthenticatedSessionCookieHeader();
      const firstClients = yield* HttpClient.get("/api/auth/clients", {
        headers: { cookie: firstCookie },
      }).pipe(
        Effect.flatMap(
          responseJsonEffect<
            ReadonlyArray<{ readonly sessionId: string; readonly current: boolean }>
          >,
        ),
      );
      const secondClients = yield* HttpClient.get("/api/auth/clients", {
        headers: { cookie: secondCookie },
      }).pipe(
        Effect.flatMap(
          responseJsonEffect<
            ReadonlyArray<{ readonly sessionId: string; readonly current: boolean }>
          >,
        ),
      );
      const firstOwner = firstClients.find((session) => session.current)?.sessionId;
      const secondOwner = secondClients.find((session) => session.current)?.sessionId;
      assert.isString(firstOwner);
      assert.isString(secondOwner);
      assert.notEqual(firstOwner, secondOwner);
      const baseWsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const target = {
        instanceId: providerSetupInstanceId,
        ownerSessionId: "client-supplied-owner",
      };
      yield* Effect.scoped(
        withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, firstCookie), (client) =>
          Effect.gen(function* () {
            const started = yield* client[WS_METHODS.providerAuthStart](target);
            assert.equal(started.flowId, flowId);
            const ownState = yield* client[WS_METHODS.providerAuthSubscribe](target).pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            assert.equal(ownState.authorizationUrl, waiting.authorizationUrl);
            yield* Effect.scoped(
              withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, secondCookie), (otherClient) =>
                Effect.gen(function* () {
                  const otherState = yield* otherClient[WS_METHODS.providerAuthSubscribe](
                    target,
                  ).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
                  assert.isNull(otherState.authorizationUrl);
                  assert.isNull(otherState.flowId);
                  const forged = { ...target, ownerSessionId: firstOwner, flowId, callbackUrl };
                  const denied = yield* otherClient[WS_METHODS.providerAuthComplete](forged).pipe(
                    Effect.flip,
                  );
                  assert.equal(denied._tag, "ProviderSetupError");
                  assert.deepEqual(forwardedCallbacks, []);
                }),
              ),
            );
            const completed = yield* client[WS_METHODS.providerAuthComplete]({
              ...target,
              flowId,
              callbackUrl,
            });
            assert.equal(completed.phase, "verifying");
            const cancelled = yield* client[WS_METHODS.providerAuthCancel]({ ...target, flowId });
            assert.equal(cancelled.phase, "cancelled");
            const signedOut = yield* client[WS_METHODS.providerAuthLogout](target);
            assert.equal(signedOut.phase, "idle");
          }),
        ),
      );
      assert.deepEqual(forwardedCallbacks, [callbackUrl]);
      assert.deepEqual(logoutInstances, [providerSetupInstanceId]);
      assert.isTrue(calls.every((call) => call.instanceId === providerSetupInstanceId));
      assert.deepEqual(
        calls.map((call) => call.ownerSessionId),
        [firstOwner, firstOwner, secondOwner, secondOwner, firstOwner, firstOwner],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "provider setup routes installation operations and returns only safe typed errors",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let state = providerSetupInstallState;
        yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (instanceId) =>
                Effect.succeed(
                  instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
                ),
            },
            antigravityInstallation: {
              start: Effect.sync(() => {
                calls.push("start");
                return state;
              }),
              cancel: (operationId) =>
                Effect.gen(function* () {
                  calls.push(`cancel:${operationId}`);
                  if (operationId !== state.operationId) {
                    return yield* new AntigravityInstallationError({
                      operation: "cancel",
                      detail: "This installation is no longer running.",
                      cause: new Error("Private download diagnostics."),
                    });
                  }
                  state = { ...state, phase: "cancelled" };
                  return state;
                }),
              changes: Stream.fromEffect(Effect.sync(() => state)),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const unknownInstance = yield* client[WS_METHODS.providerInstallStart]({
                instanceId: ProviderInstanceId.make("unknown-instance"),
              }).pipe(Effect.flip);
              assert.equal(unknownInstance._tag, "ProviderSetupError");
              assert.deepEqual(calls, []);
              const started = yield* client[WS_METHODS.providerInstallStart]({
                instanceId: providerSetupInstanceId,
              });
              assert.deepEqual(started, providerSetupInstallState);
              const stale = yield* client[WS_METHODS.providerInstallCancel]({
                instanceId: providerSetupInstanceId,
                operationId: "old-operation",
              }).pipe(Effect.flip);
              assert.equal(stale._tag, "ProviderSetupError");
              if (stale._tag === "ProviderSetupError") {
                assert.equal(stale.instanceId, providerSetupInstanceId);
                assert.equal(stale.operation, "cancel");
                assert.equal(stale.detail, "This installation is no longer running.");
                assert.notProperty(stale, "cause");
              }
              const cancelled = yield* client[WS_METHODS.providerInstallCancel]({
                instanceId: providerSetupInstanceId,
                operationId: "install-operation",
              });
              assert.equal(cancelled.phase, "cancelled");
              const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
                instanceId: providerSetupInstanceId,
              }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
              assert.deepEqual(observed, cancelled);
            }),
          ),
        );
        assert.deepEqual(calls, ["start", "cancel:old-operation", "cancel:install-operation"]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providers = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          otlpLogsUrl: "http://localhost:4318/v1/logs",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(path.basename(first.config.observability.logsDirectoryPath), "logs");
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.equal(first.config.observability.otlpLogsUrl, "http://localhost:4318/v1/logs");
        assert.equal(first.config.observability.otlpLogsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { keybindings: [], issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    (["all", "targeted", "background"] as const).map((mode) => ({
      caseTitle: `provider refresh invalidates T3 caches before probing (${mode})`,
      mode,
    })),
  )("$caseTitle", ({ mode }) => {
    const driver = ProviderDriverKind.make("codex");
    const instanceIds = [ProviderInstanceId.make("codex"), ProviderInstanceId.make("codex_work")];
    const packageNames = ["@example/personal", "@example/work"];
    const invalidated: string[] = [];
    const freshMaintenance: string[] = [];
    let manifestRefreshed = false;
    let probed = false;
    const instances = instanceIds.map(
      (instanceId, index) =>
        ({
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: instanceId },
          displayName: undefined,
          enabled: true,
          invalidateCaches: Effect.sync(() => {
            invalidated.push(instanceId);
          }),
          snapshot: {
            resolveMaintenance: (options) =>
              Effect.sync(() => {
                assert.isTrue(options?.fresh);
                freshMaintenance.push(instanceId);
                return makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: packageNames[index]!,
                });
              }),
            getSnapshot: Effect.never,
            refresh: Effect.never,
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          get orchestrationAdapter(): never {
            throw new Error("Provider refresh must not start a V2 chat session");
          },
          textGeneration: {} as ProviderInstance["textGeneration"],
        }) satisfies ProviderInstance,
    );
    const expected =
      mode === "background" ? [] : mode === "targeted" ? [instanceIds[1]!] : instanceIds;
    const probe = (versionCache: ProviderLatestVersions.ProviderLatestVersions["Service"]) =>
      Effect.gen(function* () {
        probed = true;
        assert.equal(manifestRefreshed, mode !== "background");
        assert.deepEqual(invalidated.toSorted(), expected.toSorted());
        assert.deepEqual(freshMaintenance.toSorted(), expected.toSorted());
        for (let index = 0; index < instanceIds.length; index++) {
          assert.equal(
            yield* versionCache.cached(packageNames[index]!, Effect.succeed("2.0.0")),
            expected.includes(instanceIds[index]!) ? "2.0.0" : "1.0.0",
          );
        }
        return [];
      });
    return Effect.gen(function* () {
      const versionCache = yield* ProviderLatestVersions.make(
        packageNames.map((name) => [name, "1.0.0"] as const),
      );
      yield* buildAppUnderTest({
        layers: {
          providerLatestVersions: versionCache,
          modelManifest: {
            forceRefresh: Effect.sync(() => {
              manifestRefreshed = true;
              return ModelManifest.BUNDLED_MODEL_MANIFEST;
            }),
          },
          providerInstanceRegistry: { listInstances: Effect.succeed(instances) },
          providerRegistry: {
            refresh: () => probe(versionCache),
            refreshInstance: () => probe(versionCache),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.serverRefreshProviders]({
            ...(mode === "targeted" ? { instanceId: instanceIds[1]! } : {}),
            ...(mode !== "background" ? { refreshModels: true } : {}),
          }),
        ),
      );
      assert.isTrue(probed);
    }).pipe(Effect.provide(NodeHttpServer.layerTest));
  });

  it.effect("serves config on reconnect without starting provider probes", () =>
    Effect.gen(function* () {
      const refresh = vi.fn(() => Effect.never);
      yield* buildAppUnderTest({
        layers: { providerRegistry: { refresh } },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      for (let connection = 0; connection < 2; connection += 1) {
        const event = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            ),
          ),
        );
        assert.equal(event.type, "snapshot");
      }
      assert.equal(refresh.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns cached whole-host resources over websocket", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const [first, second] = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all(
            [
              client[WS_METHODS.serverGetHostResources]({}),
              client[WS_METHODS.serverGetHostResources]({}),
            ],
            { concurrency: "unbounded" },
          ),
        ),
      );
      assert.deepEqual(first, second);
      assert.isAtLeast(first.sampledAt, 0);
      assert.isAbove(first.cpuCount, 0);
      assert.isAbove(first.totalMemoryBytes, 0);
      assert.isAtLeast(first.availableMemoryBytes, 0);
      assert.isAtMost(first.availableMemoryBytes, first.totalMemoryBytes);
      if (first.cpuUtilization !== null) {
        assert.isAtLeast(first.cpuUtilization, 0);
        assert.isAtMost(first.cpuUtilization, 1);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("counts macOS reclaimable memory once and shares concurrent samples", () =>
    Effect.gen(function* () {
      const commandCalls = yield* Ref.make(0);
      const hostResources = yield* HostResources.make().pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            string: () =>
              Ref.update(commandCalls, (count) => count + 1).pipe(
                Effect.as(
                  "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
                    "Pages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n" +
                    "Pages purgeable: 999.\n",
                ),
              ),
          }),
        ),
      );
      const [first, second] = yield* Effect.all([hostResources.read, hostResources.read], {
        concurrency: "unbounded",
      });
      assert.equal(first.availableMemoryBytes, 35 * 16384);
      assert.deepEqual(first, second);
      assert.deepEqual(yield* hostResources.read, first);
      assert.equal(yield* Ref.get(commandCalls), 1);
    }).pipe(TestClock.withLive),
  );

  it.effect("retries host sampling immediately after its caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const commandCalls = yield* Ref.make(0);
      const hostResources = yield* HostResources.make().pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            string: () =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(commandCalls, (count) => count + 1);
                if (call === 1) {
                  yield* Deferred.succeed(started, undefined);
                  return yield* Effect.never;
                }
                return (
                  "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n" +
                  "Pages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n"
                );
              }),
          }),
        ),
      );
      const firstRead = yield* hostResources.read.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(firstRead);
      const recovered = yield* hostResources.read;
      assert.equal(recovered.availableMemoryBytes, 35 * 4096);
      assert.equal(yield* Ref.get(commandCalls), 2);
    }).pipe(TestClock.withLive),
  );

  it.effect("routes websocket resource telemetry through the subscription", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshot = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(Stream.runHead),
        ),
      );

      assertTrue(Option.isSome(snapshot));
      assert.equal(snapshot.value.processes.length, 0);
      assert.equal(snapshot.value.groups.backend.processCount, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // An already-shipped client decodes this stream against an event union
  // without environmentThemesUpdated, so an ungated emit would kill its whole
  // config subscription. Opting in is the only way to receive them.
  it.effect("subscribeServerConfig sends published themes to an opt-in subscriber", () =>
    Effect.gen(function* () {
      const themes = [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark" as const,
          canvas: "#1a1b26",
          accent: "#7aa2f7",
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          environmentTheme: {
            current: Effect.succeed(themes),
            streamChanges: Stream.succeed(themes),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({ environmentThemes: true }).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      // Not in the snapshot as well, or every opt-in client receives the same
      // array twice on every connect.
      if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
      assert.equal(second?.type, "environmentThemesUpdated");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeServerConfig withholds published themes from other subscribers", () =>
    Effect.gen(function* () {
      const themes = [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark" as const,
          canvas: "#1a1b26",
          accent: "#7aa2f7",
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          environmentTheme: {
            current: Effect.succeed(themes),
            streamChanges: Stream.succeed(themes),
          },
          providerRegistry: { streamChanges: Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(1), Stream.runCollect),
        ),
      );

      const first = Array.from(events)[0];
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([false, true])(
    "routes websocket rpc subscribeServerConfig emits provider status updates (limits: %s)",
    (hasLimits) =>
      Effect.gen(function* () {
        const nextProviders = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            checkedAt: "2026-04-11T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
            ...(hasLimits
              ? {
                  usageLimits: {
                    checkedAt: "2026-04-11T00:00:00.000Z",
                    windows: [
                      { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
                    ],
                  },
                }
              : {}),
          },
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({
                keybindings: [],
                issues: [],
              }),
              streamChanges: Stream.empty,
            },
            providerRegistry: {
              getProviders: Effect.succeed([]),
              streamChanges: Stream.succeed(nextProviders),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({ usageLimitsCommand: true }).pipe(
              Stream.take(2),
              Stream.runCollect,
            ),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, []);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "providerStatuses",
          payload: {
            providers: hasLimits
              ? [
                  {
                    ...nextProviders[0],
                    slashCommands: [
                      {
                        name: "usage-limits",
                        description: "Show this provider's usage limits",
                      },
                    ],
                  },
                ]
              : nextProviders,
          },
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerConfig keeps the limits command from clients that do not ask for it",
    () =>
      Effect.gen(function* () {
        const codex = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt: "2026-04-11T00:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 }],
          },
        };
        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
              streamChanges: Stream.empty,
            },
            providerRegistry: {
              getProviders: Effect.succeed([codex]),
              streamChanges: Stream.succeed([{ ...codex, version: "1.0.1" }]),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, [codex]);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "providerStatuses",
          payload: { providers: [{ ...codex, version: "1.0.1" }] },
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerConfig republishes commands when only a limits source changes",
    () =>
      Effect.gen(function* () {
        const codex = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        };
        const hub = {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy" as const,
          label: "Accounts",
          checkedAt: "2026-04-11T00:00:00.000Z",
          accounts: [
            {
              id: "work",
              driver: ProviderDriverKind.make("codex"),
              usageLimits: {
                checkedAt: "2026-04-11T00:00:00.000Z",
                windows: [
                  { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
                ],
              },
            },
          ],
        };

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
              streamChanges: Stream.empty,
            },
            // The registry emits no change: only the source refresh can carry it.
            providerRegistry: {
              getProviders: Effect.succeed([codex]),
              streamChanges: Stream.empty,
            },
            usageLimitSources: {
              current: Effect.succeed([]),
              // Replay the empty snapshot, then a later refresh, as the live stream does.
              streamChanges: Stream.concat(Stream.make([]), Stream.make([hub])),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({ usageLimitsCommand: true }).pipe(
              Stream.take(2),
              Stream.runCollect,
            ),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, [codex]);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "providerStatuses",
          payload: {
            providers: [
              {
                ...codex,
                slashCommands: [
                  { name: "usage-limits", description: "Show this provider's usage limits" },
                ],
              },
            ],
          },
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("delivers provider statuses over websocket while registry updates continue", () =>
    Effect.gen(function* () {
      const updates = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const subscribed = yield* Deferred.make<void>();
      const provider = {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-08-23T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.flatMap(() => Stream.fromQueue(updates)),
            ),
          },
        },
      });
      const url = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(url, (client) =>
          Effect.gen(function* () {
            const snapshot = yield* Deferred.make<void>();
            const delivered = yield* Deferred.make<ReadonlyArray<ServerProvider>>();
            const consumer = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
              Stream.runForEach((event) =>
                event.type === "snapshot"
                  ? Deferred.succeed(snapshot, undefined).pipe(Effect.asVoid)
                  : event.type === "providerStatuses"
                    ? Deferred.succeed(delivered, event.payload.providers).pipe(Effect.asVoid)
                    : Effect.void,
              ),
              Effect.forkChild,
            );
            yield* Deferred.await(snapshot);
            yield* Deferred.await(subscribed);
            let revision = 0;
            // Keep the change source open and busy until reception; debounce cannot
            // satisfy this witness by flushing only when a finite source ends.
            const producer = yield* Effect.gen(function* () {
              while (true) {
                revision += 1;
                yield* Queue.offer(updates, [{ ...provider, version: `1.0.${revision}` }]);
                yield* Effect.sleep("50 millis");
              }
            }).pipe(Effect.forkChild);
            const received = yield* Deferred.await(delivered).pipe(Effect.timeout("3 seconds"));
            assert.equal(received.length, 1);
            assert.equal(received[0]?.instanceId, provider.instanceId);
            assert.equal(received[0]?.status, "ready");
            assert.notEqual(received[0]?.version, "1.0.0");
            yield* Fiber.interrupt(producer);
            yield* Fiber.interrupt(consumer);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("coalesces sustained provider updates without starving the latest state", () =>
    Effect.gen(function* () {
      const updates = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const observed = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const consumer = yield* coalesceProviderStatusUpdates(Stream.fromQueue(updates)).pipe(
        Stream.runForEach((providers) => Queue.offer(observed, providers)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const activeProvider = {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "warning" as const,
        auth: { status: "unauthenticated" as const },
        checkedAt: "2026-08-23T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const terminalProvider = {
        ...activeProvider,
        status: "ready" as const,
        checkedAt: "2026-08-23T00:00:00.100Z",
      } satisfies ServerProvider;

      yield* Queue.offer(updates, [activeProvider]);
      yield* TestClock.adjust("100 millis");
      yield* Queue.offer(updates, [terminalProvider]);
      yield* TestClock.adjust("101 millis");
      yield* Effect.yieldNow;

      const latest = yield* Queue.poll(observed);
      assert.isTrue(Option.isSome(latest));
      assert.deepEqual(Option.getOrUndefined(latest), [terminalProvider]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("redacts provider authorization material from read-only clients", () =>
    Effect.gen(function* () {
      const providers = [
        {
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          enabled: true,
          installed: true,
          version: "1.0.5",
          status: "warning" as const,
          auth: { status: "unauthenticated" as const },
          checkedAt: "2026-08-23T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          connection: {
            methods: ["grok_account" as const, "grok_device_code" as const],
            canDisconnect: false,
            operation: {
              operationId: "grok-operation",
              method: "grok_device_code" as const,
              status: "waiting_for_device_code" as const,
              startedAt: "2026-08-23T00:00:00.000Z",
              finishedAt: null,
              message: "Finish signing in.",
              authorizationUrl: "https://accounts.x.ai/device?user_code=GROK-1234",
              authorizationUrlKind: "manual_fallback" as const,
              acceptsAuthorizationCode: true,
              userCode: "GROK-1234",
              instructions: "Enter code: GROK-1234",
            },
            accountOperation: {
              operationId: "account-operation",
              method: "scient_agent_account" as const,
              status: "waiting_for_device_code" as const,
              startedAt: "2026-08-23T00:00:00.000Z",
              finishedAt: null,
              message: "Finish signing in.",
              account: "openai-codex",
              authorizationUrl: "https://auth.example.com/device",
              authorizationUrlKind: "primary" as const,
              userCode: "ACCT-1234",
              instructions: "Enter code: ACCT-1234",
            },
          },
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
            streamChanges: Stream.succeed(
              providers.map((provider) => ({
                ...provider,
                checkedAt: "2026-08-23T00:00:01.000Z",
              })),
            ),
          },
        },
      });

      const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });
      assert.isDefined(tokenBody.access_token);
      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{ readonly ticket: string }>(wsTicketResponse);
      const readOnlyWsUrl = `${yield* getWsServerUrl("/ws", {
        authenticated: false,
      })}&wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;
      const readOnlyResult = yield* Effect.scoped(
        withWsRpcClient(readOnlyWsUrl, (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});
            const events = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
              Stream.filter((event) => event.type === "providerStatuses"),
              Stream.take(1),
              Stream.runCollect,
            );
            return { config, events };
          }),
        ),
      );

      const assertAuthorizationMaterialRedacted = (provider: ServerProvider | undefined) => {
        assert.isDefined(provider);
        assert.equal(provider?.connection?.operation?.status, "waiting_for_device_code");
        assert.equal(provider?.connection?.operation?.acceptsAuthorizationCode, true);
        assert.isUndefined(provider?.connection?.operation?.authorizationUrl);
        assert.isUndefined(provider?.connection?.operation?.authorizationUrlKind);
        assert.isUndefined(provider?.connection?.operation?.userCode);
        assert.isUndefined(provider?.connection?.operation?.instructions);
        const accountOperation = provider?.connection?.accountOperation;
        assert.equal(accountOperation?.account, "openai-codex");
        assert.isUndefined(accountOperation?.authorizationUrl);
        assert.isUndefined(accountOperation?.authorizationUrlKind);
        assert.isUndefined(accountOperation?.userCode);
        assert.isUndefined(accountOperation?.instructions);
      };

      assertAuthorizationMaterialRedacted(readOnlyResult.config.providers[0]);
      const providerUpdate = Array.from(readOnlyResult.events).find(
        (event) => event.type === "providerStatuses",
      );
      assert.equal(providerUpdate?.type, "providerStatuses");
      if (providerUpdate?.type === "providerStatuses") {
        assertAuthorizationMaterialRedacted(providerUpdate.payload.providers[0]);
      }

      const operatorWsUrl = yield* getWsServerUrl("/ws");
      const operatorResult = yield* Effect.scoped(
        withWsRpcClient(operatorWsUrl, (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});
            const update = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
              Stream.filter((event) => event.type === "providerStatuses"),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            return { config, update };
          }),
        ),
      );
      const operatorConfig = operatorResult.config;
      assert.equal(operatorResult.update.type, "providerStatuses");
      if (operatorResult.update.type === "providerStatuses") {
        assert.equal(
          operatorResult.update.payload.providers[0]?.connection?.operation?.authorizationUrl,
          "https://accounts.x.ai/device?user_code=GROK-1234",
        );
        assert.equal(
          operatorResult.update.payload.providers[0]?.connection?.operation?.userCode,
          "GROK-1234",
        );
      }
      assert.equal(
        operatorConfig.providers[0]?.connection?.operation?.authorizationUrl,
        "https://accounts.x.ai/device?user_code=GROK-1234",
      );
      assert.equal(operatorConfig.providers[0]?.connection?.operation?.userCode, "GROK-1234");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: "2026-01-01T00:00:00.000Z", environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeServerLifecycle buffers updates published during snapshot capture", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
      const streamSubscribed = yield* Deferred.make<void>();
      const snapshotPublished = yield* Deferred.make<void>();
      const bootstrapProjectId = ProjectId.make("project-bootstrap");
      const bootstrapThreadId = ThreadId.make("thread-bootstrap");
      const snapshotEvent = {
        version: 1 as const,
        sequence: 1,
        type: "welcome" as const,
        payload: {
          environment: testEnvironmentDescriptor,
          cwd: "/tmp/project",
          projectName: "project",
          bootstrapStatus: "pending" as const,
        },
      };
      const gapEvent = {
        version: 1 as const,
        sequence: 2,
        type: "welcome" as const,
        payload: {
          environment: testEnvironmentDescriptor,
          cwd: "/tmp/project",
          projectName: "project",
          bootstrapStatus: "complete" as const,
          bootstrapProjectId,
          bootstrapThreadId,
          bootstrapProjectCreated: true,
          bootstrapThreadCreated: true,
        },
      };
      const sentinelEvent = {
        version: 1 as const,
        sequence: 3,
        type: "ready" as const,
        payload: { at: "2026-01-01T00:00:01.000Z", environment: testEnvironmentDescriptor },
      };
      const liveStream = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          yield* Deferred.succeed(streamSubscribed, undefined);
          return Stream.fromSubscription(subscription);
        }),
      );

      yield* buildAppUnderTest({
        layers: {
          serverLifecycleEvents: {
            snapshot: PubSub.publish(pubsub, gapEvent).pipe(
              Effect.andThen(Deferred.succeed(snapshotPublished, undefined)),
              Effect.as({ sequence: 1, events: [snapshotEvent] }),
            ),
            stream: liveStream,
          },
        },
      });

      yield* Effect.gen(function* () {
        yield* Deferred.await(snapshotPublished);
        yield* Deferred.await(streamSubscribed);
        yield* PubSub.publish(pubsub, sentinelEvent);
      }).pipe(Effect.forkScoped);

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "welcome");
      assert.equal(first?.sequence, 1);
      if (first?.type !== "welcome") {
        assert.fail("expected the pending bootstrap event");
      }
      assert.equal(first.payload.bootstrapStatus, "pending");
      assert.equal(second?.type, "welcome");
      assert.equal(second?.sequence, 2);
      if (second?.type !== "welcome") {
        assert.fail("expected the bootstrap completion event");
      }
      assert.equal(second.payload.bootstrapStatus, "complete");
      assert.equal(second.payload.bootstrapProjectId, bootstrapProjectId);
      assert.equal(second.payload.bootstrapThreadId, bootstrapThreadId);
      assert.equal(second.payload.bootstrapProjectCreated, true);
      assert.equal(second.payload.bootstrapThreadCreated, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc project listing and exact file reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-files-" });
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "index.ts"),
        "export const answer = 42;\n",
      );
      yield* fs.writeFileString(path.join(workspaceDir, ".env"), "LOCAL_ONLY=true\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(workspaceDir, ".git", "config"), "[core]\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".scient"), { recursive: true });
      yield* fs.writeFileString(path.join(workspaceDir, ".scient", "project.json"), "{}\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".scient", "sources", "records"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".scient", "sources", "records", "source.json"),
        "{}\n",
      );
      yield* fs.symlink(
        path.join(workspaceDir, ".scient", "project.json"),
        path.join(workspaceDir, "managed-alias.json"),
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            listing: client[WS_METHODS.projectsListEntries]({ cwd: workspaceDir }),
            directory: client[WS_METHODS.projectsListDirectory]({
              cwd: workspaceDir,
              relativeDirectory: "",
              view: "ordinary",
            }),
            scient: client[WS_METHODS.projectsListDirectory]({
              cwd: workspaceDir,
              relativeDirectory: ".scient",
              view: "ordinary",
            }),
            internals: client[WS_METHODS.projectsListDirectory]({
              cwd: workspaceDir,
              relativeDirectory: "",
              view: "with-internals",
            }),
            file: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "src/index.ts",
            }),
            managedFile: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: ".scient/project.json",
            }),
            managedAlias: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "managed-alias.json",
            }),
          }),
        ),
      );

      assert.isTrue(response.listing.entries.some((entry) => entry.path === "src/index.ts"));
      assert.isTrue(response.directory.complete);
      assert.isTrue(response.directory.entries.some((entry) => entry.relativePath === ".env"));
      assert.isFalse(response.directory.entries.some((entry) => entry.relativePath === ".git"));
      assert.isTrue(
        response.scient.entries.some(
          (entry) => entry.relativePath === ".scient/sources" && entry.readOnly,
        ),
      );
      assert.isTrue(response.internals.entries.some((entry) => entry.relativePath === ".git"));
      assert.deepEqual(response.file, {
        relativePath: "src/index.ts",
        contents: "export const answer = 42;\n",
        byteLength: 26,
        truncated: false,
        revision: `sha256:${NodeCrypto.createHash("sha256")
          .update("export const answer = 42;\n")
          .digest("hex")}`,
        readOnly: false,
      });
      assert.equal(response.managedFile.readOnly, true);
      assert.equal(response.managedAlias.readOnly, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-project-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ["src/tracked.ts"],
                truncated: false,
                freshness: {
                  source: "live-local",
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "ignored-search-target",
            limit: 10,
          }),
        ),
      );

      assert.equal(response.entries.length, 0);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect.skipIf(!symlinksSupported)("preserves structured workspace rpc failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-",
      });
      const outsideDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-outside-",
      });
      const outsideFile = path.join(outsideDir, "outside.txt");
      yield* fs.writeFileString(outsideFile, "outside\n");
      yield* fs.symlink(outsideFile, path.join(workspaceDir, "linked-outside.txt"));

      yield* buildAppUnderTest();

      const invalidWorkspace = path.join(workspaceDir, "missing-workspace");
      const missingBrowseParent = path.join(workspaceDir, "missing-browse");
      const sensitiveQuery = "authorization: Bearer secret-token";
      const wsUrl = yield* getWsServerUrl("/ws");
      const results = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            search: client[WS_METHODS.projectsSearchEntries]({
              cwd: invalidWorkspace,
              query: sensitiveQuery,
              limit: 10,
            }).pipe(Effect.result),
            list: client[WS_METHODS.projectsListEntries]({ cwd: invalidWorkspace }).pipe(
              Effect.result,
            ),
            directory: client[WS_METHODS.projectsListDirectory]({
              cwd: invalidWorkspace,
              relativeDirectory: "",
              view: "ordinary",
            }).pipe(Effect.result),
            read: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "missing.txt",
            }).pipe(Effect.result),
            linkedRead: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "linked-outside.txt",
            }).pipe(Effect.result),
            browse: client[WS_METHODS.filesystemBrowse]({
              cwd: workspaceDir,
              partialPath: "./missing-browse/child",
            }).pipe(Effect.result),
          }),
        ),
      );

      if (
        results.search._tag !== "Failure" ||
        results.search.failure._tag !== "ProjectSearchEntriesError"
      ) {
        assert.fail("Expected a ProjectSearchEntriesError");
      }
      const searchError = results.search.failure;
      assert.equal(
        searchError.message,
        `Failed to search workspace entries in '${invalidWorkspace}'.`,
      );
      assert.equal(searchError.cwd, invalidWorkspace);
      assert.equal(searchError.queryLength, sensitiveQuery.length);
      assert.notProperty(searchError, "query");
      assert.notInclude(searchError.message, "Bearer");
      assert.notInclude(searchError.message, "secret-token");
      assert.equal(searchError.limit, 10);
      assert.equal(searchError.failure, "workspace_root_not_found");
      assert.equal(searchError.normalizedCwd, invalidWorkspace);
      assert.isDefined(searchError.cause);

      if (
        results.list._tag !== "Failure" ||
        results.list.failure._tag !== "ProjectListEntriesError"
      ) {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const listError = results.list.failure;
      assert.equal(listError.message, `Failed to list workspace entries in '${invalidWorkspace}'.`);
      assert.equal(listError.cwd, invalidWorkspace);
      assert.equal(listError.failure, "workspace_root_not_found");
      assert.equal(listError.normalizedCwd, invalidWorkspace);
      assert.isDefined(listError.cause);

      if (
        results.directory._tag !== "Failure" ||
        results.directory.failure._tag !== "ProjectListDirectoryError"
      ) {
        assert.fail("Expected a ProjectListDirectoryError");
      }
      const directoryError = results.directory.failure;
      assert.equal(
        directoryError.message,
        `Failed to list workspace directory '' in '${invalidWorkspace}'.`,
      );
      assert.equal(directoryError.failure, "workspace_root_not_found");
      assert.equal(directoryError.resolvedPath, invalidWorkspace);
      assert.isDefined(directoryError.cause);

      if (results.read._tag !== "Failure" || results.read.failure._tag !== "ProjectReadFileError") {
        assert.fail("Expected a ProjectReadFileError");
      }
      const readError = results.read.failure;
      assert.equal(
        readError.message,
        `Failed to read workspace file 'missing.txt' in '${workspaceDir}'.`,
      );
      assert.equal(readError.cwd, workspaceDir);
      assert.equal(readError.relativePath, "missing.txt");
      assert.equal(readError.failure, "operation_failed");
      assert.equal(readError.reason, "not_found");
      assert.isDefined(readError.cause);

      // A symlink leading out of the project is viewable, never editable.
      if (results.linkedRead._tag !== "Success") {
        assert.fail("Expected the symlinked outside file to be readable");
      }
      assert.equal(results.linkedRead.success.relativePath, "linked-outside.txt");
      assert.equal(results.linkedRead.success.contents, "outside\n");
      assert.equal(results.linkedRead.success.readOnly, true);

      if (
        results.browse._tag !== "Failure" ||
        results.browse.failure._tag !== "FilesystemBrowseError"
      ) {
        assert.fail("Expected a FilesystemBrowseError");
      }
      const browseError = results.browse.failure;
      assert.equal(
        browseError.message,
        `Failed to browse filesystem path './missing-browse/child' from '${workspaceDir}'.`,
      );
      assert.equal(browseError.cwd, workspaceDir);
      assert.equal(browseError.partialPath, "./missing-browse/child");
      assert.equal(browseError.failure, "read_directory_failed");
      assert.equal(browseError.parentPath, missingBrowseParent);
      assert.isDefined(browseError.cause);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "opens the file a chat link means over the wire, wherever it lives",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-file-links-" }),
        );
        const workspaceDir = path.join(baseDir, "workspace");
        const outsideDir = path.join(baseDir, "outside");
        yield* fs.makeDirectory(path.join(workspaceDir, "reports/2026"), { recursive: true });
        yield* fs.makeDirectory(path.join(workspaceDir, "data"), { recursive: true });
        yield* fs.makeDirectory(outsideDir, { recursive: true });
        yield* fs.writeFileString(path.join(workspaceDir, "reports/2026/summary.md"), "inside\n");
        yield* fs.writeFileString(path.join(outsideDir, "notes.md"), "outside\n");
        yield* fs.symlink(
          path.join(outsideDir, "notes.md"),
          path.join(workspaceDir, "data/shared-notes.md"),
        );

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const link = (linkPath: string) => ({
          workspaceRoot: EnvironmentFilePath.make(workspaceDir),
          path: EnvironmentFilePath.make(linkPath),
        });
        const results = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.all({
              outside: client[WS_METHODS.filesystemResolveFileLink](link("../outside/notes.md")),
              wrongFolder: client[WS_METHODS.filesystemResolveFileLink](link("2026/summary.md")),
              symlinkOnly: client[WS_METHODS.filesystemResolveFileLink](link("shared-notes.md")),
              nothing: client[WS_METHODS.filesystemResolveFileLink](link("reports/none.md")),
              // The outside file reads the same through every spelling.
              readClimbing: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "../outside/notes.md",
              }),
              readSymlink: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "data/shared-notes.md",
              }),
              // Writing through the same spellings is still refused.
              writeClimbing: client[WS_METHODS.projectsWriteFile]({
                cwd: workspaceDir,
                relativePath: "../outside/notes.md",
                contents: "overwritten\n",
              }).pipe(Effect.result),
              writeSymlink: client[WS_METHODS.projectsWriteFile]({
                cwd: workspaceDir,
                relativePath: "data/shared-notes.md",
                contents: "overwritten\n",
              }).pipe(Effect.result),
            }),
          ),
        );

        const filePath = EnvironmentFilePath.make;
        assert.deepEqual(results.outside, {
          _tag: "literal",
          path: filePath(path.join(outsideDir, "notes.md")),
        });
        assert.deepEqual(results.wrongFolder, {
          _tag: "recovered",
          path: filePath("reports/2026/summary.md"),
          missingPath: filePath(path.join(workspaceDir, "2026/summary.md")),
        });
        assert.deepEqual(results.symlinkOnly, {
          _tag: "recovered",
          path: filePath("data/shared-notes.md"),
          missingPath: filePath(path.join(workspaceDir, "shared-notes.md")),
        });
        assert.equal(results.nothing._tag, "none");
        for (const read of [results.readClimbing, results.readSymlink]) {
          assert.equal(read.contents, "outside\n");
          assert.equal(read.readOnly, true);
        }
        assert.equal(results.readClimbing.revision, results.readSymlink.revision);
        assert.equal(results.writeClimbing._tag, "Failure");
        assert.equal(results.writeSymlink._tag, "Failure");
        assert.equal(yield* fs.readFileString(path.join(outsideDir, "notes.md")), "outside\n");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // chmod cannot deny the superuser, and Windows has no POSIX permission bits.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "reports an unreadable file as a permission failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ws-workspace-denied-",
        });
        const lockedFile = path.join(workspaceDir, "locked.txt");
        yield* fs.writeFileString(lockedFile, "private\n");
        yield* fs.chmod(lockedFile, 0o000);

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "locked.txt",
            }).pipe(Effect.result),
          ),
        );
        yield* fs.chmod(lockedFile, 0o600);

        if (result._tag !== "Failure" || result.failure._tag !== "ProjectReadFileError") {
          assert.fail("Expected a ProjectReadFileError");
        }
        assert.equal(result.failure.failure, "operation_failed");
        assert.equal(result.failure.reason, "permission_denied");
        // The system's own code travels too: a file mode refuses with EACCES,
        // which the client tells apart from the system itself declining.
        assert.equal(result.failure.osErrorCode, "EACCES");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports workspace root stat failures without relabeling them as missing", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blockedRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-stat-error-",
      });
      const workspaceRoot = path.join(blockedRoot, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* fs.chmod(blockedRoot, 0o000);

      const result = yield* Effect.gen(function* () {
        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        return yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsListEntries]({ cwd: workspaceRoot }).pipe(Effect.result),
          ),
        );
      }).pipe(Effect.ensuring(fs.chmod(blockedRoot, 0o700).pipe(Effect.ignore)));

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const error = result.failure;
      assert.equal(error.failure, "workspace_root_stat_failed");
      assert.equal(error.normalizedCwd, workspaceRoot);
      assert.equal(error.detail, "validate-existing");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects generic Files writes to owner-managed project paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-ws-project-managed-write-",
      });
      const projectFile = path.join(workspaceDir, ".scient", "project.json");
      const aliasFile = path.join(workspaceDir, "managed-alias.json");
      const sourcesDirectory = path.join(workspaceDir, ".scient", "sources");
      const sourcesAlias = path.join(workspaceDir, "managed-directory-alias");
      yield* fs.makeDirectory(path.dirname(projectFile), { recursive: true });
      yield* fs.makeDirectory(sourcesDirectory, { recursive: true });
      yield* fs.writeFileString(projectFile, '{"id":"original"}\n');
      yield* fs.symlink(projectFile, aliasFile);
      yield* fs.symlink(sourcesDirectory, sourcesAlias);

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: ".scient/project.json",
            contents: '{"id":"changed"}\n',
          }),
        ).pipe(Effect.result),
      );

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected a ProjectWriteFileError");
      }
      assert.equal(result.failure.failure, "read_only_in_files");
      assert.equal(
        result.failure.message,
        "Workspace file '.scient/project.json' is read-only in Files.",
      );
      assert.equal(yield* fs.readFileString(projectFile), '{"id":"original"}\n');

      const aliasRead = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsReadFile]({
            cwd: workspaceDir,
            relativePath: "managed-alias.json",
          }),
        ),
      );
      const aliasWrite = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "managed-alias.json",
            contents: '{"id":"changed-through-alias"}\n',
            expectedRevision: aliasRead.revision,
          }),
        ).pipe(Effect.result),
      );
      if (aliasWrite._tag !== "Failure" || aliasWrite.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected a ProjectWriteFileError for a symlink path");
      }
      assert.equal(aliasWrite.failure.failure, "read_only_in_files");
      assert.equal(yield* fs.readFileString(projectFile), '{"id":"original"}\n');

      const aliasCreate = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "managed-directory-alias/created.json",
            contents: "{}\n",
          }),
        ).pipe(Effect.result),
      );
      if (aliasCreate._tag !== "Failure" || aliasCreate.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected a ProjectWriteFileError for a symlinked directory");
      }
      assert.equal(aliasCreate.failure.failure, "read_only_in_files");
      assert.isTrue(
        Option.isNone(
          yield* fs.stat(path.join(sourcesDirectory, "created.json")).pipe(Effect.option),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("streams selected workspace file changes over websocket rpc", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-project-watch-",
      });
      const sourcePath = path.join(workspaceDir, "analysis.m");
      yield* fs.writeFileString(sourcePath, "answer = 1;\n");

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const event = yield* client[WS_METHODS.projectsSubscribeFileChanges]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            }).pipe(
              Stream.tap((event) =>
                event._tag === "watch-ready"
                  ? fs.writeFileString(sourcePath, "answer = 2;\n")
                  : Effect.void,
              ),
              Stream.filter((event) => event._tag === "file-changed"),
              Stream.runHead,
            );
            const refreshed = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            });
            return { event, refreshed };
          }),
        ),
      );

      assert.deepEqual(
        result.event,
        Option.some({ _tag: "file-changed", relativePath: "analysis.m" }),
      );
      assert.equal(result.refreshed.contents, "answer = 2;\n");
      assert.match(result.refreshed.revision, /^sha256:[0-9a-f]{64}$/u);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  const scientRpcHarness = {
    buildAppUnderTest,
    exchangeAccessToken,
    fetchEffect,
    getHttpServerUrl,
    getWsServerUrl,
    withWsRpcClient,
  };
  registerAnalysisRpcTests(it, scientRpcHarness);
  registerComputeRpcTests(it, scientRpcHarness);
  registerMarkdownTransportTests(it, scientRpcHarness);

  it.effect("creates a missing workspace root during native websocket project mutation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-create-" });
      const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsMutate]({
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-missing-root"),
            projectId: ProjectId.make("project-create-missing-root"),
            title: "New Project",
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
          }),
        ),
      );
      const stat = yield* fs.stat(missingWorkspaceRoot);

      assert.equal(response.id, ProjectId.make("project-create-missing-root"));
      assert.equal(stat.type, "Directory");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("acknowledges websocket thread.fork only after provisioning completes", () =>
    Effect.gen(function* () {
      const provisioningStarted = yield* Deferred.make<void>();
      const allowProvisioningToComplete = yield* Deferred.make<void>();
      const rpcCompleted = yield* Deferred.make<void>();
      const effects: string[] = [];
      const forkThreadId = ThreadId.make("thread-fork-ready-gate");

      yield* buildAppUnderTest({
        layers: {
          conversationFork: {
            dispatch: (command) =>
              Effect.gen(function* () {
                assert.equal(command.newThreadId, forkThreadId);
                effects.push(`dispatch:${command.type}`);
                effects.push(`await:${command.newThreadId}`);
                yield* Deferred.succeed(provisioningStarted, undefined);
                yield* Deferred.await(allowProvisioningToComplete);
                effects.push(`ready:${command.newThreadId}`);
                return { sequence: 41, forkAttachmentIdMap: { "origin-file": "fork-file" } };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const rpcFiber = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.fork",
              commandId: CommandId.make("cmd-thread-fork-ready-gate"),
              originThreadId: ThreadId.make("thread-fork-ready-gate-origin"),
              newThreadId: forkThreadId,
              sourceAssistantMessageId: MessageId.make("assistant-fork-ready-gate"),
              workspaceMode: "local",
            }).pipe(
              Effect.tap(() => Deferred.succeed(rpcCompleted, undefined)),
              Effect.forkChild,
            );

            yield* Deferred.await(provisioningStarted);
            assert.isTrue(Option.isNone(yield* Deferred.poll(rpcCompleted)));
            yield* Deferred.succeed(allowProvisioningToComplete, undefined);
            return yield* Fiber.join(rpcFiber);
          }),
        ),
      );

      assert.equal(response.sequence, 41);
      assert.deepEqual(response.forkAttachmentIdMap, { "origin-file": "fork-file" });
      assert.deepEqual(effects, [
        "dispatch:thread.fork",
        `await:${forkThreadId}`,
        `ready:${forkThreadId}`,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns websocket thread.fork provisioning failures to the caller", () =>
    Effect.gen(function* () {
      const forkThreadId = ThreadId.make("thread-fork-failed-gate");

      yield* buildAppUnderTest({
        layers: {
          conversationFork: {
            dispatch: () =>
              Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: "Fork workspace provisioning failed.",
                  forkDisposition: "failed",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.fork",
            commandId: CommandId.make("cmd-thread-fork-failed-gate"),
            originThreadId: ThreadId.make("thread-fork-failed-gate-origin"),
            newThreadId: forkThreadId,
            sourceAssistantMessageId: MessageId.make("assistant-fork-failed-gate"),
            workspaceMode: "new-worktree",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "Fork workspace provisioning failed.");
      assert.equal(result.failure.forkDisposition, "failed");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects an unavailable running fork boundary before durable acceptance", () =>
    Effect.gen(function* () {
      const forkThreadId = ThreadId.make("thread-fork-capture-failure");
      const originThreadId = ThreadId.make("thread-fork-capture-origin");
      const app = yield* buildAppUnderTest();
      yield* seedV2StreamThread(app, originThreadId);
      const before = yield* app.v2.eventSink.latestSequence();
      const result = yield* Effect.scoped(
        withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.fork",
            commandId: CommandId.make("cmd-thread-fork-capture-failure"),
            originThreadId,
            newThreadId: forkThreadId,
            sourceRunningTurnId: TurnId.make("running-capture"),
            workspaceMode: "local",
          }),
        ).pipe(Effect.result),
      );
      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "running turn is unavailable");
      assert.equal(result.failure.forkDisposition, "rejected");
      assert.equal(yield* app.v2.eventSink.latestSequence(), before);
      assert.isNull(yield* app.v2.threads.getThreadShell(forkThreadId));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns authoritative fork options over the read-authorized RPC", () =>
    Effect.gen(function* () {
      const originThreadId = ThreadId.make("fork-options-origin");
      const sourceAssistantMessageId = MessageId.make("fork-options-answer");
      yield* buildAppUnderTest({
        layers: {
          conversationFork: {
            getOptions: (input) => {
              assert.equal(input.originThreadId, originThreadId);
              assert.isUndefined(input.sourceAssistantMessageId);
              return Effect.succeed({
                available: true,
                localAvailable: true,
                reason: null,
                newWorktree: false,
                sourceAssistantMessageId,
                sourceUserMessageId: null,
              });
            },
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getForkOptions]({ originThreadId }),
        ),
      );
      assert.equal(result.sourceAssistantMessageId, sourceAssistantMessageId);
      assert.isTrue(result.localAvailable);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("starts a project clone in the background and blocks threads until it lands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-clone-" });
      const destinationPath = path.join(parentDir, "t3code");
      const projectId = ProjectId.make("project-clone-1");
      const cloneGate = yield* Deferred.make<void>();

      const app = yield* buildAppUnderTest({
        layers: {
          sourceControlRepositoryService: {
            prepareClone: (input) =>
              Effect.succeed({
                destinationPath: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                cloneUrl: input.remoteUrl ?? "",
                repository: null,
              }),
            cloneRepository: (input) =>
              Deferred.await(cloneGate).pipe(
                Effect.as({
                  cwd: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              ),
          },
        },
      });

      const projectEvents = yield* app.v2.events.streamApplicationEvents({ afterSequence: 0 }).pipe(
        Stream.filter((event) => !("event" in event) && event.aggregateId === projectId),
        Stream.takeUntil(
          (event) =>
            !("event" in event) &&
            event.type === "project.meta-updated" &&
            event.commandId === CommandId.make(`project-clone-done:${projectId}`),
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const started = yield* client[WS_METHODS.projectCloneStart]({
              projectId,
              title: "t3code",
              createdAt: "2026-01-01T00:00:00.000Z",
              remoteUrl: "git@github.com:octocat/t3code.git",
              destinationPath,
            });
            assert.equal(started.cwd, destinationPath);
            const registered = yield* app.v2.projects.getById(projectId);
            assertTrue(Option.isSome(registered));
            assert.equal(registered.value.workspaceRoot, destinationPath);
            const creation = yield* app.v2.events
              .readApplicationEvents({
                afterSequence: 0,
                throughSequence: yield* app.v2.events.latestApplicationSequence,
              })
              .pipe(Stream.runCollect);
            assert.deepEqual(
              creation.flatMap((event) => ("event" in event ? [] : [event.type])),
              ["project.created"],
            );

            const blocked = yield* Effect.flip(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("cmd-thread-create-while-cloning"),
                threadId: ThreadId.make("thread-while-cloning"),
                projectId,
                title: "Draft",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5-codex",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              }),
            );
            assert.include(String(blocked.message), "still being cloned");

            const snapshots = yield* client[WS_METHODS.subscribeProjectClones]({}).pipe(
              Stream.takeUntil((clones) => clones[0]?.phase === "done"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* Deferred.succeed(cloneGate, undefined);
            const lists = yield* Fiber.join(snapshots);
            assert.equal(lists.at(-1)?.[0]?.phase, "done");
            const committed = yield* Fiber.join(projectEvents);
            assert.deepEqual(
              committed.flatMap((event) => ("event" in event ? [] : [event.type])),
              ["project.created", "project.meta-updated"],
            );
            assert.isNull(
              yield* app.v2.threads.getThreadShell(ThreadId.make("thread-while-cloning")),
            );
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "legacy queue HTTP preserves clone rejection prose and held work until completion",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-queue-clone-http-" });
        const destinationPath = path.join(parentDir, "checkout");
        const projectId = ProjectId.make("queue-http-clone-project");
        const threadId = ThreadId.make("queue-http-clone-thread");
        const cloneGate = yield* Deferred.make<void>();
        const app = yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (id) =>
                Effect.succeed(
                  id === defaultModelSelection.instanceId ? nativeAdmissionInstance : undefined,
                ),
              listInstances: Effect.succeed([nativeAdmissionInstance]),
            },
            sourceControlRepositoryService: {
              prepareClone: (input) =>
                Effect.succeed({
                  destinationPath: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  cloneUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              cloneRepository: (input) =>
                Deferred.await(cloneGate).pipe(
                  Effect.as({
                    cwd: input.destinationPath,
                    remoteUrl: input.remoteUrl ?? "",
                    repository: null,
                  }),
                ),
            },
          },
        });
        yield* app.v2.orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("queue-http-clone-create"),
          threadId,
          projectId,
          title: "Held draft",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: destinationPath,
          createdBy: "user",
          creationSource: "web",
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              yield* client[WS_METHODS.projectCloneStart]({
                projectId,
                title: "Clone queue",
                createdAt: "2026-01-01T00:00:00.000Z",
                remoteUrl: "https://example.invalid/clone-queue.git",
                destinationPath,
              });
              const cookie = yield* getAuthenticatedSessionCookieHeader();
              const headers = { cookie, "content-type": "application/json" };
              const queueItemId = "qitem_httpclone";
              const enqueueResponse = yield* fetchEffect(
                yield* getHttpServerUrl("/api/scient/thread-queue/v2/enqueue"),
                {
                  method: "POST",
                  headers,
                  body: jsonRequestBody({
                    threadId,
                    queueItemId,
                    text: "Keep the captured skills",
                    attachments: [],
                    selectedScientSkillNames: ["analysis"],
                    modelSelection: defaultModelSelection,
                  }),
                },
              );
              assert.equal(enqueueResponse.status, 200);
              const admitted = yield* decodeQueueSnapshot(
                yield* responseJsonEffect<unknown>(enqueueResponse),
              );
              assert.equal(admitted.items.length, 1);
              assert.deepEqual(admitted.items[0]?.selectedScientSkillNames, ["analysis"]);
              const before = yield* app.v2.orchestrator.getThreadProjection(threadId);
              assert.equal(before.runs[0]?.queueHeld, true);
              const effectsBefore = yield* app.v2.sql`SELECT effect_id, effect_type, payload_json
              FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
              const controlUrl = yield* getHttpServerUrl("/api/scient/thread-queue/v2/control");
              const control = {
                method: "POST",
                headers,
                body: jsonRequestBody({ threadId, action: "send", queueItemId }),
              };
              const blockedResponse = yield* fetchEffect(controlUrl, control);
              assert.equal(blockedResponse.status, 409);
              const blocked = yield* decodeQueueOperationError(
                yield* responseJsonEffect<unknown>(blockedResponse),
              );
              assert.equal(blocked.message, "The repository is still being cloned.");
              assert.deepEqual(yield* app.v2.orchestrator.getThreadProjection(threadId), before);
              assert.deepEqual(
                yield* app.v2.sql`SELECT effect_id, effect_type, payload_json
                FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
                effectsBefore,
              );
              const finished = yield* client[WS_METHODS.subscribeProjectClones]({}).pipe(
                Stream.filter((clones) =>
                  clones.some((clone) => clone.projectId === projectId && clone.phase === "done"),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkChild,
              );
              yield* Deferred.succeed(cloneGate, undefined);
              yield* Fiber.join(finished);
              const sentResponse = yield* fetchEffect(controlUrl, control);
              assert.equal(sentResponse.status, 200);
              const sent = yield* decodeQueueSnapshot(
                yield* responseJsonEffect<unknown>(sentResponse),
              );
              assert.equal(sent.items.length, 0);
              const after = yield* app.v2.orchestrator.getThreadProjection(threadId);
              assert.equal(after.runs[0]?.queueHeld, false);
              assert.equal(after.runs[0]?.status, "starting");
              assert.deepEqual(after.messages[0]?.selectedScientSkillNames, ["analysis"]);
              assert.equal(
                (yield* app.v2.sql<{ count: number }>`SELECT COUNT(*) AS count
              FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start'`)[0]
                  ?.count,
                1,
              );
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("finds a cloned project's icon once the clone lands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-clone-favicon-" });
      const destinationPath = path.join(parentDir, "app");
      const projectId = ProjectId.make("project-clone-favicon");
      const cloneGate = yield* Deferred.make<void>();

      const app = yield* buildAppUnderTest({
        layers: {
          sourceControlRepositoryService: {
            prepareClone: (input) =>
              Effect.succeed({
                destinationPath: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                cloneUrl: input.remoteUrl ?? "",
                repository: null,
              }),
            cloneRepository: (input) =>
              Deferred.await(cloneGate).pipe(
                Effect.andThen(
                  fs.writeFileString(path.join(input.destinationPath, "favicon.svg"), "<svg/>"),
                ),
                Effect.orDie,
                Effect.as({
                  cwd: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              ),
          },
        },
      });

      const metadataCommitted = yield* app.v2.events
        .streamApplicationEvents({ afterSequence: 0 })
        .pipe(
          Stream.filter(
            (event) =>
              !("event" in event) &&
              event.aggregateId === projectId &&
              event.type === "project.meta-updated" &&
              event.commandId === CommandId.make(`project-clone-done:${projectId}`),
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[WS_METHODS.projectCloneStart]({
              projectId,
              title: "app",
              createdAt: "2026-01-01T00:00:00.000Z",
              remoteUrl: "git@github.com:octocat/app.git",
              destinationPath,
            });
            const resource = { _tag: "project-favicon" as const, cwd: destinationPath };
            const duringClone = yield* client[WS_METHODS.assetsCreateUrl]({ resource });
            assert.isTrue(duringClone.relativeUrl.endsWith("/project-favicon-missing"));

            yield* Deferred.succeed(cloneGate, undefined);
            assert.isTrue(Option.isSome(yield* Fiber.join(metadataCommitted)));
            assert.equal(
              yield* fs.readFileString(path.join(destinationPath, "favicon.svg")),
              "<svg/>",
            );
            // The lookup during the clone must not leave a cached miss behind.
            const afterClone = yield* client[WS_METHODS.assetsCreateUrl]({ resource });
            assert.equal(afterClone.sourcePath, "favicon.svg");
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records thread analytics only after a client command succeeds", () =>
    Effect.gen(function* () {
      const effects: string[] = [];
      const analyticsProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];
      const failedCommandId = CommandId.make("cmd-thread-create-failed");

      const app = yield* buildAppUnderTest({
        transformThreadLaunchV2: (service) => ({
          ...service,
          launch: (input) =>
            Effect.sync(() => effects.push(`launch:${input.commandId}`)).pipe(
              Effect.andThen(
                input.commandId === failedCommandId
                  ? Effect.fail(
                      new ThreadLaunchV2.ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        threadId: input.threadId,
                        operation: "create-thread",
                        cause: "Injected thread creation failure",
                      }),
                    )
                  : service.launch(input),
              ),
            ),
        }),
        layers: {
          analyticsService: {
            record: (event, properties) =>
              Effect.sync(() => {
                effects.push(`analytics:${event}`);
                analyticsProperties.push(properties);
              }),
          },
        },
      });

      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-analytics-project-" });
      yield* app.v2.projects.create({
        commandId: CommandId.make("analytics-project"),
        projectId: defaultProjectId,
        title: "Analytics project",
        workspaceRoot: cwd,
      });
      const createThreadCommand = (commandId: CommandId, threadId: ThreadId) =>
        ({
          commandId,
          threadId,
          projectId: defaultProjectId,
          title: "Analytics test",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        }) as const;

      const wsUrl = yield* getWsServerUrl(
        "/ws?clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=iOS&clientOsMajorVersion=18&clientDeviceModel=iPhone+15+Pro&connectionMethod=relay",
      );
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const failed = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](
              createThreadCommand(failedCommandId, ThreadId.make("thread-create-failed")),
            ).pipe(Effect.result);

            assert.equal(failed._tag, "Failure");
            assert.deepEqual(effects, [
              "analytics:client.connected",
              "launch:cmd-thread-create-failed",
            ]);

            const succeeded = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](
              createThreadCommand(
                CommandId.make("cmd-thread-create-succeeded"),
                ThreadId.make("thread-create-succeeded"),
              ),
            );

            assert.equal(succeeded.threadId, ThreadId.make("thread-create-succeeded"));
            assert.isNull(
              yield* app.v2.threads.getThreadShell(ThreadId.make("thread-create-failed")),
            );
          }),
        ),
      );

      assert.deepEqual(effects, [
        "analytics:client.connected",
        "launch:cmd-thread-create-failed",
        "launch:cmd-thread-create-succeeded",
        "analytics:client.thread.started",
      ]);
      assert.deepEqual(analyticsProperties, [
        {
          surface: "mobile",
          appVersion: "1.2.3",
          clientAppVersion: "1.2.3",
          clientOs: "iOS",
          os: "iOS",
          clientDeviceType: "phone",
          osMajorVersion: 18,
          clientOsMajorVersion: 18,
          deviceModel: "iPhone 15 Pro",
          clientDeviceModel: "iPhone 15 Pro",
          connectionMethod: "relay",
        },
        {
          surface: "mobile",
          appVersion: "1.2.3",
          clientAppVersion: "1.2.3",
          clientOs: "iOS",
          os: "iOS",
          clientDeviceType: "phone",
          osMajorVersion: 18,
          clientOsMajorVersion: 18,
          deviceModel: "iPhone 15 Pro",
          clientDeviceModel: "iPhone 15 Pro",
          connectionMethod: "relay",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps telemetry separate for simultaneous clients", () =>
    Effect.gen(function* () {
      const analyticsEvents: Array<{
        event: string;
        properties: Readonly<Record<string, unknown>> | undefined;
      }> = [];

      const app = yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: { getInstance: () => Effect.succeed(nativeAdmissionInstance) },
          analyticsService: {
            record: (event, properties) =>
              Effect.sync(() => analyticsEvents.push({ event, properties })),
          },
        },
      });

      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-client-telemetry-" });
      yield* app.v2.projects.create({
        commandId: CommandId.make("telemetry-project"),
        projectId: ProjectId.make("transfer-project"),
        title: "Telemetry project",
        workspaceRoot: cwd,
      });
      for (const actor of ["web", "mobile"])
        yield* seedV2StreamThread(app, ThreadId.make(`thread-${actor}`));
      const webUrl = yield* getWsServerUrl(
        "/ws?clientSurface=web&clientAppVersion=2.0.0&clientDeviceType=desktop&clientOs=Windows&clientWebDeployment=hosted&clientBrowser=Chrome&connectionMethod=direct",
      );
      const mobileUrl = yield* getWsServerUrl(
        "/ws?clientSurface=mobile&clientAppVersion=3.0.0&clientDeviceType=tablet&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+Tablet&connectionMethod=relay",
      );
      const turnCommand = (actor: string) => ({
        type: "message.dispatch" as const,
        commandId: CommandId.make(`cmd-${actor}-turn`),
        threadId: ThreadId.make(`thread-${actor}`),
        messageId: MessageId.make(`message-${actor}`),
        text: "hello",
        attachments: [],
        modelSelection: defaultModelSelection,
        createdBy: "user" as const,
        creationSource: "web" as const,
        dispatchMode: { type: "start_immediately" as const },
      });

      yield* Effect.scoped(
        withWsRpcClient(webUrl, (webClient) =>
          withWsRpcClient(mobileUrl, (mobileClient) =>
            Effect.gen(function* () {
              yield* mobileClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("mobile"));
              yield* webClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("web"));
            }),
          ),
        ),
      );

      assert.deepEqual(
        analyticsEvents
          .filter(({ event }) => event === "client.turn.requested")
          .map(({ properties }) => properties),
        [
          {
            surface: "mobile",
            appVersion: "3.0.0",
            clientAppVersion: "3.0.0",
            clientOs: "Android",
            os: "Android",
            clientDeviceType: "tablet",
            osMajorVersion: 15,
            clientOsMajorVersion: 15,
            deviceModel: "Pixel Tablet",
            clientDeviceModel: "Pixel Tablet",
            connectionMethod: "relay",
          },
          {
            surface: "web",
            appVersion: "2.0.0",
            clientAppVersion: "2.0.0",
            clientOs: "Windows",
            clientDeviceType: "desktop",
            webDeployment: "hosted",
            clientBrowser: "Chrome",
            connectionMethod: "direct",
          },
        ],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores invalid client telemetry without rejecting the connection", () =>
    Effect.gen(function* () {
      const connectedProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              event === "client.connected"
                ? Effect.sync(() => connectedProperties.push(properties))
                : Effect.void,
          },
        },
      });

      const invalidUrl = yield* getWsServerUrl(
        "/ws?clientSurface=watch&clientDeviceType=television&clientOs=Plan9&clientWebDeployment=cdn&clientBrowser=&clientOsMajorVersion=-1&connectionMethod=teleport",
      );
      yield* Effect.scoped(
        withWsRpcClient(invalidUrl, (client) => client[WS_METHODS.serverGetSettings]({})),
      );

      assert.deepEqual(connectedProperties, [{}]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected a ProjectWriteFileError");
      }
      const writeError = result.failure;
      assert.equal(
        writeError.message,
        `Failed to write workspace file '../escape.txt' in '${workspaceDir}'.`,
      );
      assert.equal(writeError.cwd, workspaceDir);
      assert.equal(writeError.relativePath, "../escape.txt");
      assert.equal(writeError.failure, "workspace_path_outside_root");
      assert.isDefined(writeError.cause);
      assert.notProperty(writeError, "contents");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const externalLauncherError = new ExternalLauncherCommandNotFoundError({
        editor: "cursor",
        command: "cursor",
      });
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: () => Effect.fail(externalLauncherError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, externalLauncherError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes file preparation and exact asset transport end to end", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-ws-file-open-" });
      const filePath = path.join(root, "outside-workspace.tsx");
      const contents = "export const Result = () => <strong>42</strong>;\n";
      yield* fileSystem.writeFileString(filePath, contents);
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const { prepared, issued } = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const prepared = yield* client[WS_METHODS.filesystemPrepareFileOpen]({
              path: EnvironmentFilePath.make(filePath),
            });
            const issued = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "environment-file",
                path: prepared.canonicalPath,
                access: "exact",
              },
            });
            return { prepared, issued };
          }),
        ),
      );
      assert.equal(prepared.canonicalPath, yield* fileSystem.realPath(filePath));
      assert.equal(prepared.presentation.kind, "text");
      assert.equal(prepared.byteLength, new TextEncoder().encode(contents).byteLength);

      const response = yield* HttpClient.get(issued.relativeUrl);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, contents);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          cwd: "/tmp/repo",
        },
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitManager: {
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", refName: "feature/demo" },
              }),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.succeed({
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
                isOnPullRequestHead: true,
              }),
          },
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                refName: "main",
                upstreamRef: "origin/main",
              }),
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            removeWorktree: () => Effect.void,
            createRef: (input) => Effect.succeed({ refName: input.refName }),
            switchRef: (input) => Effect.succeed({ refName: input.refName }),
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
          },
          reviewService: {
            getDiffPreview: (input) =>
              Effect.succeed({
                cwd: input.cwd,
                generatedAt: DateTime.nowUnsafe(),
                sources: [
                  {
                    id: "working-tree",
                    kind: "working-tree",
                    title: "Dirty worktree",
                    baseRef: "HEAD",
                    headRef: null,
                    diff: "dirty-diff",
                    diffHash: "hash-dirty",
                    truncated: false,
                  },
                  {
                    id: "branch-range",
                    kind: "branch-range",
                    title: "Against main",
                    baseRef: "main",
                    headRef: "feature/demo",
                    diff: "base-diff",
                    diffHash: "hash-base",
                    truncated: false,
                  },
                ],
              }),
            getDiffFileContents: () =>
              Effect.succeed({
                oldContents: "before\n",
                newContents: "after\n",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(refreshedStatus.isRepo, true);

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: "/tmp/repo" })),
      );
      assert.equal(refs.refs[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateWorktree]({
            cwd: "/tmp/repo",
            refName: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.refName, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateRef]({
            cwd: "/tmp/repo",
            refName: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsSwitchRef]({
            cwd: "/tmp/repo",
            refName: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );

      const diffPreview = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffPreview]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(diffPreview.sources[0]?.diff, "dirty-diff");

      const diffFileContents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffFileContents]({
            cwd: "/tmp/repo",
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "README.md",
            newPath: "README.md",
          }),
        ),
      );
      assert.equal(diffFileContents.oldContents, "before\n");
      assert.equal(diffFileContents.newContents, "after\n");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.runStackedAction errors after refreshing git status", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "commit",
        command: "git commit",
        cwd: "/tmp/repo",
        detail: "nothing to commit",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/demo",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect, Effect.result),
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("completes websocket rpc git.pull before background git status refresh finishes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled" as const,
                refName: "main",
                upstreamRef: "origin/main",
              }),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.as({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

      assert.equal(result.status, "pulled");
      assertTrue(elapsedMs < 1_000);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "completes websocket rpc git.runStackedAction before background git status refresh finishes",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

        assertTrue(elapsedMs < 1_000);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "starts a background local git status refresh after a successful git.runStackedAction",
    () =>
      Effect.gen(function* () {
        const localRefreshStarted = yield* Deferred.make<void>();

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Deferred.succeed(localRefreshStarted, undefined).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.succeed({
                      isRepo: true,
                      hasPrimaryRemote: true,
                      isDefaultRef: false,
                      refName: "feature/demo",
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                  ),
                ),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );

        yield* Deferred.await(localRefreshStarted);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("opens a rooted workspace PDF before its draft thread exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-draft-pdf-",
      });
      const relativePath = "ילדים/מבואות ילדים/סיכום גיל בעריכת שחר.pdf";
      const pdfPath = path.join(workspaceRoot, relativePath);
      const bytes = new TextEncoder().encode("%PDF-1.7\nrooted draft");
      yield* fileSystem.makeDirectory(path.dirname(pdfPath), { recursive: true });
      yield* fileSystem.writeFile(pdfPath, bytes);

      yield* buildAppUnderTest({
        transformThreadManagementV2: (threads) => ({
          ...threads,
          getThreadShell: () => Effect.die("Rooted workspace assets must not resolve a thread."),
          getThreadProjection: () =>
            Effect.die("Rooted workspace assets must not read a projection."),
        }),
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const asset = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.assetsCreateUrl]({
            resource: {
              _tag: "workspace-file",
              cwd: workspaceRoot,
              relativePath,
              threadId: ThreadId.make("client-only-draft"),
              path: pdfPath,
            },
          }),
        ),
      );
      const response = yield* fetchEffect(`${yield* getHttpServerUrl()}${asset.relativeUrl}`);

      assert.equal(asset.sourcePath, relativePath);
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "application/pdf");
      assert.deepEqual(new Uint8Array(yield* response.arrayBuffer), bytes);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes native websocket orchestration mutation, checkpoint diff and search", () =>
    Effect.gen(function* () {
      const threadId = transferV2ThreadId;
      const app = yield* buildAppUnderTest({
        layers: {
          checkpointDiffQuery: {
            getTurnDiff: (input) => Effect.succeed({ ...input, diff: "turn-diff" }),
            getFullThreadDiff: (input) =>
              Effect.succeed({ ...input, fromTurnCount: 0, diff: "full-diff" }),
          },
        },
      });
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-native-rpc-routes-" });
      yield* app.v2.projects.create({
        commandId: CommandId.make("native-rpc-project"),
        projectId: ProjectId.make("transfer-project"),
        title: "Project A",
        workspaceRoot: root,
      });
      yield* seedV2StreamThread(app);
      yield* app.v2.eventSink.write({
        events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).map((event) => {
          if (event.type === "message.updated" && event.payload.role === "assistant")
            return {
              ...event,
              payload: { ...event.payload, text: "Search reached the final response." },
            };
          if (event.type === "turn-item.updated" && event.payload.type === "assistant_message")
            return {
              ...event,
              payload: { ...event.payload, text: "Search reached the final response." },
            };
          return event;
        }),
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const before = yield* app.v2.events.latestAgentSequence(threadId);
            const dispatch = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.metadata.update",
              commandId: CommandId.make("native-route-title"),
              threadId,
              title: "Routed native title",
            });
            assert.isAbove(dispatch.sequence, before);
            assert.equal(
              (yield* app.v2.threads.getThreadProjection(threadId)).thread.title,
              "Routed native title",
            );
            assert.equal(
              (yield* client[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
                threadId,
                fromTurnCount: 0,
                toTurnCount: 1,
              })).diff,
              "turn-diff",
            );
            assert.equal(
              (yield* client[ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]({
                threadId,
                toTurnCount: 1,
              })).diff,
              "full-diff",
            );
            const search = yield* client[ORCHESTRATION_V2_WS_METHODS.searchThreads]({
              query: "final response",
            });
            assert.deepEqual(search.matches, [
              {
                threadId,
                projectId: ProjectId.make("transfer-project"),
                source: "assistant",
                snippet: "Search reached the final response.",
                messageCreatedAt: "2026-06-01T00:01:00.000Z",
              },
            ]);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  const seedV2StreamThread = Effect.fn("seedV2StreamThread")(function* (
    app: { readonly v2: { readonly eventSink: EventSinkV2.EventSinkV2["Service"] } },
    threadId = transferV2ThreadId,
  ) {
    const created = transferV2ThreadCreated(ProviderDriverKind.make("codex"));
    assertTrue(created.type === "thread.created");
    const event = {
      ...created,
      id: EventId.make(`created-${threadId}`),
      threadId,
      payload: {
        ...created.payload,
        id: threadId,
        lineage: { ...created.payload.lineage, rootThreadId: threadId },
      },
    };
    const stored = yield* app.v2.eventSink.write({ events: [event] });
    return { thread: event.payload, sequence: stored[0]!.sequence };
  });

  const collectV2ThreadCatchup = (
    wsUrl: string,
    afterSequence?: number,
    threadId = transferV2ThreadId,
  ) =>
    withWsRpcClient(wsUrl, (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        requestCompletionMarker: true,
      }).pipe(
        Stream.takeUntil((item) => item.kind === "synchronized"),
        Stream.runCollect,
      ),
    );
  const collectV2ShellCatchup = (wsUrl: string, afterSequence?: number) =>
    withWsRpcClient(wsUrl, (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        requestCompletionMarker: true,
      }).pipe(
        Stream.takeUntil((item) => item.kind === "synchronized"),
        Stream.runCollect,
      ),
    );

  it.effect(
    "dispatches V2 creation, section assignment and exact-boundary forks through the real shared websocket RPC",
    () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-ws-v2-fork-" });
        const projectId = ProjectId.make("transfer-project");
        yield* app.v2.projects.create({
          commandId: CommandId.make("ws-native-fork-project"),
          projectId,
          title: "Native fork project",
          workspaceRoot: cwd,
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.create",
              commandId: CommandId.make("ws-native-create"),
              threadId: transferV2ThreadId,
              projectId,
              title: "Native conversation",
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            const sectionId = ThreadSectionId.make("section:ws-native");
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.section.set",
              commandId: CommandId.make("ws-native-section"),
              threadId: transferV2ThreadId,
              sectionId,
            });
            assert.equal(
              (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).thread.sectionId,
              sectionId,
            );
            const events = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).filter(
              (event) =>
                event.type !== "turn-item.updated" ||
                event.payload.type === "user_message" ||
                event.payload.type === "assistant_message",
            );
            yield* app.v2.eventSink.write({ events });
            const options = yield* client[ORCHESTRATION_WS_METHODS.getForkOptions]({
              originThreadId: transferV2ThreadId,
              sourceAssistantMessageId: MessageId.make("assistant-0"),
            });
            assert.isTrue(options.localAvailable);
            const target = ThreadId.make("ws-native-frozen-fork");
            const command = {
              type: "thread.fork" as const,
              commandId: CommandId.make("ws-native-fork"),
              originThreadId: transferV2ThreadId,
              newThreadId: target,
              sourceAssistantMessageId: MessageId.make("assistant-0"),
              workspaceMode: "local" as const,
            };
            const provisioningCursor = yield* app.v2.eventSink.latestSequence();
            const provisioning = yield* app.v2.eventSink
              .stream({
                threadId: target,
                afterSequence: provisioningCursor,
              })
              .pipe(
                Stream.filter((stored) => stored.event.type === "thread.created"),
                Stream.take(1),
                Stream.runDrain,
                Effect.andThen(app.v2.worker.drain()),
                Effect.forkScoped,
              );
            const accepted = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
            yield* Fiber.join(provisioning);
            const fork = yield* app.v2.threads.getThreadProjection(target);
            assert.equal(fork.thread.conversationFork?.status, "ready");
            assert.equal(fork.thread.sectionId, sectionId);
            assert.equal(fork.thread.activeProviderThreadId, null);
            assert.equal(fork.thread.historyOrigin, "scient_fork");
            assert.deepEqual(fork.providerSessions, []);
            assert.deepEqual(fork.runtimeRequests, []);
            assert.deepEqual(fork.runs, []);
            assert.deepEqual(
              fork.messages.map((message) => message.role),
              ["user", "assistant"],
            );
            assert.isTrue(
              fork.turnItems.every((item) => item.providerTurnId === null && item.runId === null),
            );
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.delete",
              commandId: CommandId.make("ws-native-delete-source"),
              threadId: transferV2ThreadId,
            });
            const repeated = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
            assert.equal(repeated.sequence, accepted.sequence);
            assert.deepEqual(
              (yield* app.v2.threads.getThreadProjection(target)).messages,
              fork.messages,
            );
            const rejected = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              ...command,
              commandId: CommandId.make("ws-native-rejected-fork"),
              newThreadId: ThreadId.make("ws-native-rejected"),
            }).pipe(Effect.flip);
            assert.equal(rejected._tag, "OrchestrationDispatchCommandError");
            if (rejected._tag === "OrchestrationDispatchCommandError")
              assert.equal(rejected.forkDisposition, "rejected");
          }),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects exact-boundary fork reuse of a deleted identity and preserves its history",
    () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-fork-immutable-id-" });
        yield* app.v2.projects.create({
          commandId: CommandId.make("immutable-fork-project"),
          projectId: ProjectId.make("transfer-project"),
          title: "Immutable fork project",
          workspaceRoot: cwd,
        });
        yield* seedV2StreamThread(app);
        yield* app.v2.eventSink.write({
          events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).filter(
            (event) =>
              event.type !== "turn-item.updated" ||
              event.payload.type === "user_message" ||
              event.payload.type === "assistant_message",
          ),
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const deletedId = ThreadId.make("immutable-fork-deleted");
            const freshId = ThreadId.make("immutable-fork-fresh");
            const command = {
              type: "thread.fork" as const,
              commandId: CommandId.make("immutable-fork-original"),
              originThreadId: transferV2ThreadId,
              newThreadId: deletedId,
              sourceAssistantMessageId: MessageId.make("assistant-0"),
              workspaceMode: "local" as const,
            };
            const firstProvisionCursor = yield* app.v2.eventSink.latestSequence();
            const firstProvision = yield* app.v2.eventSink
              .stream({
                threadId: deletedId,
                afterSequence: firstProvisionCursor,
              })
              .pipe(
                Stream.filter((stored) => stored.event.type === "thread.created"),
                Stream.take(1),
                Stream.runDrain,
                Effect.andThen(app.v2.worker.drain()),
                Effect.forkScoped,
              );
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
            yield* Fiber.join(firstProvision);
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.delete",
              commandId: CommandId.make("immutable-fork-delete"),
              threadId: deletedId,
            });
            const tombstone = yield* app.v2.threads.getThreadProjection(deletedId);
            assert.isNotNull(tombstone.thread.deletedAt);
            assert.lengthOf(tombstone.messages, 2);
            const rejected = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              ...command,
              commandId: CommandId.make("immutable-fork-reuse-rejected"),
            }).pipe(Effect.flip);
            assert.equal(rejected._tag, "OrchestrationDispatchCommandError");
            if (rejected._tag === "OrchestrationDispatchCommandError")
              assert.equal(rejected.forkDisposition, "rejected");
            assert.deepEqual(yield* app.v2.threads.getThreadProjection(deletedId), tombstone);
            yield* app.v2.worker.drain();
            const freshProvisionCursor = yield* app.v2.eventSink.latestSequence();
            const freshProvision = yield* app.v2.eventSink
              .stream({
                threadId: freshId,
                afterSequence: freshProvisionCursor,
              })
              .pipe(
                Stream.filter((stored) => stored.event.type === "thread.created"),
                Stream.take(1),
                Stream.runDrain,
                Effect.andThen(app.v2.worker.drain()),
                Effect.forkScoped,
              );
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              ...command,
              commandId: CommandId.make("immutable-fork-fresh"),
              newThreadId: freshId,
            });
            yield* Fiber.join(freshProvision);
            const fresh = yield* app.v2.threads.getThreadProjection(freshId);
            assert.equal(fresh.thread.conversationFork?.status, "ready");
            assert.isNull(fresh.thread.deletedAt);
            assert.deepEqual(
              fresh.messages.map((message) => [message.role, message.text]),
              tombstone.messages.map((message) => [message.role, message.text]),
            );
            // The fresh fork shows the source's history by reference, frozen.
            assert.isTrue(
              fresh.messages.every((message) => message.threadId === transferV2ThreadId),
            );
            assert.isTrue(fresh.turnItems.every((item) => item.threadId === freshId));
            assert.isTrue(
              fresh.visibleTurnItems.every(
                ({ item }) => item.runId === null && item.providerTurnId === null,
              ),
            );
            assert.deepEqual(fresh.runs, []);
            assert.deepEqual(fresh.providerSessions, []);
            assert.deepEqual(fresh.runtimeRequests, []);
            assert.deepEqual(yield* app.v2.threads.getThreadProjection(deletedId), tombstone);
          }),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(["local", "new-worktree"] as const)(
    "real V2 running fork with failing workspace capture, mode=%s",
    (workspaceMode) =>
      Effect.gen(function* () {
        const captures: Array<{ readonly cwd: string; readonly checkpointRef: string }> = [];
        const app = yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              checkpoints: {
                captureCheckpoint: (input) =>
                  Effect.sync(() => captures.push(input)).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new VcsCheckpointUnavailableError({
                          operation: "fixture.capture",
                          cwd: input.cwd,
                          reason: "path-limit",
                          detail: "Private diagnostic: oversized Git listing",
                        }),
                      ),
                    ),
                  ),
                hasCheckpointRef: () => Effect.die("A running fork must capture its own baseline"),
                restoreCheckpoint: () => Effect.die("Rejected capture must not restore a checkout"),
                diffCheckpoints: () => Effect.die("Rejected capture must not read a diff"),
                deleteCheckpointRefs: () => Effect.die("Rejected capture must not publish cleanup"),
                listAuthoredPaths: () =>
                  Effect.die("Rejected capture must not list authored paths"),
              },
            },
          },
        });
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-native-capture-failure-" });
        const process = yield* VcsProcess.VcsProcess.pipe(Effect.provide(VcsProcess.layer));
        yield* process.run({
          operation: "fixture.git-init",
          command: "git",
          args: ["init", "--quiet"],
          cwd,
        });
        yield* app.v2.projects.create({
          commandId: CommandId.make("capture-project"),
          projectId: ProjectId.make("transfer-project"),
          title: "Capture source",
          workspaceRoot: cwd,
        });
        yield* seedV2StreamThread(app);
        yield* app.v2.eventSink.write({
          events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).filter(
            (event) => event.type !== "run.updated",
          ),
        });
        const before = yield* app.v2.eventSink.latestSequence();
        const target = ThreadId.make("native-failed-capture-target");
        const dispatch = withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.fork",
            commandId: CommandId.make("native-failed-capture"),
            originThreadId: transferV2ThreadId,
            newThreadId: target,
            sourceRunningRunId: RunId.make("run-0"),
            workspaceMode,
          }),
        );
        if (workspaceMode === "local") {
          const provisioning = yield* app.v2.eventSink
            .stream({ threadId: target, afterSequence: before })
            .pipe(
              Stream.filter((stored) => stored.event.type === "thread.created"),
              Stream.take(1),
              Stream.runDrain,
              Effect.andThen(app.v2.worker.drain()),
              Effect.forkScoped,
            );
          yield* dispatch;
          yield* Fiber.join(provisioning);
          const fork = yield* app.v2.threads.getThreadProjection(target);
          assert.equal(captures.length, 0);
          assert.equal(fork.thread.conversationFork?.status, "ready");
          assert.isNull(fork.thread.conversationFork?.checkpointRef);
          assert.isNull(fork.thread.conversationFork?.checkpointOid);
          assert.deepEqual(fork.runs, []);
          assert.deepEqual(fork.providerSessions, []);
          assert.equal(
            (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).runs[0]?.status,
            "running",
          );
          return;
        }
        const failure = yield* dispatch.pipe(Effect.flip);
        assert.equal(failure._tag, "OrchestrationDispatchCommandError");
        if (failure._tag === "OrchestrationDispatchCommandError") {
          assert.include(failure.message, "This workspace exceeds the snapshot limits");
          assert.notInclude(failure.message, "Private diagnostic");
          assert.isUndefined(failure.cause);
          assert.equal(failure.forkDisposition, "rejected");
        }
        assert.equal(captures.length, 1);
        assert.equal(captures[0]?.cwd, cwd);
        assert.equal(yield* app.v2.eventSink.latestSequence(), before);
        assert.isNull(yield* app.v2.threads.getThreadShell(target));
        assert.equal(
          (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).runs[0]?.status,
          "running",
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(["read", "decode"] as const)(
    "routes websocket rpc V2 shell snapshot errors during %s",
    (stage) =>
      Effect.gen(function* () {
        const failure = Effect.fail(
          new OrchestratorV2.OrchestratorProjectionError({
            threadId: transferV2ThreadId,
            cause: new Error("projection unavailable"),
          }),
        );
        yield* buildAppUnderTest({
          layers: {
            threadManagementV2: {
              readShellSnapshot: () => (stage === "read" ? failure : Effect.succeed(failure)),
            },
          },
        });
        const error = yield* collectV2ShellCatchup(yield* getWsServerUrl("/ws")).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestrationV2GetShellSnapshotError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks an empty V2 shell catch-up replay as synchronized", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const items = yield* collectV2ShellCatchup(yield* getWsServerUrl("/ws"), 0);
      assert.equal(items.at(-1)?.kind, "synchronized");
      assert.deepEqual(
        items.filter((item) => item.kind !== "snapshot"),
        [{ kind: "synchronized" }],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "sends V2 thread snapshots and bounded history fallbacks with a completion marker",
    () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const wsUrl = yield* getWsServerUrl("/ws");
        for (const acceptBoundedSnapshot of [false, true]) {
          const items = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: transferV2ThreadId,
              acceptBoundedSnapshot,
              requestCompletionMarker: true,
            }).pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            ),
          );
          const first = items[0];
          assertTrue(first?.kind === "snapshot");
          assert.equal(first.projection.thread.id, transferV2ThreadId);
          assert.equal(first.snapshotSequence, seeded.sequence);
          assert.deepEqual(first.projection.messages, []);
          assert.equal(first.hasMoreHistory, acceptBoundedSnapshot ? false : undefined);
          assert.deepEqual(items.at(-1), { kind: "synchronized" });
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("replays V2 reasoning items separately from persisted assistant messages", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      const base = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).find(
        (event) => event.type === "message.updated" && event.payload.role === "assistant",
      );
      if (base?.type !== "message.updated") return yield* Effect.die("Missing assistant fixture");
      const reasoning: OrchestrationV2DomainEvent = {
        id: EventId.make("reasoning-event"),
        type: "turn-item.updated",
        threadId: transferV2ThreadId,
        occurredAt: base.occurredAt,
        payload: {
          id: TurnItemId.make("reasoning-item"),
          threadId: transferV2ThreadId,
          runId: base.payload.runId,
          nodeId: base.payload.nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "reasoning",
          text: "Checking evidence.",
          status: "completed",
          streaming: false,
          title: null,
          startedAt: base.occurredAt,
          updatedAt: base.occurredAt,
          completedAt: base.occurredAt,
        },
      };
      const answer: OrchestrationV2DomainEvent = {
        ...base,
        id: EventId.make("answer-event"),
        payload: { ...base.payload, text: "Here is the answer." },
      };
      yield* app.v2.eventSink.write({ events: [reasoning, answer] });
      const wsUrl = yield* getWsServerUrl("/ws");
      const initial = yield* collectV2ThreadCatchup(wsUrl);
      const snapshot = initial[0];
      if (snapshot?.kind !== "snapshot") return yield* Effect.die("Missing thread snapshot");
      assert.deepEqual(
        snapshot.projection.messages.map((message) => [message.role, message.text]),
        [["assistant", "Here is the answer."]],
      );
      assert.isTrue(
        snapshot.projection.turnItems.some(
          (item) => item.type === "reasoning" && item.text === "Checking evidence.",
        ),
      );
      const replay = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence);
      assert.deepEqual(
        replay.flatMap((item) => (item.kind === "event" ? [item.event.type] : [])),
        ["turn-item.updated", "message.updated"],
      );
      const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
      assert.equal(persisted.messages[0]?.role, "assistant");
      assert.isTrue(persisted.turnItems.some((item) => item.type === "reasoning"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "preserves native workflow phases and inert member authority through SQL, HTTP and websocket replay",
    () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const decodeSubagent = decodeWorkflowSubagent;
        const now = DateTime.formatIso(seeded.thread.updatedAt);
        const workflow = decodeSubagent({
          id: "native-workflow",
          threadId: transferV2ThreadId,
          runId: null,
          parentNodeId: "native-root",
          origin: "provider_native",
          createdBy: "agent",
          driver: "claude-code",
          providerInstanceId: "claude-code",
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Review evidence",
          title: "Audit",
          model: "claude/reviewer",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          presentation: {
            kind: "workflow",
            workflowName: "Audit",
            firstSeenAt: now,
            phases: [{ index: 0, title: "Review" }],
            runHandles: {
              runId: "display-handle",
              scriptPath: "/workspace/review.ts",
              sessionUrl: "https://session.example/review",
            },
          },
        });
        const member = decodeSubagent({
          ...encodeWorkflowSubagent(workflow),
          id: "native-member",
          parentNodeId: workflow.id,
          title: "Reader",
          status: "completed",
          result: "Evidence checked",
          completedAt: now,
          presentation: {
            kind: "workflow_agent",
            workflowId: workflow.id,
            agentIndex: 0,
            phaseIndex: 0,
            attempt: 2,
            role: "researcher",
            effort: "high",
            firstSeenAt: now,
            usage: { totalTokens: 50, inputTokens: 30, toolUses: 2 },
          },
        });
        yield* app.v2.eventSink.write({
          events: [workflow, member].map((payload) => ({
            id: EventId.make(`workflow-${payload.id}`),
            type: "subagent.updated" as const,
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload,
          })),
        });
        // Native coordinators also produce their own timeline item. This cohort anchor
        // retains completed display-only members in bounded snapshots.
        yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("workflow-item"),
              type: "turn-item.updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: decodeWorkflowTurnItem({
                id: "workflow-item",
                threadId: transferV2ThreadId,
                runId: null,
                nodeId: workflow.id,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "running",
                title: "Audit",
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "subagent",
                subagentId: workflow.id,
                origin: workflow.origin,
                driver: workflow.driver,
                providerInstanceId: workflow.providerInstanceId,
                childThreadId: null,
                prompt: workflow.prompt,
                result: null,
              }),
            },
          ],
        });
        const headers = {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        };
        const response = yield* measureHttpGet({
          url: `${yield* getHttpServerUrl()}/api/orchestration/threads/${transferV2ThreadId}/bounded`,
          headers,
        });
        assert.equal(response.status, 200);
        const http = yield* decodeLegacyThreadBoundedSnapshot(
          Buffer.from(response.decodedBody).toString("utf8"),
        );
        const socket = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"));
        const snapshot = socket[0];
        assertTrue(snapshot?.kind === "snapshot");
        const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
        assert.deepEqual(http.projection.subagents, persisted.subagents);
        assert.deepEqual(snapshot.projection.subagents, persisted.subagents);
        const model = deriveAgentPanelModel({
          agents: [],
          v2Projection: projectedSubagentsToRuntime(http.projection.subagents),
        });
        assert.equal(model.workflows.length, 1);
        assert.equal(model.workflows[0]?.phases[0]?.members[0]?.attempt, 2);
        assert.equal(model.workflows[0]?.phases[0]?.members[0]?.usage?.toolUses, 2);
        assert.equal(model.liveCount, 0);
        assert.equal(model.workflows[0]?.workflow.runHandles?.runId, "display-handle");
        assert.deepEqual(persisted.runtimeRequests, []);
        assert.isNull(persisted.subagents.find((agent) => agent.id === member.id)?.childThreadId);
        assert.isNull(persisted.subagents.find((agent) => agent.id === member.id)?.nativeTaskRef);
        const replay = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
        const replayed = replay.flatMap((item) =>
          item.kind === "event" && item.event.type === "subagent.updated"
            ? [item.event.payload]
            : [],
        );
        assert.deepEqual(replayed, [workflow, member]);
        assert.deepEqual(replay.at(-1), { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "preserves oversized historical task completion through real HTTP and websocket snapshots and replay",
    () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const seeded = yield* seedV2StreamThread(app);
        const detail = "Review outcome. " + "😀".repeat(12_000);
        const activity = (
          activityId: string,
          kind: string,
          payload: Record<string, unknown>,
          ordinal: number,
        ): OrchestrationV2TurnItem => ({
          id: TurnItemId.make(`migration:v1:history:activity:${activityId}`),
          threadId: transferV2ThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          startedAt: seeded.thread.updatedAt,
          completedAt: seeded.thread.updatedAt,
          updatedAt: seeded.thread.updatedAt,
          type: "dynamic_tool",
          title: kind,
          toolName: kind,
          input: {
            activityId,
            turnId: null,
            tone: "info",
            kind,
            summary: kind,
            sequence: ordinal,
            payload,
          },
        });
        const copied = activity(
          "copied",
          "task.completed",
          {
            taskId: "copied-reviewer",
            agentKind: "agent",
            status: "completed",
            summary: detail,
            typedUsage: { toolUses: 2 },
          },
          3,
        );
        const items = [
          activity(
            "start",
            "task.started",
            { taskId: "reviewer", agentKind: "agent", title: "Review" },
            0,
          ),
          activity(
            "completion",
            "task.completed",
            {
              taskId: "reviewer",
              agentKind: "agent",
              status: "completed",
              summary: detail,
              typedUsage: { totalTokens: 123, toolUses: 4 },
            },
            1,
          ),
          activity(
            "completion-only",
            "task.completed",
            {
              taskId: "completion-only",
              agentKind: "agent",
              status: "failed",
              detail,
              typedUsage: { totalTokens: 99, toolUses: 3 },
            },
            2,
          ),
          {
            ...copied,
            id: TurnItemId.make("fork:historical:copied"),
            inheritedFrom: {
              threadId: ThreadId.make("historical-origin"),
              itemId: copied.id,
              runId: null,
              status: copied.status,
            },
          },
        ];
        yield* app.v2.eventSink.write({
          events: items.map((payload) => ({
            id: EventId.make(`historical-wire:${payload.id}`),
            type: "turn-item.updated" as const,
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload,
          })),
        });
        const beforeTransport = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
        assert.deepEqual(
          beforeTransport.turnItems,
          items.map((item, index) => ({ ...item, ordinal: index + 1 })),
        );
        const headers = {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        };
        const response = yield* measureHttpGet({
          url: `${yield* getHttpServerUrl()}/api/orchestration/threads/${transferV2ThreadId}/bounded`,
          headers,
        });
        assert.equal(response.status, 200);
        const http = yield* decodeLegacyThreadBoundedSnapshot(
          Buffer.from(response.decodedBody).toString("utf8"),
        );
        const wsUrl = yield* getWsServerUrl("/ws");
        const snapshots = yield* collectV2ThreadCatchup(wsUrl);
        const snapshot = snapshots[0];
        assertTrue(snapshot?.kind === "snapshot");
        const replay = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence);
        const replayItems = replay.flatMap((item) =>
          item.kind === "event" && item.event.type === "turn-item.updated"
            ? [item.event.payload]
            : [],
        );
        assert.equal(replayItems.length, items.length);
        for (const wireItems of [
          http.projection.turnItems,
          snapshot.projection.turnItems,
          replayItems,
        ]) {
          const agents = historicalSubagentsToRuntime(wireItems);
          const model = deriveAgentPanelModel({ agents });
          assert.equal(agents.length, 3);
          assert.equal(model.liveCount, 0);
          const reviewer = agents.find(
            (agent) => agent.id === `historical:${transferV2ThreadId}:reviewer`,
          );
          assert.ok(reviewer);
          assert.equal(reviewer.status, "completed");
          assert.deepEqual(reviewer.usage, { totalTokens: 123, toolUses: 4 });
          assert.match(reviewer.result ?? "", /^Review outcome\./);
          assert.isTrue(reviewer.historical);
          const failed = agents.find(
            (agent) => agent.id === `historical:${transferV2ThreadId}:completion-only`,
          );
          assert.equal(failed?.status, "failed");
          assert.deepEqual(failed?.usage, { totalTokens: 99, toolUses: 3 });
          assert.match(failed?.error ?? "", /^Review outcome\./);
          const inherited = agents.find(
            (agent) => agent.id === "historical:historical-origin:copied-reviewer",
          );
          assert.equal(inherited?.status, "completed");
          assert.deepEqual(inherited?.usage, { toolUses: 2 });
          assert.match(inherited?.result ?? "", /^Review outcome\./);
          assert.isTrue(
            wireItems.every(
              (item) => item.runId === null && item.nodeId === null && item.nativeItemRef === null,
            ),
          );
        }
        const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
        assert.deepEqual(persisted.turnItems, beforeTransport.turnItems);
        assert.deepEqual(persisted.runtimeRequests, []);
        assert.deepEqual(replay.at(-1), { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("negotiates compact HTTP snapshots without changing local or inherited history", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const source = yield* seedV2StreamThread(app);
      yield* app.v2.eventSink.write({
        events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false),
      });
      const sourceProjection = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
      const sourceRun = sourceProjection.runs[0];
      assertTrue(sourceRun !== undefined);
      const targetThreadId = ThreadId.make("http-compact-inherited-target");
      const created = transferV2ThreadCreated(ProviderDriverKind.make("codex"));
      yield* app.v2.eventSink.write({
        events: [
          {
            ...created,
            id: EventId.make("http-compact-inherited-target-created"),
            threadId: targetThreadId,
            payload: {
              ...source.thread,
              id: targetThreadId,
              lineage: {
                parentThreadId: transferV2ThreadId,
                relationshipToParent: "fork",
                rootThreadId: transferV2ThreadId,
              },
              forkedFrom: { type: "run", threadId: transferV2ThreadId, runId: sourceRun.id },
            },
          },
        ],
      });
      yield* app.v2.eventSink.write({
        events: transferV2TurnEvents(ProviderDriverKind.make("codex"), 1, false).map((event) => {
          switch (event.type) {
            case "run.created":
              return {
                ...event,
                threadId: targetThreadId,
                payload: { ...event.payload, threadId: targetThreadId },
              };
            case "run.updated":
              return {
                ...event,
                threadId: targetThreadId,
                payload: { ...event.payload, threadId: targetThreadId },
              };
            case "message.updated":
              return {
                ...event,
                threadId: targetThreadId,
                payload: { ...event.payload, threadId: targetThreadId },
              };
            case "turn-item.updated":
              return {
                ...event,
                threadId: targetThreadId,
                payload: { ...event.payload, threadId: targetThreadId },
              };
            default:
              throw new Error(`Unexpected transcript fixture event ${event.type}`);
          }
        }),
      });
      const headers = {
        cookie: yield* getAuthenticatedSessionCookieHeader(),
        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      };
      const url = `${yield* getHttpServerUrl()}/api/orchestration/threads/${targetThreadId}/bounded`;
      const legacyResponse = yield* measureHttpGet({ url, headers });
      const compactResponse = yield* measureHttpGet({
        url,
        headers: { ...headers, [THREAD_SNAPSHOT_FORMAT_HEADER]: COMPACT_THREAD_SNAPSHOT_FORMAT },
      });
      assert.equal(legacyResponse.status, 200);
      assert.equal(compactResponse.status, 200);
      const legacyText = Buffer.from(legacyResponse.decodedBody).toString("utf8");
      const compactText = Buffer.from(compactResponse.decodedBody).toString("utf8");
      const legacy = yield* decodeLegacyThreadBoundedSnapshot(legacyText);
      const compact = yield* decodeTransferThreadSnapshot(compactText);
      assertTrue("snapshotFormat" in compact);
      const { snapshotFormat, ...expanded } = compact;
      assert.equal(snapshotFormat, COMPACT_THREAD_SNAPSHOT_FORMAT);
      assert.deepEqual(expanded, legacy);
      const legacyJson = yield* decodeSnapshotWireAssertions(legacyText);
      const compactJson = yield* decodeSnapshotWireAssertions(compactText);
      assert.notProperty(legacyJson, "snapshotFormat");
      assert.equal(compactJson.snapshotFormat, COMPACT_THREAD_SNAPSHOT_FORMAT);
      let references = 0;
      let inheritedInline = 0;
      for (const [index, row] of legacy.projection.visibleTurnItems.entries()) {
        const legacyRow = legacyJson.projection.visibleTurnItems[index];
        const wireRow = compactJson.projection.visibleTurnItems[index];
        assertTrue(legacyRow !== undefined && wireRow !== undefined);
        assert.notProperty(legacyRow, "itemIndex");
        assert.deepEqual(legacyRow.item, encodeTurnItemJson(row.item));
        if ("itemIndex" in wireRow) {
          references += 1;
          assert.equal(row.visibility, "local");
          assert.notProperty(wireRow, "item");
          const { itemIndex: referenceIndex, ...referenceMetadata } = wireRow;
          const { item: legacyItem, ...legacyMetadata } = legacyRow;
          assertTrue(typeof referenceIndex === "number");
          assert.deepEqual(referenceMetadata, legacyMetadata);
          assert.deepEqual(compactJson.projection.turnItems[referenceIndex], legacyItem);
        } else if (row.visibility === "inherited") {
          inheritedInline += 1;
          assert.deepEqual(wireRow, legacyRow);
        }
      }
      assert.isAbove(references, 0);
      assert.isAbove(inheritedInline, 0);
      assert.deepEqual(
        legacy.projection.runs.map((run) => run.id),
        [RunId.make("run-1")],
      );
      assert.isTrue(
        legacy.projection.visibleTurnItems.some((row) => row.sourceThreadId === transferV2ThreadId),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("pages the complete V2 transcript after a bounded HTTP cold open", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      yield* seedV2StreamThread(app);
      const turns = THREAD_HISTORY_PAGE_POLICY.maxUserTurns * 3;
      for (let index = 0; index < turns; index++) {
        yield* app.v2.eventSink.write({
          events: transferV2TurnEvents(ProviderDriverKind.make("codex"), index, false),
        });
      }
      const baseUrl = yield* getHttpServerUrl();
      const headers = {
        cookie: yield* getAuthenticatedSessionCookieHeader(),
        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      };
      const response = yield* measureHttpGet({
        url: `${baseUrl}/api/orchestration/threads/${transferV2ThreadId}/bounded`,
        headers,
      });
      assert.equal(response.status, 200);
      const snapshot = yield* decodeTransferThreadSnapshot(
        Buffer.from(response.decodedBody).toString("utf8"),
      );
      assert.equal(
        snapshot.projection.messages.length,
        THREAD_HISTORY_PAGE_POLICY.maxUserTurns * 2,
      );
      assert.isTrue(snapshot.hasMoreHistory);
      assert.isNotNull(snapshot.historyCursor);
      let cursor: string | null = snapshot.historyCursor;
      const items = [...snapshot.projection.visibleTurnItems];
      const seen = new Set<string>();
      while (cursor !== null) {
        assert.isFalse(seen.has(cursor), "history cursor must advance");
        seen.add(cursor);
        const older: Effect.Success<ReturnType<typeof measureHttpGet>> = yield* measureHttpGet({
          url: `${baseUrl}/api/orchestration/threads/${transferV2ThreadId}/history?cursor=${encodeURIComponent(cursor)}`,
          headers,
        });
        assert.equal(older.status, 200);
        const page: Effect.Success<ReturnType<typeof decodeTransferHistoryPage>> =
          yield* decodeTransferHistoryPage(Buffer.from(older.decodedBody).toString("utf8"));
        assert.isAbove(page.items.length, 0);
        assert.equal(page.snapshotSequence, snapshot.snapshotSequence);
        assert.equal(page.hasMoreHistory, page.nextCursor !== null);
        items.unshift(...page.items);
        cursor = page.nextCursor;
      }
      const persisted = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
      assert.deepEqual(
        items.map((row) => row.sourceItemId),
        persisted.visibleTurnItems.map((row) => row.sourceItemId),
      );
      assert.equal(new Set(items.map((row) => row.sourceItemId)).size, items.length);
      for (const type of ["user_message", "assistant_message", "dynamic_tool"] as const) {
        assert.equal(items.filter((row) => row.item.type === type).length, turns);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    (["thread", "shell"] as const).map((subscription) => ({
      caseTitle: `keeps V2 ${subscription} changes committed during snapshot capture`,
      subscription,
    })),
  )("$caseTitle", ({ subscription }) =>
    Effect.gen(function* () {
      const captureEntered = yield* Deferred.make<void>();
      const releaseCapture = yield* Deferred.make<void>();
      const app = yield* buildAppUnderTest({
        transformThreadManagementV2: (threads) => ({
          ...threads,
          getThreadSnapshot: (threadId) =>
            threads.getThreadSnapshot(threadId).pipe(
              Effect.tap(() => Deferred.succeed(captureEntered, undefined)),
              Effect.tap(() => Deferred.await(releaseCapture)),
            ),
          readShellSnapshot: (options) =>
            threads.readShellSnapshot(options).pipe(
              // The inner decode runs after the shell read transaction commits.
              // Hold emission here so the competing writer can commit independently.
              Effect.map((decode) =>
                decode.pipe(
                  Effect.tap(() => Deferred.succeed(captureEntered, undefined)),
                  Effect.tap(() => Deferred.await(releaseCapture)),
                ),
              ),
            ),
        }),
      });
      const seeded = yield* seedV2StreamThread(app);
      const received = yield* Queue.unbounded<
        OrchestrationV2ThreadStreamItem | OrchestrationV2ShellStreamItem
      >();
      const wsUrl = yield* getWsServerUrl("/ws");
      const reader = yield* withWsRpcClient(wsUrl, (client) =>
        Effect.gen(function* () {
          if (subscription === "thread") {
            return yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: transferV2ThreadId,
              requestCompletionMarker: true,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item)));
          }
          return yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.runForEach((item) => Queue.offer(received, item)));
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(captureEntered);
      const writer = yield* app.v2.eventSink
        .write({
          events: [
            {
              id: EventId.make("snapshot-race-update"),
              type: "thread.metadata-updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: "Committed during capture" },
            },
          ],
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseCapture, undefined);
      const stored = yield* Fiber.join(writer);
      const prefix = yield* collectQueueUntil(
        received,
        (item) => item.kind === "synchronized",
        "snapshot capture completion",
      );
      if (subscription === "shell") yield* TestClock.adjust(Duration.millis(100));
      const changes = yield* collectQueueUntil(
        received,
        (item) =>
          subscription === "thread"
            ? item.kind === "event" && item.sequence === stored[0]!.sequence
            : item.kind === "thread.updated" && item.thread.title === "Committed during capture",
        `a committed ${subscription} change after snapshot capture`,
      );
      const items = [...prefix, ...changes];
      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "synchronized");
      assert.equal(items.at(-1)?.kind, subscription === "thread" ? "event" : "thread.updated");
      yield* Fiber.interrupt(reader);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "detaches an overflowing V2 producer while a live RPC ACK is held and resumes authoritatively",
    () =>
      Effect.gen(function* () {
        const attached = yield* Deferred.make<void>();
        const detached = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const app = yield* buildAppUnderTest({
          transformThreadManagementV2: (threads) => ({
            ...threads,
            streamStoredEventsFrom: (input) =>
              Stream.unwrap(
                Deferred.succeed(attached, undefined).pipe(
                  Effect.as(
                    threads
                      .streamStoredEventsFrom(input)
                      .pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
                  ),
                ),
              ),
          }),
        });
        const seeded = yield* seedV2StreamThread(app);
        const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const wsUrl = yield* getWsServerUrl("/ws");
        const reader = yield* makeWsRpcClient.pipe(
          Effect.flatMap((client) =>
            client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: transferV2ThreadId,
              afterSequence: seeded.sequence,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
          ),
          Effect.provide(withFirstWsAckHeld(wsUrl, held, release)),
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(attached);
        const first = yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("held-ack-first"),
              type: "thread.metadata-updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: "First delivered" },
            },
          ],
        });
        yield* Deferred.await(held);
        yield* app.v2.eventSink.write({
          events: Array.from({ length: 1_100 }, (_, index) => ({
            id: EventId.make(`held-ack-overflow-${index}`),
            type: "thread.metadata-updated" as const,
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload: { ...seeded.thread, title: `Committed ${index}` },
          })),
        });
        // This finalizer is upstream of RPC delivery: it must run before ACK release.
        yield* Deferred.await(detached);
        assert.isFalse(yield* Deferred.isDone(release));
        assert.equal(
          (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).thread.title,
          "Committed 1099",
        );
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(reader);
        assertTrue(result._tag === "Failure");
        assert.equal(result.failure._tag, "OrchestrationV2GetThreadProjectionError");
        const recovered = yield* collectV2ThreadCatchup(wsUrl, first[0]!.sequence);
        const snapshot = recovered[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.projection.thread.title, "Committed 1099");
        assert.deepEqual(recovered.at(-1), { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "detaches an overflowing V2 shell producer before held ACK release and recovers removed entries",
    () =>
      Effect.gen(function* () {
        const attached = yield* Deferred.make<void>();
        const detached = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let observeLive = false;
        const app = yield* buildAppUnderTest({
          transformApplicationEventStore: (events) => ({
            ...events,
            streamProjectedApplicationEvents: (input) =>
              !observeLive
                ? events.streamProjectedApplicationEvents(input)
                : Stream.unwrap(
                    Deferred.succeed(attached, undefined).pipe(
                      Effect.as(
                        events
                          .streamProjectedApplicationEvents(input)
                          .pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
                      ),
                    ),
                  ),
          }),
        });
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-shell-overflow-",
        });
        const projectId = ProjectId.make("shell-overflow-removed-project");
        yield* app.v2.projects.create({
          commandId: CommandId.make("shell-overflow-create-project"),
          projectId,
          title: "Removed project",
          workspaceRoot,
        });
        const seeded = yield* seedV2StreamThread(app);
        const archivedId = ThreadId.make("shell-overflow-archived-thread");
        const archived = yield* seedV2StreamThread(app, archivedId);
        const wsUrl = yield* getWsServerUrl("/ws");
        const initial = yield* collectV2ShellCatchup(wsUrl);
        const initialSnapshot = initial[0];
        assertTrue(initialSnapshot?.kind === "snapshot");
        assert.isTrue(
          initialSnapshot.snapshot.projects.some((project) => project.id === projectId),
        );
        assert.isTrue(initialSnapshot.snapshot.threads.some((thread) => thread.id === archivedId));
        const cursor = initialSnapshot.snapshot.snapshotSequence;
        observeLive = true;
        const reader = yield* makeWsRpcClient.pipe(
          Effect.flatMap((client) =>
            client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({ afterSequence: cursor }).pipe(
              Stream.runDrain,
            ),
          ),
          Effect.provide(withFirstWsAckHeld(wsUrl, held, release, attached)),
          Effect.result,
          Effect.forkScoped,
        );
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        yield* Deferred.await(attached);
        yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("shell-held-first-live-update"),
              type: "thread.metadata-updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: "First live shell update" },
            },
          ],
        });
        yield* TestClock.adjust(Duration.millis(100));
        yield* Deferred.await(held);
        yield* app.v2.eventSink.write({
          events: Array.from({ length: 1_100 }, (_, index) => {
            const threadId = ThreadId.make(`shell-held-overflow-${index}`);
            return {
              id: EventId.make(`shell-held-overflow-${index}`),
              type: "thread.created" as const,
              threadId,
              occurredAt: seeded.thread.updatedAt,
              payload: {
                ...seeded.thread,
                id: threadId,
                title: `Shell committed ${index}`,
                lineage: { ...seeded.thread.lineage, rootThreadId: threadId },
              },
            };
          }),
        });
        yield* Deferred.await(detached);
        assert.isFalse(yield* Deferred.isDone(release));
        yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("shell-overflow-delete-thread"),
              type: "thread.deleted",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, deletedAt: seeded.thread.updatedAt },
            },
            {
              id: EventId.make("shell-overflow-archive-thread"),
              type: "thread.archived",
              threadId: archivedId,
              occurredAt: archived.thread.updatedAt,
              payload: { ...archived.thread, archivedAt: archived.thread.updatedAt },
            },
          ],
        });
        yield* app.v2.projects.delete({
          commandId: CommandId.make("shell-overflow-delete-project"),
          projectId,
        });
        assertTrue(Option.isNone(yield* app.v2.projects.getShell(projectId)));
        assertTrue(
          (yield* app.v2.threads.getThreadProjection(transferV2ThreadId)).thread.deletedAt !== null,
        );
        assertTrue(
          (yield* app.v2.threads.getThreadProjection(archivedId)).thread.archivedAt !== null,
        );
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(reader);
        assertTrue(result._tag === "Failure");
        assert.equal(result.failure._tag, "OrchestrationV2GetShellSnapshotError");
        const recovered = yield* collectV2ShellCatchup(wsUrl, cursor);
        const snapshot = recovered[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.isFalse(snapshot.snapshot.projects.some((project) => project.id === projectId));
        assert.isFalse(
          snapshot.snapshot.threads.some(
            (thread) => thread.id === transferV2ThreadId || thread.id === archivedId,
          ),
        );
        assert.deepEqual(recovered.at(-1), { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "coalesces live V2 tool updates without crossing interleaved message or terminal boundaries",
    () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        yield* seedV2StreamThread(app);
        const fixture = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false);
        const run = fixture.find((event) => event.type === "run.created");
        assertTrue(run?.type === "run.created");
        const userMessage = fixture.find(
          (event) => event.type === "message.updated" && event.payload.role === "user",
        );
        const userItem = fixture.find(
          (event) => event.type === "turn-item.updated" && event.payload.type === "user_message",
        );
        assertTrue(userMessage?.type === "message.updated");
        assertTrue(
          userItem?.type === "turn-item.updated" && userItem.payload.type === "user_message",
        );
        const seededRun = yield* app.v2.eventSink.write({ events: [run, userMessage, userItem] });
        const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const wsUrl = yield* getWsServerUrl("/ws");
        const reader = yield* withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: transferV2ThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
        ).pipe(Effect.forkScoped);
        const initial = yield* collectQueueUntil(
          received,
          (item) => item.kind === "synchronized",
          "initial live tool subscription",
        );
        const snapshot = initial.find((item) => item.kind === "snapshot");
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.projection.runs[0]?.id, run.payload.id);
        const tool = fixture.find(
          (event) =>
            event.type === "turn-item.updated" && event.payload.type === "command_execution",
        );
        const message = fixture.find(
          (event) => event.type === "message.updated" && event.payload.role === "assistant",
        );
        assertTrue(tool?.type === "turn-item.updated" && tool.payload.type === "command_execution");
        assertTrue(message?.type === "message.updated");
        const toolPayload = tool.payload;
        const update = (index: number): OrchestrationV2DomainEvent => ({
          ...tool,
          id: EventId.make(`live-tool-${index}`),
          payload: {
            ...toolPayload,
            status: "running",
            completedAt: null,
            title: `Progress ${index}`,
            output: "",
          },
        });
        const completed: OrchestrationV2DomainEvent = {
          ...tool,
          id: EventId.make("live-tool-terminal"),
          payload: { ...toolPayload, status: "completed", title: "Done" },
        };
        const stored = yield* app.v2.eventSink.write({
          events: [
            ...Array.from({ length: 50 }, (_, index) => update(index)),
            {
              ...message,
              id: EventId.make("interleaved-answer"),
              payload: { ...message.payload, text: "Evidence checkpoint" },
            },
            ...Array.from({ length: 50 }, (_, index) => update(index + 50)),
            completed,
          ],
        });
        const items = yield* collectQueueUntil(
          received,
          (item) => item.kind === "event" && item.sequence === stored.at(-1)!.sequence,
          "terminal live tool update",
        );
        const events = items.flatMap((item) => (item.kind === "event" ? [item] : []));
        const updates = events.filter((item) => item.event.type === "turn-item.updated");
        assert.isBelow(updates.length, 101);
        const boundary = events.findIndex(
          (item) => item.event.id === EventId.make("interleaved-answer"),
        );
        assert.isAbove(boundary, 0);
        const before = events[boundary - 1]?.event;
        assertTrue(before?.type === "turn-item.updated");
        assert.equal(before.payload.title, "Progress 49");
        assert.equal(events.at(-1)?.event.id, completed.id);
        const sequences = events.map((event) => event.sequence);
        assert.deepEqual(
          sequences,
          sequences.toSorted((a, b) => a - b),
        );
        const projection = yield* app.v2.threads.getThreadProjection(transferV2ThreadId);
        const finalTool = projection.turnItems.find((item) => item.id === tool.payload.id);
        assert.equal(finalTool?.status, "completed");
        assert.equal(finalTool?.title, "Done");
        assert.equal(
          projection.messages.find((entry) => entry.id === message.payload.id)?.text,
          "Evidence checkpoint",
        );
        const clientProjection = events.reduce<OrchestrationV2ThreadProjection | null>(
          (current, item) => applyOrchestrationV2ProjectionEvent(current, item.event),
          snapshot.projection,
        );
        assertTrue(clientProjection !== null);
        const expected = projectThreadProjectionForWire(projection);
        assert.deepEqual(clientProjection.messages, expected.messages);
        assert.deepEqual(clientProjection.turnItems, expected.turnItems);
        assert.deepEqual(clientProjection.visibleTurnItems, expected.visibleTurnItems);
        assert.deepEqual(clientProjection.runs, expected.runs);
        assert.deepEqual(
          clientProjection.visibleTurnItems.map((row) => row.sourceItemId),
          [userItem.payload.id, tool.payload.id],
        );
        assert.equal(clientProjection.visibleTurnItems.at(-1)?.item.status, "completed");
        assert.equal(clientProjection.turnItems.length, 2);
        yield* Fiber.interrupt(reader);
        const replay = yield* collectV2ThreadCatchup(wsUrl, seededRun.at(-1)!.sequence);
        assert.equal(replay.filter((item) => item.kind === "event").length, 102);
        assert.deepEqual(replay.at(-1), { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "keeps concurrent V2 commits beyond a captured replay high-water mark after synchronization",
    () =>
      Effect.gen(function* () {
        const replayEntered = yield* Deferred.make<void>();
        const releaseReplay = yield* Deferred.make<void>();
        const app = yield* buildAppUnderTest({
          transformApplicationEventStore: (events) => ({
            ...events,
            readAgentEvents: (input) =>
              Stream.unwrap(
                Deferred.succeed(replayEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReplay)),
                  Effect.as(events.readAgentEvents(input)),
                ),
              ),
          }),
        });
        const seeded = yield* seedV2StreamThread(app);
        const previous = yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("high-water-before"),
              type: "thread.metadata-updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: "Before high water" },
            },
          ],
        });
        const received = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const reader = yield* withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: transferV2ThreadId,
            afterSequence: seeded.sequence,
            requestCompletionMarker: true,
          }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(replayEntered);
        const concurrent = yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("high-water-concurrent"),
              type: "thread.metadata-updated",
              threadId: transferV2ThreadId,
              occurredAt: seeded.thread.updatedAt,
              payload: { ...seeded.thread, title: "After high water" },
            },
          ],
        });
        yield* Deferred.succeed(releaseReplay, undefined);
        const items = yield* collectQueueUntil(
          received,
          (item) => item.kind === "event" && item.sequence === concurrent[0]!.sequence,
          "commit after captured replay head",
        );
        assert.deepEqual(
          items.map((item) => (item.kind === "event" ? item.sequence : item.kind)),
          [previous[0]!.sequence, "synchronized", concurrent[0]!.sequence],
        );
        yield* Fiber.interrupt(reader);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "coalesces a busy V2 shell independently of quiet threads and retries transient projection reads",
    () =>
      Effect.gen(function* () {
        const failedRead = yield* Deferred.make<void>();
        const shellReads = yield* Ref.make<ThreadId[]>([]);
        const busyId = ThreadId.make("shell-fairness-busy");
        let failBusyRead = true;
        const app = yield* buildAppUnderTest({
          transformThreadManagementV2: (threads) => ({
            ...threads,
            getThreadShell: (threadId) =>
              Ref.update(shellReads, (reads) => [...reads, threadId]).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (threadId !== busyId || !failBusyRead)
                      return threads.getThreadShell(threadId);
                    failBusyRead = false;
                    return Deferred.succeed(failedRead, undefined).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new OrchestratorV2.OrchestratorProjectionError({
                            threadId,
                            cause: new Error("synthetic transient shell read failure"),
                          }),
                        ),
                      ),
                    );
                  }),
                ),
              ),
          }),
        });
        const quiet = yield* seedV2StreamThread(app);
        const busy = yield* seedV2StreamThread(app, busyId);
        const received = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const reader = yield* withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
          client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
        ).pipe(Effect.forkScoped);
        yield* collectQueueUntil(
          received,
          (item) => item.kind === "synchronized",
          "initial fairness shell snapshot",
        );
        const stored = yield* app.v2.eventSink.write({
          events: [
            ...Array.from({ length: 450 }, (_, index) => ({
              id: EventId.make(`shell-busy-${index}`),
              type: "thread.metadata-updated" as const,
              threadId: busyId,
              occurredAt: busy.thread.updatedAt,
              payload: { ...busy.thread, title: `Busy ${index}` },
            })),
            {
              id: EventId.make("shell-quiet-update"),
              type: "thread.metadata-updated" as const,
              threadId: transferV2ThreadId,
              occurredAt: quiet.thread.updatedAt,
              payload: { ...quiet.thread, title: "Quiet changed" },
            },
          ],
        });
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Deferred.await(failedRead);
        yield* TestClock.adjust(Duration.seconds(5));
        const seen = new Set<string>();
        const items = yield* collectQueueUntil(
          received,
          (item) => {
            if (item.kind === "thread.updated") seen.add(item.thread.title);
            return seen.has("Busy 449") && seen.has("Quiet changed");
          },
          "both committed shell projections after transient recovery",
        );
        assert.isBelow((yield* Ref.get(shellReads)).length, 10);
        assert.isTrue(
          items.some(
            (item) =>
              item.kind === "thread.updated" &&
              item.thread.id === transferV2ThreadId &&
              item.sequence === stored.at(-1)!.sequence,
          ),
        );
        assert.equal((yield* app.v2.threads.getThreadProjection(busyId)).thread.title, "Busy 449");
        yield* Fiber.interrupt(reader);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("projects large V2 tool output while retaining the complete persisted result", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      const base = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false).find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "command_execution",
      );
      assertTrue(base?.type === "turn-item.updated" && base.payload.type === "command_execution");
      const output = "Build complete\n" + "x".repeat(9 * 1024 * 1024);
      yield* app.v2.eventSink.write({
        events: [
          {
            ...base,
            payload: { ...base.payload, output, title: "Build complete" },
          },
        ],
      });
      const items = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
      // Raw payload budget requires an authoritative snapshot, not an oversized replay.
      const first = items[0];
      assertTrue(first?.kind === "snapshot");
      const tool = first.projection.turnItems.find((item) => item.id === base.payload.id);
      assertTrue(tool?.type === "command_execution");
      assert.equal(tool.title, "Build complete");
      assert.equal(tool.output, undefined);
      const persisted = (yield* app.v2.threads.getThreadProjection(transferV2ThreadId))
        .turnItems[0];
      assertTrue(persisted?.type === "command_execution");
      assert.equal(persisted.output, output);
      const shell = yield* collectV2ShellCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
      assert.equal(shell.at(-1)?.kind, "synchronized");
      assert.isFalse(encodeTestJson(shell).includes(output));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    (["thread", "shell"] as const).map((subscription) => ({
      caseTitle: `replaces an ahead-of-head V2 ${subscription} cursor with an authoritative snapshot`,
      subscription,
    })),
  )("$caseTitle", ({ subscription }) =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      const wsUrl = yield* getWsServerUrl("/ws");
      if (subscription === "thread") {
        const items = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence + 100);
        const snapshot = items[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.snapshotSequence, seeded.sequence);
        assert.equal(snapshot.projection.thread.id, transferV2ThreadId);
      } else {
        const items = yield* collectV2ShellCatchup(wsUrl, seeded.sequence + 100);
        const snapshot = items[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.snapshot.snapshotSequence, seeded.sequence);
        assert.equal(snapshot.snapshot.threads[0]?.id, transferV2ThreadId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("replays a small V2 thread range across a large application gap", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      const unrelated = ThreadId.make("unrelated-busy-thread");
      const other = yield* seedV2StreamThread(app, unrelated);
      yield* app.v2.eventSink.write({
        events: Array.from({ length: 1_001 }, (_, index) => ({
          id: EventId.make(`unrelated-${index}`),
          type: "thread.metadata-updated" as const,
          threadId: unrelated,
          occurredAt: other.thread.updatedAt,
          payload: { ...other.thread, title: `Unrelated ${index}` },
        })),
      });
      const stored = yield* app.v2.eventSink.write({
        events: [
          {
            id: EventId.make("small-thread-replay"),
            type: "thread.metadata-updated",
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload: { ...seeded.thread, title: "Small thread replay" },
          },
        ],
      });
      const items = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
      assert.deepEqual(
        items.map((item) => (item.kind === "event" ? item.sequence : item.kind)),
        [stored[0]!.sequence, "synchronized"],
      );
      const update = items[0];
      assertTrue(update?.kind === "event" && update.event.type === "thread.metadata-updated");
      assert.equal(update.event.payload.title, "Small thread replay");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    (["thread", "shell"] as const).map((subscription) => ({
      caseTitle: `replaces an over-limit V2 ${subscription} replay with a complete snapshot`,
      subscription,
    })),
  )("$caseTitle", ({ subscription }) =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      const stored = yield* app.v2.eventSink.write({
        events: Array.from({ length: 1_001 }, (_, index) => ({
          id: EventId.make(`over-limit-${index}`),
          type: "thread.metadata-updated" as const,
          threadId: transferV2ThreadId,
          occurredAt: seeded.thread.updatedAt,
          payload: { ...seeded.thread, title: `Updated ${index}` },
        })),
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      if (subscription === "thread") {
        const items = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence);
        const snapshot = items[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.snapshotSequence, stored.at(-1)!.sequence);
        assert.equal(snapshot.projection.thread.title, "Updated 1000");
        assert.deepEqual(items.at(-1), { kind: "synchronized" });
      } else {
        const items = yield* collectV2ShellCatchup(wsUrl, seeded.sequence);
        const snapshot = items[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.snapshot.snapshotSequence, stored.at(-1)!.sequence);
        assert.equal(snapshot.snapshot.threads[0]?.title, "Updated 1000");
        assert.deepEqual(items.at(-1), { kind: "synchronized" });
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("resets cached V2 history when a deleted thread ID is created again", () =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      yield* app.v2.eventSink.write({
        events: [
          {
            id: EventId.make("delete-before-recreation"),
            type: "thread.deleted",
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload: { ...seeded.thread, deletedAt: seeded.thread.updatedAt },
          },
        ],
      });
      const recreated = transferV2ThreadCreated(ProviderDriverKind.make("codex"));
      assertTrue(recreated.type === "thread.created");
      yield* app.v2.eventSink.write({
        events: [
          {
            ...recreated,
            id: EventId.make("recreated-thread"),
            payload: { ...recreated.payload, title: "Recreated thread" },
          },
        ],
      });
      const items = yield* collectV2ThreadCatchup(yield* getWsServerUrl("/ws"), seeded.sequence);
      const snapshot = items[0];
      assertTrue(snapshot?.kind === "snapshot");
      assert.equal(snapshot.projection.thread.title, "Recreated thread");
      assert.deepEqual(snapshot.projection.messages, []);
      assert.deepEqual(items.at(-1), { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(
    [false, true].map((oversized) => ({
      caseTitle: `synchronizes a deleted V2 thread through authoritative ${oversized ? "snapshot" : "event"} replay`,
      oversized,
    })),
  )("$caseTitle", ({ oversized }) =>
    Effect.gen(function* () {
      const app = yield* buildAppUnderTest();
      const seeded = yield* seedV2StreamThread(app);
      if (oversized) {
        yield* app.v2.eventSink.write({
          events: Array.from({ length: 1_001 }, (_, index) => ({
            id: EventId.make(`deleted-over-limit-${index}`),
            type: "thread.metadata-updated" as const,
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload: { ...seeded.thread, title: `Updated ${index}` },
          })),
        });
      }
      const deleted = yield* app.v2.eventSink.write({
        events: [
          {
            id: EventId.make("deleted-thread"),
            type: "thread.deleted",
            threadId: transferV2ThreadId,
            occurredAt: seeded.thread.updatedAt,
            payload: { ...seeded.thread, deletedAt: seeded.thread.updatedAt },
          },
        ],
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* collectV2ThreadCatchup(wsUrl, seeded.sequence).pipe(Effect.result);
      assertTrue(result._tag === "Success");
      if (oversized) {
        assert.deepEqual(
          result.success.map((item) => item.kind),
          ["snapshot", "synchronized"],
        );
        const snapshot = result.success[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.equal(snapshot.projection.thread.id, transferV2ThreadId);
        assertTrue(snapshot.projection.thread.deletedAt !== null);
        assert.equal(
          DateTime.formatIso(snapshot.projection.thread.deletedAt),
          DateTime.formatIso(seeded.thread.updatedAt),
        );
      } else {
        assertTrue(result._tag === "Success");
        assert.deepEqual(
          result.success.map((item) => item.kind),
          ["event", "synchronized"],
        );
      }
      const shell = yield* collectV2ShellCatchup(wsUrl, seeded.sequence);
      if (oversized) {
        const snapshot = shell[0];
        assertTrue(snapshot?.kind === "snapshot");
        assert.isFalse(
          snapshot.snapshot.threads.some((thread) => thread.id === transferV2ThreadId),
        );
        assert.deepEqual(shell.at(-1), { kind: "synchronized" });
      } else {
        assert.isTrue(
          shell.some(
            (item) =>
              item.kind === "thread.removed" &&
              item.threadId === transferV2ThreadId &&
              item.sequence === deleted[0]!.sequence &&
              item.location === "active",
          ),
        );
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  const makeNativeArchiveFixture = Effect.fn("makeNativeArchiveFixture")(function* (
    name: string,
    sessionState: "ready" | "stopped" | "absent" = "ready",
    unloadFailure?: "failure" | "defect",
    threadId = ThreadId.make(`native-archive-${name}`),
  ) {
    const effects: string[] = [];
    let instance: ProviderInstance | undefined;
    const app = yield* buildAppUnderTest({
      layers: {
        terminalManager: {
          close: (input) =>
            Effect.sync(() => {
              effects.push(`terminal.close:${input.threadId}`);
            }),
        },
        providerInstanceRegistry: {
          getInstance: (id) =>
            Effect.succeed(id === defaultModelSelection.instanceId ? instance : undefined),
          listInstances: Effect.sync(() => (instance === undefined ? [] : [instance])),
        },
      },
    });
    const adapter = makeNativeSessionAdapterV2({
      instanceId: defaultModelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      idAllocator: app.v2.idAllocator,
      defaultCwd: app.cwd,
      capabilities: CodexProviderCapabilitiesV2,
      continuations: { offer: () => Effect.void },
      open: () =>
        Effect.succeed({
          nativeId: `native-archive-provider-${name}`,
          nativeThreadKnown: true,
          send: () => Effect.die("Archiving must not start a provider turn"),
          interrupt: Effect.void,
          respond: () => Effect.die("Archiving must not answer a provider request"),
          resume: () => Effect.void,
        }),
    });
    instance = {
      instanceId: nativeAdmissionInstance.instanceId,
      driverKind: nativeAdmissionInstance.driverKind,
      enabled: true,
      displayName: nativeAdmissionInstance.displayName,
      continuationIdentity: nativeAdmissionInstance.continuationIdentity,
      snapshot: nativeAdmissionInstance.snapshot,
      orchestrationAdapter: {
        ...adapter,
        openSession: (input) =>
          adapter.openSession(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              unloadThread: () =>
                Effect.gen(function* () {
                  effects.push(`provider.unload:${threadId}`);
                  if (unloadFailure === "failure")
                    return yield* new ProviderAdapterProtocolError({
                      driver: ProviderDriverKind.make("codex"),
                      detail: "Controlled archive unload failure",
                    });
                  if (unloadFailure === "defect")
                    return yield* Effect.die(new Error("Controlled archive unload defect"));
                }),
            })),
          ),
      },
      get textGeneration(): never {
        throw new Error("Archive must not generate text");
      },
    };
    yield* seedV2StreamThread(app, threadId);
    const providerSessionId = ProviderSessionId.make(`native-archive-session-${name}`);
    if (sessionState !== "absent") {
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: app.cwd,
      };
      const runtime = yield* app.v2.providerSessions.open({
        threadId,
        providerSessionId,
        modelSelection: defaultModelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: defaultModelSelection,
        runtimePolicy,
      });
      yield* app.v2.eventSink.write({
        events: [
          {
            id: EventId.make(`native-archive-provider-thread-${name}`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: providerThread,
          },
        ],
      });
      if (sessionState === "stopped") {
        yield* app.v2.providerSessions.close(providerSessionId);
        const stopped = yield* app.v2.threads.getThreadRecords(threadId, ["providerSessions"]);
        assert.equal(
          stopped.providerSessions.find((row) => row.id === providerSessionId)?.status,
          "stopped",
        );
        assert.isTrue(Option.isNone(yield* app.v2.providerSessions.get(providerSessionId)));
      }
    }
    const wsUrl = yield* getWsServerUrl("/ws");
    const dispatch = (type: "thread.archive" | "thread.settle", commandId: CommandId) =>
      Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({ type, commandId, threadId }),
        ),
      );
    return { app, threadId, providerSessionId, effects, dispatch };
  });

  it.effect.each(
    (
      [
        { name: "ready", sessionState: "ready", unloadFailure: undefined },
        { name: "no-session", sessionState: "absent", unloadFailure: undefined },
        { name: "stopped", sessionState: "stopped", unloadFailure: undefined },
        { name: "unload-failure", sessionState: "ready", unloadFailure: "failure" },
        { name: "unload-defect", sessionState: "ready", unloadFailure: "defect" },
      ] as const
    ).map((scenario) => ({
      caseTitle: `archives native threads and closes terminals (${scenario.name})`,
      scenario,
    })),
  )("$caseTitle", ({ scenario }) =>
    Effect.gen(function* () {
      const fixture = yield* makeNativeArchiveFixture(
        scenario.name,
        scenario.sessionState,
        scenario.unloadFailure,
      );
      const commandId = CommandId.make(`native-archive-${scenario.name}`);
      const before = yield* fixture.app.v2.eventSink.latestSequence();
      const receipt = yield* fixture.dispatch("thread.archive", commandId);
      assert.isAbove(receipt.sequence, before);
      assert.deepEqual(fixture.effects, []);
      const archived = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
      assert.isNotNull(archived.thread.archivedAt);
      const expectedTypes =
        scenario.sessionState === "ready"
          ? ["provider-session.detach", "terminal.cleanup"]
          : ["terminal.cleanup"];
      const pending = yield* fixture.app.v2.outbox.listByCommandId(commandId);
      assert.sameMembers(
        pending.map((row) => row.request.type),
        expectedTypes,
      );
      assert.isTrue(pending.every((row) => row.status === "pending"));
      if (scenario.sessionState === "ready") {
        assert.isUndefined(
          archived.providerSessions.find((row) => row.id === fixture.providerSessionId),
        );
        const detach = pending.find((row) => row.request.type === "provider-session.detach");
        assertTrue(detach?.request.type === "provider-session.detach");
        assert.equal(detach.request.providerSessionId, fixture.providerSessionId);
        assert.isTrue(detach.request.revokeMcpCredential);
      }
      assert.equal(yield* fixture.app.v2.worker.drain(), expectedTypes.length);
      assert.deepEqual(
        fixture.effects,
        scenario.sessionState === "ready"
          ? [`provider.unload:${fixture.threadId}`, `terminal.close:${fixture.threadId}`]
          : [`terminal.close:${fixture.threadId}`],
      );
      const completed = yield* fixture.app.v2.outbox.listByCommandId(commandId);
      assert.isTrue(completed.every((row) => row.status === "succeeded"));
      const repeated = yield* fixture.dispatch("thread.archive", commandId);
      assert.equal(repeated.sequence, receipt.sequence);
      assert.equal(yield* fixture.app.v2.worker.drain(), 0);
      assert.deepEqual(yield* fixture.app.v2.outbox.listByCommandId(commandId), completed);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives the recorded native session before active shell removal", () =>
    Effect.gen(function* () {
      const fixture = yield* makeNativeArchiveFixture("precheck");
      const commandId = CommandId.make("native-archive-precheck");
      assert.isNotNull(yield* fixture.app.v2.threads.getThreadShell(fixture.threadId));
      yield* fixture.dispatch("thread.archive", commandId);
      const active = yield* fixture.app.v2.threads.getShellSnapshot();
      assert.isFalse(active.threads.some((thread) => thread.id === fixture.threadId));
      const pending = yield* fixture.app.v2.outbox.listByCommandId(commandId);
      assert.isTrue(
        pending.some(
          (row) =>
            row.request.type === "provider-session.detach" &&
            row.request.providerSessionId === fixture.providerSessionId,
        ),
      );
      yield* fixture.app.v2.worker.drain();
      assert.deepEqual(fixture.effects, [
        `provider.unload:${fixture.threadId}`,
        `terminal.close:${fixture.threadId}`,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "settles native idle sessions with durable detach and leaves terminal cleanup to the reactor",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeArchiveFixture("settle");
        const commandId = CommandId.make("native-settle");
        yield* fixture.dispatch("thread.settle", commandId);
        const projection = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        assert.equal(projection.thread.settledOverride, "settled");
        assert.isNotNull(projection.thread.settledAt);
        assert.isNull(projection.thread.archivedAt);
        assert.deepEqual(fixture.effects, []);
        const pending = yield* fixture.app.v2.outbox.listByCommandId(commandId);
        assert.deepEqual(
          pending.map((row) => row.request.type),
          ["provider-session.detach"],
        );
        assert.equal(yield* fixture.app.v2.worker.drain(), 1);
        assert.deepEqual(fixture.effects, [`provider.unload:${fixture.threadId}`]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("preserves the friendly blocked-settlement rejection and native history", () =>
    Effect.gen(function* () {
      const fixture = yield* makeNativeArchiveFixture(
        "settle-blocked",
        "ready",
        undefined,
        transferV2ThreadId,
      );
      const events = transferV2TurnEvents(ProviderDriverKind.make("codex"), 0, false);
      yield* fixture.app.v2.eventSink.write({ events });
      const projection = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
      const activeRun = projection.runs[0];
      assertTrue(activeRun !== undefined);
      yield* fixture.app.v2.eventSink.write({
        events: [
          {
            id: EventId.make("native-blocked-settle-run"),
            type: "run.updated",
            threadId: fixture.threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...activeRun, status: "running", completedAt: null },
          },
        ],
      });
      const before = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
      const sequence = yield* fixture.app.v2.eventSink.latestSequence();
      const commandId = CommandId.make("native-settle-blocked");
      const error = yield* fixture.dispatch("thread.settle", commandId).pipe(Effect.flip);
      assert.equal(error._tag, "OrchestrationV2DispatchCommandError");
      assert.equal(
        error.message,
        "This thread still needs attention. Resolve or interrupt it first, then try again.",
      );
      assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), sequence);
      assert.deepEqual(yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId), before);
      assert.deepEqual(yield* fixture.app.v2.outbox.listByCommandId(commandId), []);
      assert.deepEqual(fixture.effects, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // Native launches are accepted before asynchronous workspace preparation.
  // Failures keep the authored message and failed run; an explicitly requested
  // worktree never silently falls back to the project checkout.
  const makeNativeLaunchFixture = Effect.fn("makeNativeLaunchFixture")(function* (
    name: string,
    options: NonNullable<Parameters<typeof buildAppUnderTest>[0]> = {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `scient-launch-${name}-` });
    const worktreePath = path.join(root, "worktree");
    yield* fs.makeDirectory(worktreePath);
    const projectId = ProjectId.make(`project-launch-${name}`);
    const threadId = ThreadId.make(`thread-launch-${name}`);
    const createWorktree = vi.fn<GitManager.GitManager["Service"]["createWorktree"]>(
      (_input, progress) =>
        (progress?.progress?.onWorktreeClaimed?.(worktreePath) ?? Effect.void).pipe(
          Effect.as({ worktree: { path: worktreePath, refName: "feature/manual" } }),
        ),
    );
    const app = yield* buildAppUnderTest({
      ...options,
      layers: {
        ...options.layers,
        providerInstanceRegistry: {
          getInstance: () => Effect.succeed(nativeAdmissionInstance),
          ...options.layers?.providerInstanceRegistry,
        },
        vcsDriver: { isInsideWorkTree: () => Effect.succeed(true), ...options.layers?.vcsDriver },
        gitVcsDriver: {
          execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
          remoteExists: () => Effect.succeed(false),
          removeWorktree: () => Effect.void,
          ...options.layers?.gitVcsDriver,
        },
        gitManager: {
          createWorktree,
          ...options.layers?.gitManager,
        },
      },
    });
    yield* app.v2.projects.create({
      commandId: CommandId.make(`project-launch-${name}`),
      projectId,
      title: "Native launch",
      workspaceRoot: root,
    });
    const input = {
      commandId: CommandId.make(`launch-${name}`),
      threadId,
      projectId,
      title: "Native first send",
      modelSelection: defaultModelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      workspaceStrategy: { type: "worktree" as const, branch: "feature/manual", baseRef: "main" },
      initialMessage: {
        messageId: MessageId.make(`launch-message-${name}`),
        text: "hello",
        attachments: [],
      },
    };
    const wsUrl = yield* getWsServerUrl("/ws");
    const launch = (requested: OrchestrationV2ThreadLaunchInput = input) =>
      Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_V2_WS_METHODS.launchThread](requested),
        ),
      );
    const awaitRun = (status: "starting" | "failed") =>
      app.v2.events.streamApplicationEvents({ afterSequence: 0 }).pipe(
        Stream.filter(
          (stored) =>
            "event" in stored &&
            stored.event.threadId === threadId &&
            stored.event.type === "run.updated" &&
            stored.event.payload.status === status,
        ),
        Stream.runHead,
        Effect.flatMap(() => app.v2.threads.getThreadProjection(threadId)),
      );
    const snapshotWhere = (predicate: (snapshot: WorktreeSetupSnapshot) => boolean) =>
      Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeWorktreeSetup]({ threadId }).pipe(
            Stream.filter(
              (snapshot): snapshot is WorktreeSetupSnapshot =>
                snapshot !== null && predicate(snapshot),
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        ),
      );
    return {
      app,
      input,
      launch,
      awaitRun,
      snapshotWhere,
      threadId,
      projectId,
      root,
      worktreePath,
      createWorktree,
      wsUrl,
    };
  });

  it.effect("bootstraps a native first-send worktree before releasing its durable run", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const fetchedCommit = "0123456789abcdef0123456789abcdef01234567";
      const runForThread = vi.fn<
        ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
      >((input) =>
        Effect.sync(() => {
          operations.push("setup");
          assert.isDefined(input.observeCompletion);
          return { status: "no-script" as const };
        }),
      );
      const createWorktree = vi.fn<GitManager.GitManager["Service"]["createWorktree"]>((input) =>
        Effect.sync(() => {
          operations.push("checkout");
          assert.equal(input.refName, fetchedCommit);
          return { worktree: { path: input.cwd, refName: input.newRefName! } };
        }),
      );
      const fixture = yield* makeNativeLaunchFixture("remote-first", {
        layers: {
          gitVcsDriver: {
            remoteExists: () =>
              Effect.sync(() => {
                operations.push("remote-exists");
                return true;
              }),
            fetchRemote: () =>
              Effect.sync(() => {
                operations.push("fetch");
              }),
            remoteBranchExists: () =>
              Effect.sync(() => {
                operations.push("remote-branch-exists");
                return true;
              }),
            resolveRemoteTrackingCommit: () =>
              Effect.sync(() => {
                operations.push("resolve-remote-commit");
                return { commitSha: fetchedCommit, remoteRefName: "origin/main" };
              }),
          },
          gitManager: { createWorktree },
          projectSetupScriptRunner: { runForThread },
        },
      });
      const launched = yield* fixture.launch({
        ...fixture.input,
        workspaceStrategy: { ...fixture.input.workspaceStrategy, startFromOrigin: true },
      });
      assert.equal(launched.threadId, fixture.threadId);
      assert.isTrue(launched.projection.runs.some((run) => run.status === "preparing"));
      const ready = yield* fixture.awaitRun("starting");
      assert.deepEqual(operations, [
        "remote-exists",
        "fetch",
        "remote-branch-exists",
        "resolve-remote-commit",
        "checkout",
        "setup",
      ]);
      assert.equal(ready.thread.branch, "feature/manual");
      assert.equal(ready.thread.worktreePath, fixture.root);
      assert.deepEqual(
        ready.messages.map((message) => message.id),
        [fixture.input.initialMessage.messageId],
      );
      assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
        cwd: fixture.root,
        refName: fetchedCommit,
        newRefName: "feature/manual",
        baseRefName: "main",
        path: null,
      });
      assert.equal(runForThread.mock.calls[0]?.[0].worktreePath, fixture.root);
      const done = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "done");
      assert.isTrue(
        done.stages.every((stage) => stage.status === "done" || stage.status === "skipped"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    { caseName: "the origin remote is missing", hasOrigin: false },
    { caseName: "the base branch exists only locally", hasOrigin: true },
  ])("native launch uses the local base when $caseName", ({ hasOrigin }) =>
    Effect.gen(function* () {
      const remoteExists = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>(() =>
        Effect.succeed(hasOrigin),
      );
      const fetchRemote = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>(
        () => Effect.void,
      );
      const remoteBranchExists = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"]>(
        () => Effect.succeed(false),
      );
      const resolveRemoteTrackingCommit = vi.fn<
        GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]
      >(() => Effect.die("Absent remote base must not resolve"));
      const fixture = yield* makeNativeLaunchFixture(`local-${hasOrigin}`, {
        layers: {
          gitVcsDriver: {
            remoteExists,
            fetchRemote,
            remoteBranchExists,
            resolveRemoteTrackingCommit,
          },
        },
      });
      yield* fixture.launch({
        ...fixture.input,
        workspaceStrategy: { ...fixture.input.workspaceStrategy, startFromOrigin: true },
      });
      yield* fixture.awaitRun("starting");
      assert.equal(fetchRemote.mock.calls.length, hasOrigin ? 1 : 0);
      assert.equal(remoteBranchExists.mock.calls.length, hasOrigin ? 1 : 0);
      assert.equal(resolveRemoteTrackingCommit.mock.calls.length, 0);
      assert.deepEqual(fixture.createWorktree.mock.calls[0]?.[0], {
        cwd: fixture.root,
        refName: "main",
        newRefName: "feature/manual",
        baseRefName: "main",
        path: null,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    "non-repository",
    "base-without-commit",
    "fetch-failure",
    "checkout-defect",
  ] as const)("native required worktree preserves a failed first send for %s", (failure) =>
    Effect.gen(function* () {
      const createWorktree = vi.fn<GitManager.GitManager["Service"]["createWorktree"]>(() =>
        failure === "checkout-defect"
          ? Effect.die(new Error("checkout exploded"))
          : Effect.fail(
              new GitCommandError({
                operation: "create-worktree",
                command: "git worktree add",
                cwd: "/synthetic",
                detail:
                  failure === "non-repository" ? "not a git repository" : "base has no commit",
              }),
            ),
      );
      const runForThread = vi.fn<
        ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
      >(() => Effect.die("Failed checkout must not run setup"));
      const fixture = yield* makeNativeLaunchFixture(failure, {
        layers: {
          vcsDriver: { isInsideWorkTree: () => Effect.succeed(failure !== "non-repository") },
          gitVcsDriver: {
            remoteExists: () => Effect.succeed(failure === "fetch-failure"),
            fetchRemote: () =>
              Effect.fail(
                new GitCommandError({
                  operation: "fetch",
                  command: "git fetch",
                  cwd: "/synthetic",
                  detail: "fetch failed",
                }),
              ),
          },
          gitManager: { createWorktree },
          projectSetupScriptRunner: { runForThread },
        },
      });
      const launched = yield* fixture.launch({
        ...fixture.input,
        workspaceStrategy: {
          ...fixture.input.workspaceStrategy,
          startFromOrigin: failure === "fetch-failure",
        },
      });
      const failed = yield* fixture.awaitRun("failed");
      assert.equal(launched.threadId, fixture.threadId);
      assert.deepEqual(
        failed.messages.map((message) => message.id),
        [fixture.input.initialMessage.messageId],
      );
      assert.equal(failed.runs.length, 1);
      assert.equal(failed.runs[0]?.status, "failed");
      assert.isNull(failed.thread.deletedAt);
      assert.isTrue(failed.runs.every((run) => run.status === "failed"));
      assert.isNull(failed.thread.worktreePath);
      assert.equal(runForThread.mock.calls.length, 0);
      assert.equal(createWorktree.mock.calls.length, failure === "fetch-failure" ? 0 : 1);
      const snapshot = yield* fixture.snapshotWhere((current) => current.phase === "failed");
      assert.isString(snapshot.error);
      // Retrying an accepted command reuses its durable message/run, not a second launch.
      const retried = yield* fixture.launch();
      assert.equal(retried.threadId, fixture.threadId);
      assert.equal(
        (yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId)).messages.length,
        1,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("native launch rejects a missing project before creating a thread", () =>
    Effect.gen(function* () {
      const fixture = yield* makeNativeLaunchFixture("missing-project");
      const result = yield* fixture
        .launch({ ...fixture.input, projectId: ProjectId.make("absent-launch-project") })
        .pipe(Effect.result);
      assertTrue(result._tag === "Failure");
      assert.equal(result.failure._tag, "OrchestrationV2ThreadLaunchError");
      assert.isNull(yield* fixture.app.v2.threads.getThreadShell(fixture.threadId));
      assert.equal(fixture.createWorktree.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(["start-failure", "nonzero-exit"] as const)(
    "native synchronous setup %s retains failed run without provider release",
    (failure) =>
      Effect.gen(function* () {
        const fixture = yield* makeNativeLaunchFixture(`setup-${failure}`, {
          layers: {
            projectSetupScriptRunner: {
              runForThread: (input) =>
                failure === "start-failure"
                  ? Effect.fail(
                      new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                        threadId: input.threadId,
                        projectId: input.projectId,
                        projectCwd: input.projectCwd,
                        worktreePath: input.worktreePath,
                        operation: "openTerminal",
                        cause: new Error("setup launch failed"),
                      }),
                    )
                  : Effect.succeed({
                      status: "started",
                      scriptId: "setup",
                      scriptName: "Setup",
                      scriptCommand: "npm install",
                      terminalId: "setup-terminal",
                      cwd: input.worktreePath,
                      async: false,
                      completion: Effect.succeed({ exitCode: 1, durationMs: 1 }),
                    }),
            },
          },
        });
        yield* fixture.launch();
        const failed = yield* fixture.awaitRun("failed");
        assert.equal(failed.runs[0]?.status, "failed");
        assert.equal(failed.messages.length, 1);
        assert.isTrue(failed.runs.every((run) => run.status === "failed"));
        assert.equal(failed.thread.worktreePath, fixture.worktreePath);
        const events = yield* fixture.app.v2.events
          .readAgentEvents({ threadId: fixture.threadId })
          .pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "starting",
          ),
        );
        const snapshot = yield* fixture.snapshotWhere((current) => current.phase === "failed");
        assert.isTrue(
          snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "pending"),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("native successful setup does not hide a durable run release failure", () =>
    Effect.gen(function* () {
      const fixture = yield* makeNativeLaunchFixture("release-persistence-failure", {
        layers: {
          projectSetupScriptRunner: {
            runForThread: (input) =>
              Effect.succeed({
                status: "started" as const,
                scriptId: "setup",
                scriptName: "Setup",
                scriptCommand: "npm install",
                terminalId: "setup-terminal",
                cwd: input.worktreePath,
                async: false,
                completion: Effect.succeed({ exitCode: 0, durationMs: 1 }),
              }),
          },
        },
      });
      // Fail the actual event-log insert for release, after setup succeeds.
      // Failed-run persistence still works, so the test proves transaction and
      // error attribution using the same SQL store as the production services.
      yield* fixture.app.v2.sql`
        CREATE TRIGGER reject_native_launch_release
        BEFORE INSERT ON orchestration_events
        WHEN NEW.event_type = 'run.updated' AND json_extract(NEW.payload_json, '$.status') = 'starting'
        BEGIN SELECT RAISE(FAIL, 'controlled native release persistence failure'); END
      `;
      yield* fixture.launch();
      const failed = yield* fixture.awaitRun("failed");
      assert.equal(failed.messages.length, 1);
      assert.equal(failed.runs[0]?.status, "failed");
      assert.equal(failed.thread.worktreePath, fixture.worktreePath);
      const setup = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "failed");
      assert.equal(setup.stages.find((stage) => stage.id === "setup-script")?.status, "done");
      assert.isFalse(setup.stages.some((stage) => stage.id === "agent" && stage.status === "done"));
      const events = yield* fixture.app.v2.events
        .readAgentEvents({ threadId: fixture.threadId })
        .pipe(Stream.runCollect);
      assert.isFalse(
        events.some(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting",
        ),
      );
      assert.deepEqual(
        yield* fixture.app.v2.outbox.listByCommandId(
          CommandId.make(`${fixture.input.commandId}:release`),
        ),
        [],
      );
      yield* fixture.app.v2.sql`DROP TRIGGER reject_native_launch_release`;
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    { name: "async-success", async: true, exitCode: 0, cancel: false },
    { name: "async-failure", async: true, exitCode: 1, cancel: false },
    { name: "sync-disconnect", async: false, exitCode: 0, cancel: false },
    { name: "sync-cancel", async: false, exitCode: 0, cancel: true },
  ])("native setup lifecycle: $name", ({ name, async, exitCode, cancel }) =>
    Effect.gen(function* () {
      const scriptExit = yield* Deferred.make<void>();
      const setupEntered = yield* Deferred.make<void>();
      const cleanup: string[] = [];
      const fixture = yield* makeNativeLaunchFixture(name, {
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                cleanup.push(`terminal:${input.terminalId}`);
              }),
          },
          gitVcsDriver: {
            removeWorktree: (input) =>
              Effect.sync(() => {
                cleanup.push(`worktree:${input.path}`);
              }),
          },
          projectSetupScriptRunner: {
            runForThread: (input) =>
              Deferred.succeed(setupEntered, undefined).pipe(
                Effect.as({
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "npm install",
                  terminalId: "setup-terminal",
                  cwd: input.worktreePath,
                  async,
                  completion: Deferred.await(scriptExit).pipe(
                    Effect.as({ exitCode, durationMs: 1 }),
                  ),
                }),
              ),
          },
        },
      });
      const accepted = yield* fixture.launch();
      assert.equal(accepted.threadId, fixture.threadId);
      yield* Deferred.await(setupEntered);
      const running = yield* fixture.snapshotWhere(
        (snapshot) =>
          snapshot.phase === "running" &&
          snapshot.stages.some(
            (stage) => stage.id === "setup-script" && stage.status === "running",
          ),
      );
      assert.equal(running.worktreePath, fixture.worktreePath);
      if (async) {
        yield* fixture.awaitRun("starting");
        const released = yield* fixture.snapshotWhere((snapshot) =>
          snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done"),
        );
        assert.equal(released.phase, "running");
      } else {
        const pending = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
        assert.equal(pending.runs[0]?.status, "preparing");
        assert.isTrue(
          running.stages.some((stage) => stage.id === "agent" && stage.status === "pending"),
        );
      }
      if (cancel) {
        const cancelled = yield* Effect.scoped(
          withWsRpcClient(fixture.wsUrl, (client) =>
            client[WS_METHODS.worktreeSetupCancel]({ threadId: fixture.threadId }),
          ),
        );
        assert.isTrue(cancelled.cancelled);
        const failed = yield* fixture.awaitRun("failed");
        const outcome = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "cancelled");
        assert.equal(outcome.phase, "cancelled");
        assert.equal(failed.messages.length, 1);
        assert.isNull(failed.thread.worktreePath);
        assert.isNull(failed.thread.deletedAt);
        assert.deepEqual(cleanup, ["terminal:setup-terminal", `worktree:${fixture.worktreePath}`]);
        return;
      }
      // The launch socket has already closed while setup owns its server scope.
      yield* Deferred.succeed(scriptExit, undefined);
      yield* fixture.awaitRun("starting");
      const done = yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "done");
      assert.equal(
        done.stages.find((stage) => stage.id === "setup-script")?.status,
        exitCode === 0 ? "done" : "failed",
      );
      assert.deepEqual(cleanup, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects native identity reuse and isolates a replacement from the old launch", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const scriptExit = yield* Deferred.make<void>();
      const fixture = yield* makeNativeLaunchFixture("recreated-during-setup", {
        layers: {
          projectSetupScriptRunner: {
            runForThread: (input) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.as({
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "npm install",
                  terminalId: "setup-terminal",
                  cwd: input.worktreePath,
                  async: false,
                  completion: Deferred.await(scriptExit).pipe(
                    Effect.as({ exitCode: 0, durationMs: 1 }),
                  ),
                }),
              ),
          },
        },
      });
      yield* fixture.launch();
      yield* Deferred.await(entered);
      yield* fixture.snapshotWhere((snapshot) => snapshot.setupScript !== null);
      const replacementId = ThreadId.make("fresh-native-replacement");
      const create = {
        type: "thread.create" as const,
        commandId: CommandId.make("create-fresh-replacement"),
        threadId: replacementId,
        projectId: fixture.projectId,
        title: "Replacement conversation",
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      const active = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
      yield* Effect.scoped(
        withWsRpcClient(fixture.wsUrl, (client) =>
          Effect.gen(function* () {
            const activeReuse = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              ...create,
              commandId: CommandId.make("reuse-active-identity"),
              threadId: fixture.threadId,
            }).pipe(Effect.flip);
            assert.equal(activeReuse._tag, "OrchestrationV2DispatchCommandError");
            assert.equal(
              activeReuse.message,
              "This conversation already exists. Start a new conversation instead.",
            );
            assert.deepEqual(
              yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
              active,
            );
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.delete",
              commandId: CommandId.make("delete-preparing-incarnation"),
              threadId: fixture.threadId,
            });
            const deleted = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
            const deletedSequence = yield* fixture.app.v2.eventSink.latestSequence();
            assert.isNotNull(deleted.thread.deletedAt);
            const deletedReuse = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              ...create,
              commandId: CommandId.make("reuse-deleted-identity"),
              threadId: fixture.threadId,
            }).pipe(Effect.flip);
            assert.equal(deletedReuse._tag, "OrchestrationV2DispatchCommandError");
            assert.equal(deletedReuse.message, activeReuse.message);
            assert.deepEqual(
              yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
              deleted,
            );
            assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), deletedSequence);
            const created = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](create);
            const repeated = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](create);
            assert.equal(repeated.sequence, created.sequence);
            assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), created.sequence);
          }),
        ),
      );
      const tombstone = yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId);
      const replacement = yield* fixture.app.v2.threads.getThreadProjection(replacementId);
      assert.equal(replacement.thread.title, "Replacement conversation");
      assert.isNull(replacement.thread.deletedAt);
      assert.deepEqual(replacement.messages, []);
      assert.deepEqual(replacement.runs, []);
      const sequence = yield* fixture.app.v2.eventSink.latestSequence();
      yield* Deferred.succeed(scriptExit, undefined);
      yield* fixture.snapshotWhere((snapshot) => snapshot.phase === "failed");
      assert.deepEqual(
        yield* fixture.app.v2.threads.getThreadProjection(replacementId),
        replacement,
      );
      assert.deepEqual(
        yield* fixture.app.v2.threads.getThreadProjection(fixture.threadId),
        tombstone,
      );
      assert.equal(yield* fixture.app.v2.eventSink.latestSequence(), sequence);
      assert.deepEqual(
        yield* fixture.app.v2.outbox.listByCommandId(
          CommandId.make(`${fixture.input.commandId}:release`),
        ),
        [],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "native cancellation cleanup failure retains owned workspace and accepted history",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const scriptExit = yield* Deferred.make<void>();
        const fixture = yield* makeNativeLaunchFixture("cleanup-failed", {
          layers: {
            gitVcsDriver: {
              removeWorktree: () =>
                Effect.fail(
                  new GitCommandError({
                    operation: "remove",
                    command: "git worktree remove",
                    cwd: "/synthetic",
                    detail: "cleanup failed",
                  }),
                ),
            },
            terminalManager: { close: () => Effect.void },
            projectSetupScriptRunner: {
              runForThread: (input) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.as({
                    status: "started" as const,
                    scriptId: "setup",
                    scriptName: "Setup",
                    scriptCommand: "npm install",
                    terminalId: "setup-terminal",
                    cwd: input.worktreePath,
                    async: false,
                    completion: Deferred.await(scriptExit).pipe(
                      Effect.as({ exitCode: 0, durationMs: 1 }),
                    ),
                  }),
                ),
            },
          },
        });
        yield* fixture.launch();
        yield* Deferred.await(entered);
        yield* fixture.snapshotWhere((snapshot) => snapshot.setupScript !== null);
        yield* Effect.scoped(
          withWsRpcClient(fixture.wsUrl, (client) =>
            client[WS_METHODS.worktreeSetupCancel]({ threadId: fixture.threadId }),
          ),
        );
        const failed = yield* fixture.awaitRun("failed");
        assert.isNull(failed.thread.deletedAt);
        assert.equal(failed.thread.worktreePath, fixture.worktreePath);
        assert.equal(failed.thread.branch, "feature/manual");
        assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(fixture.worktreePath));
        const cancelled = yield* fixture.snapshotWhere(
          (snapshot) => snapshot.phase === "cancelled" && snapshot.error !== null,
        );
        assert.include(cancelled.error ?? "", "cleanup failed");
        assert.equal(failed.messages.length, 1);
        assert.equal(failed.runs[0]?.status, "failed");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Primary",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

it.live(
  "reports thread HTTP and WebSocket transfer budgets",
  () =>
    Effect.gen(function* () {
      const providers = [
        ProviderDriverKind.make("codex"),
        ProviderDriverKind.make("claudeAgent"),
      ] as const;

      const runs = yield* Effect.forEach(
        providers,
        (provider) => {
          // Runtime writes and HTTP/WS subscription reads share one traced database.
          const sqlCounter = makeSqlStatementCounter();
          return Effect.scoped(
            Effect.gen(function* () {
              const app = yield* buildAppUnderTest();
              yield* seedTransferBudgetHistory(app.v2.eventSink, provider);

              const baseUrl = yield* getHttpServerUrl();
              const cookie = yield* getAuthenticatedSessionCookieHeader();
              const wsUrl =
                baseUrl.replace(/^http:/, "ws:") +
                `/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`;

              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const threadSnapshot = yield* measureHttpGet({
                    url: `${baseUrl}/api/orchestration/threads/${TRANSFER_THREAD_ID}/bounded`,
                    headers: {
                      cookie,
                      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                      [THREAD_SNAPSHOT_FORMAT_HEADER]: COMPACT_THREAD_SNAPSHOT_FORMAT,
                    },
                  });
                  yield* Effect.logInfo(
                    "Synthetic bounded transfer attribution",
                    provider,
                    encodeTestJson(attributeSnapshotTransfer(threadSnapshot)),
                  );
                  assert.equal(threadSnapshot.status, 200);
                  assert.equal(threadSnapshot.contentEncoding, "gzip");
                  const decodedThread = yield* decodeTransferThreadSnapshot(
                    Buffer.from(threadSnapshot.decodedBody).toString("utf8"),
                  );
                  assert.equal(
                    decodedThread.projection.messages.length,
                    THREAD_HISTORY_PAGE_POLICY.maxUserTurns * 2,
                  );
                  assert.equal(
                    decodedThread.hasMoreHistory,
                    TRANSFER_HISTORY_TURN_COUNT > THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
                  );
                  let historyCursor = decodedThread.historyCursor;
                  const historyItems = [...decodedThread.projection.visibleTurnItems];
                  const seenCursors = new Set<string>();
                  // Startup matches the shared bounded HTTP loader. Older pages are
                  // explicitly requested and must reconstruct the complete persisted history.
                  while (historyCursor !== null) {
                    assert.isFalse(seenCursors.has(historyCursor), "history cursor must advance");
                    seenCursors.add(historyCursor);
                    const response = yield* measureHttpGet({
                      url: `${baseUrl}/api/orchestration/threads/${TRANSFER_THREAD_ID}/history?cursor=${encodeURIComponent(historyCursor)}`,
                      headers: {
                        cookie,
                        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                      },
                    });
                    assert.equal(response.status, 200);
                    const page = yield* decodeTransferHistoryPage(
                      Buffer.from(response.decodedBody).toString("utf8"),
                    );
                    assert.equal(page.snapshotSequence, decodedThread.snapshotSequence);
                    assert.isAbove(page.items.length, 0);
                    historyItems.unshift(...page.items);
                    assert.equal(page.hasMoreHistory, page.nextCursor !== null);
                    historyCursor = page.nextCursor;
                  }
                  assert.equal(
                    historyItems.filter((row) => row.item.type === "user_message").length,
                    TRANSFER_HISTORY_TURN_COUNT,
                  );
                  assert.equal(
                    historyItems.filter((row) => row.item.type === "assistant_message").length,
                    TRANSFER_HISTORY_TURN_COUNT,
                  );
                  assert.equal(
                    historyItems.filter((row) => row.item.type === "dynamic_tool").length,
                    TRANSFER_HISTORY_TURN_COUNT,
                  );
                  assert.equal(
                    new Set(historyItems.map((row) => row.sourceItemId)).size,
                    historyItems.length,
                  );
                  const persistedHistory =
                    yield* app.v2.threads.getThreadProjection(TRANSFER_THREAD_ID);
                  assert.deepEqual(
                    historyItems.map((row) => row.sourceItemId),
                    persistedHistory.visibleTurnItems.map((row) => row.sourceItemId),
                  );
                  const shellSnapshot = yield* measureHttpGet({
                    url: `${baseUrl}/api/orchestration/shell`,
                    headers: {
                      cookie,
                      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                    },
                  });
                  assert.equal(shellSnapshot.status, 200);
                  const decodedShell = yield* decodeTransferShellSnapshot(
                    Buffer.from(shellSnapshot.decodedBody).toString("utf8"),
                  );
                  assert.equal(decodedShell.threads.length, 1);

                  // Three sockets, the way real installs look: the capped
                  // thread-only client, a shell-only socket that isolates the
                  // sidebar cost, and a second device holding both.
                  const threadClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                  const shellClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                  const secondClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                  assert.include(
                    threadClient.recorder.negotiatedExtensions(),
                    "permessage-deflate",
                  );

                  const threadItems = yield* subscribeThreadItems(
                    threadClient,
                    decodedThread.snapshotSequence,
                  );
                  const shellItems = yield* subscribeShellItems(
                    shellClient,
                    decodedShell.snapshotSequence,
                  );
                  const secondThreadItems = yield* subscribeThreadItems(
                    secondClient,
                    decodedThread.snapshotSequence,
                  );
                  const secondShellItems = yield* subscribeShellItems(
                    secondClient,
                    decodedShell.snapshotSequence,
                  );
                  assert.equal(
                    yield* awaitSubscriptionSynchronized(
                      threadItems,
                      `${provider} thread subscription to synchronize`,
                    ),
                    "replay",
                  );
                  assert.equal(
                    yield* awaitSubscriptionSynchronized(
                      shellItems,
                      `${provider} shell subscription to synchronize`,
                    ),
                    "replay",
                  );
                  assert.equal(
                    yield* awaitSubscriptionSynchronized(
                      secondThreadItems,
                      `${provider} second client thread subscription to synchronize`,
                    ),
                    "replay",
                  );
                  assert.equal(
                    yield* awaitSubscriptionSynchronized(
                      secondShellItems,
                      `${provider} second client shell subscription to synchronize`,
                    ),
                    "replay",
                  );

                  const turnStartTotals = threadClient.recorder.totals();
                  const shellTurnStartTotals = shellClient.recorder.totals();
                  const secondTurnStartTotals = secondClient.recorder.totals();
                  const turnStartSqlStatements = sqlCounter.count();
                  const committed = yield* commitMeasuredTransferTurn(app.v2.eventSink, provider);
                  const finalThreadSequence = committed.at(-1)!.sequence;
                  const finalSequences = {
                    detail: finalThreadSequence,
                    aggregate: finalThreadSequence,
                  };
                  assert.isAbove(finalThreadSequence, decodedThread.snapshotSequence);

                  const reachedFinalThreadEvent = (item: OrchestrationV2ThreadStreamItem) =>
                    item.kind === "event" && item.sequence === finalThreadSequence;
                  // Shell items carry the sequence of the latest coalesced
                  // event for the thread, so the last one lands at or past
                  // the final thread event.
                  const reachedFinalShellEvent = (item: OrchestrationV2ShellStreamItem) =>
                    item.kind === "thread.updated" && item.sequence >= finalSequences.aggregate;
                  yield* collectQueueUntil(
                    threadItems,
                    reachedFinalThreadEvent,
                    `${provider} thread stream to reach sequence ${finalThreadSequence}`,
                  );
                  yield* collectQueueUntil(
                    secondThreadItems,
                    reachedFinalThreadEvent,
                    `${provider} second client thread stream to reach sequence ${finalThreadSequence}`,
                  );
                  yield* collectQueueUntil(
                    shellItems,
                    reachedFinalShellEvent,
                    `${provider} shell stream to reach sequence ${finalSequences.aggregate}`,
                  );
                  yield* collectQueueUntil(
                    secondShellItems,
                    reachedFinalShellEvent,
                    `${provider} second client shell stream to reach sequence ${finalSequences.aggregate}`,
                  );
                  const measuredTurnWebSocket = transferDelta(
                    turnStartTotals,
                    threadClient.recorder.totals(),
                  );
                  const measuredTurnShellWebSocket = transferDelta(
                    shellTurnStartTotals,
                    shellClient.recorder.totals(),
                  );
                  const measuredTurnSecondClientWebSocket = transferDelta(
                    secondTurnStartTotals,
                    secondClient.recorder.totals(),
                  );
                  const measuredTurnSqlStatements = sqlCounter.count() - turnStartSqlStatements;

                  // The second device drops and comes back with the cursors it
                  // held before the turn, one subscription at a time so the
                  // catch-up bytes stay separable.
                  yield* secondClient.close;
                  const reconnectSqlStart = sqlCounter.count();
                  const reconnected = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                  const reconnectStartTotals = reconnected.recorder.totals();
                  const reconnectThreadItems = yield* subscribeThreadItems(
                    reconnected,
                    decodedThread.snapshotSequence,
                  );
                  const reconnectThreadMode = yield* awaitSubscriptionSynchronized(
                    reconnectThreadItems,
                    `${provider} reconnected thread subscription to synchronize`,
                  );
                  const reconnectThreadTotals = reconnected.recorder.totals();
                  const reconnectShellItems = yield* subscribeShellItems(
                    reconnected,
                    decodedShell.snapshotSequence,
                  );
                  const reconnectShellMode = yield* awaitSubscriptionSynchronized(
                    reconnectShellItems,
                    `${provider} reconnected shell subscription to synchronize`,
                  );
                  const reconnectShellTotals = reconnected.recorder.totals();
                  const reconnectSqlStatements = sqlCounter.count() - reconnectSqlStart;

                  const finalThreadSnapshot =
                    yield* app.v2.threads.getThreadProjection(TRANSFER_THREAD_ID);
                  const expectedAssistantText = expectedMeasuredAssistantText(provider);
                  const measuredAssistant = finalThreadSnapshot.messages.find(
                    (message) =>
                      message.role === "assistant" && message.text === expectedAssistantText,
                  );
                  assert.isDefined(measuredAssistant);
                  assert.equal(
                    finalThreadSnapshot.messages.length,
                    (TRANSFER_HISTORY_TURN_COUNT + 1) * 2,
                  );
                  assert.equal(measuredAssistant?.streaming, false);
                  assert.equal(finalThreadSnapshot.runs.length, TRANSFER_HISTORY_TURN_COUNT + 1);
                  assert.isTrue(
                    finalThreadSnapshot.runs.every((run) => run.status === "completed"),
                  );
                  assert.equal(
                    finalThreadSnapshot.turnItems.filter((item) => item.type === "dynamic_tool")
                      .length,
                    TRANSFER_HISTORY_TURN_COUNT + 1,
                  );

                  return {
                    provider,
                    startupTransport: "bounded-compact-http-with-live-cursor",
                    threadSnapshot,
                    measuredTurnWebSocket,
                    shellSnapshot,
                    measuredTurnShellWebSocket,
                    measuredTurnSecondClientWebSocket,
                    reconnectThread: {
                      mode: reconnectThreadMode,
                      ...transferDelta(reconnectStartTotals, reconnectThreadTotals),
                    },
                    reconnectShell: {
                      mode: reconnectShellMode,
                      ...transferDelta(reconnectThreadTotals, reconnectShellTotals),
                    },
                    measuredTurnSqlStatements,
                    reconnectSqlStatements,
                  } satisfies TransferBudgetRun;
                }),
              );
            }),
          ).pipe(
            Effect.provideService(Tracer.Tracer, sqlCounter.tracer),
            Effect.provide(NodeHttpServerTestWithWsDeflate),
          );
        },
        { concurrency: 1 },
      );

      const report = formatTransferBudgetReport(runs);
      yield* Effect.logInfo(`\n${report}`);
      const reportPath = yield* Config.String("T3CODE_BOUNDED_TRANSFER_BUDGET_REPORT_PATH").pipe(
        Config.option,
      );
      if (Option.isSome(reportPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(reportPath.value, report);
      }
      const resultPath = yield* Config.String("T3CODE_BOUNDED_TRANSFER_BUDGET_RESULT_PATH").pipe(
        Config.option,
      );
      if (Option.isSome(resultPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(resultPath.value, formatTransferBudgetResult(runs));
      }
      assert.deepEqual(transferBudgetViolations(runs), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
