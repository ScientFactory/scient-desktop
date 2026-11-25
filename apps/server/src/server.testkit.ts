// @effect-diagnostics nodeBuiltinImport:off
/** The composed server router, its fixtures and clients, shared by the server.*.test.ts files. */
import * as DocumentText from "./provider/DocumentText.ts";
import * as AccountsTestkit from "./scient/accounts/Accounts.testkit.ts";
import {
  ScientSourcesBackend,
  type ScientSourcesBackendKind,
} from "./scient/sources/SourcesBackend.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import {
  type DeviceServiceState,
  AuthAccessTokenType,
  AuthStandardClientScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  type OrchestrationV2ThreadLaunchInput,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ShellStreamItem,
  DEFAULT_SERVER_SETTINGS,
  DroidSettings,
  type DpopFailureReason,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellHttpSnapshot,
  OrchestrationV2ShellResumable,
  type OrchestrationV2SubscribeShellInput,
  type OrchestrationV2SubscribeThreadInput,
  type EnvironmentOrchestrationShellSnapshotQuery,
  type EnvironmentOrchestrationThreadBoundedSnapshotQuery,
  type EnvironmentOrchestrationThreadHistoryQuery,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ThreadHistoryPage,
  ScientThreadQueueOperationError,
  ScientThreadQueueSnapshot,
  type PreviewEvent,
  ProjectId,
  type ProviderAuthState,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderInstallState,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { RELAY_HEALTH_REQUEST_TYP, RELAY_MINT_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
import {
  filePublicationTestHelper,
  nativePublicationHost,
} from "./scient/workspace/fileExchange.testkit.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ServerConfig from "./config.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { HTTP_ROUTER_CONFIG, layerMakeRoutes } from "./server.ts";
import { ScientExtensionsLayerLive } from "./scient/extensions/ExtensionsLayers.ts";
import * as ThreadMcpStatusRegistry from "./mcpApps/ThreadMcpStatusRegistry.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as MilestoneHub from "./milestones/MilestoneHub.ts";
import * as WorkflowForge from "./workflows/WorkflowForge.ts";
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
import * as ThreadSearchV2 from "./orchestration-v2/ThreadSearch.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
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
  THREAD_ID as transferV2ThreadId,
} from "../integration/TransferBudgetV2Fixture.integration.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { layer as orchestrationEventStoreLayer } from "./persistence/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "./persistence/OrchestrationEventStore.ts";
import { type ProviderVoiceTranscriptCorrection } from "./provider/ScientProviderInstanceSeams.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeNativeSessionAdapterV2 } from "./orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ModelManifest from "./provider/ModelManifest.ts";
import { ProviderAuthService } from "./provider/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import { AntigravityInstallation } from "./provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as ProviderInstallationGate from "./provider/ProviderInstallationGate.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import { CodexInstallation } from "./provider/CodexInstallation.ts";
import { type ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerSettings from "./serverSettings.ts";
import { ScientServerSettings } from "./scientServerSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PreviewTunnel from "./preview/PreviewTunnel.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as GeneratedDocumentStore from "./scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as WorkspaceBindingResolver from "./scient/projectScope/WorkspaceBindingResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as LayoutCommandApprovalWrites from "./workspace/LayoutCommandApprovalWrites.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as WorkspaceFolders from "./workspace/WorkspaceFolders.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as VcsDriver from "./vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AssetSigner from "./assets/AssetSigner.ts";
import * as WorkspacePreviewRevisions from "./assets/WorkspacePreviewRevisions.ts";
import * as EnvironmentKeys from "./cloud/environmentKeys.ts";
import * as SecretResolver from "./secrets/SecretResolver.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import * as CloudLink from "./cloud/CloudLink.ts";
import * as ConnectReachability from "./cloud/ConnectReachability.ts";
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
import { ComputeRecipeNetwork } from "./scient/compute/ComputeRecipeSource.ts";
import { type MeasuredWsClient } from "../integration/NetworkTransferMeasurement.integration.ts";
import { DEFAULT_SIGNAL_EXPORT, layerOtlpSerialization } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
// SCIENT-FORK:START — Scient Accounts: isolate account storage and key handling in server tests.
// SCIENT-FORK:END
// SCIENT-FORK:START — Select the Sources backend through its reference.
// SCIENT-FORK:END
// @effect-diagnostics nodeBuiltinImport:off - HTTP router integration uses native transport boundaries.

// SCIENT-FORK:START — ignored-file RPC races exercise the shipped native boundary.
export const ignoredReadHelper = await filePublicationTestHelper();
export const ignoredReadNative = await nativePublicationHost();
// SCIENT-FORK:END

export const decodeWorkflowSubagent = Schema.decodeUnknownSync(OrchestrationV2SubagentJson);
export const encodeWorkflowSubagent = Schema.encodeSync(OrchestrationV2SubagentJson);
export const decodeWorkflowTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
export const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const SUCCESSFUL_GIT_EXECUTION = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
export const decodeTransferThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
export const decodeLegacyThreadBoundedSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
export const decodeQueueOperationError = Schema.decodeUnknownEffect(
  ScientThreadQueueOperationError,
);
export const decodeQueueSnapshot = Schema.decodeUnknownEffect(ScientThreadQueueSnapshot);
export const decodeTransferHistoryPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage)),
);
export const decodeTransferShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellSnapshot)),
);
export const decodeTransferShellHttpSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellHttpSnapshot)),
);
export const decodeTransferShellResumable = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellResumable)),
);
// The opt-ins current web and mobile clients send, as in integration/transferBudgetV2. Each is
// `Required`, so an opt-in added to a contract fails typecheck here until this test sends it.
const TRANSFER_CLIENT_BOUNDED_OPT_INS = {
  compactTurnItems: "1",
  dedupeBodies: "1",
  compactIds: "1",
  deferWork: "1",
} satisfies Required<typeof EnvironmentOrchestrationThreadBoundedSnapshotQuery.Type>;
const TRANSFER_CLIENT_HISTORY_OPT_INS = { compactIds: "1", deferWork: "1" } satisfies Required<
  Omit<typeof EnvironmentOrchestrationThreadHistoryQuery.Type, "cursor" | "throughEntryId" | "view">
>;
const TRANSFER_CLIENT_SHELL_OPT_INS = {
  omitIdleSubagents: "1",
  omitOlderSettled: "1",
} satisfies Required<Omit<typeof EnvironmentOrchestrationShellSnapshotQuery.Type, "resumeFrom">>;
const TRANSFER_CLIENT_THREAD_SUBSCRIPTION = {
  requestCompletionMarker: true,
  acceptBoundedSnapshot: true,
  acceptDeferredWork: true,
  acceptCompactTurnItems: true,
  acceptCompactIds: true,
  acceptDedupedBodies: true,
} satisfies Required<Omit<OrchestrationV2SubscribeThreadInput, "threadId" | "afterSequence">>;
type TransferShellResumeField = "afterSequence" | "httpSnapshotFallback" | "knownProjectIdentities";
const TRANSFER_CLIENT_SHELL_SUBSCRIPTION = {
  requestCompletionMarker: true,
  omitIdleSubagents: true,
  omitOlderSettled: true,
} satisfies Required<Omit<OrchestrationV2SubscribeShellInput, TransferShellResumeField>>;
const transferQuery = (optIns: Readonly<Record<string, string>>) =>
  new URLSearchParams(optIns).toString();
export const TRANSFER_CLIENT_BOUNDED_QUERY = transferQuery(TRANSFER_CLIENT_BOUNDED_OPT_INS);
export const TRANSFER_CLIENT_HISTORY_QUERY = transferQuery(TRANSFER_CLIENT_HISTORY_OPT_INS);
export const TRANSFER_CLIENT_SHELL_QUERY = transferQuery(TRANSFER_CLIENT_SHELL_OPT_INS);
// A client that holds shell rows names their cursor in the same request.
export const transferClientShellResumeQuery = (resumeFrom: number) =>
  transferQuery({
    ...TRANSFER_CLIENT_SHELL_OPT_INS,
    resumeFrom: String(resumeFrom),
  } satisfies Required<typeof EnvironmentOrchestrationShellSnapshotQuery.Type>);
export type TransferSubscription =
  | ({ readonly thread: ThreadId } & Pick<OrchestrationV2SubscribeThreadInput, "afterSequence">)
  | ({ readonly shell: true } & Pick<OrchestrationV2SubscribeShellInput, TransferShellResumeField>);
export function transferSubscriptionStream(
  client: MeasuredWsClient,
  subscription: TransferSubscription,
): Stream.Stream<OrchestrationV2ThreadStreamItem | OrchestrationV2ShellStreamItem, unknown> {
  if ("thread" in subscription) {
    const { thread, ...resume } = subscription;
    return client.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
      ...TRANSFER_CLIENT_THREAD_SUBSCRIPTION,
      ...resume,
      threadId: thread,
    });
  }
  const { shell: _, ...resume } = subscription;
  return client.client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
    ...TRANSFER_CLIENT_SHELL_SUBSCRIPTION,
    ...resume,
  });
}
export const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeTestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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

// SCIENT-FORK:START — the real extensions owners, as the server composes them.
// SCIENT-FORK:END

export const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
export const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
export const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

export const nativeAdmissionInstance: ProviderInstance = {
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

export const providerSetupInstanceId = ProviderInstanceId.make("antigravity-custom-profile");
export const providerSetupDriver = ProviderDriverKind.make("antigravity");
export const providerSetupInstallState: ProviderInstallState = {
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
export const providerSetupAuthState: ProviderAuthState = {
  instanceId: providerSetupInstanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
export const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
export const providerSetupInstance: ProviderInstance = {
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

export const testEnvironmentDescriptor = {
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
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
        getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
      }),
    ),
  );

export const makeBrowserOtlpPayload = (spanName: string) =>
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
    return (yield* decodeTestJson(request.body).pipe(Effect.orDie)) as OtlpTracer.TraceData;
  });

let migratedTemplate: Promise<{ readonly base: string; readonly dbPath: string }> | undefined;
// Recorded as soon as it exists, so a failed migration still removes it.
let migratedTemplateBase: string | undefined;
/**
 * The routes' settings layer opens the production database file in the state folder. Each
 * fixture starts from a copy of one closed database that the same layer created and migrated.
 */
const migratedDatabase = (config: ServerConfig.ServerConfig["Service"]) =>
  Effect.promise(() => {
    migratedTemplate ??= Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectory({ prefix: "t3-router-database-" });
        migratedTemplateBase = base;
        const paths = yield* ServerConfig.deriveServerPaths(base, config.devUrl);
        yield* fs.makeDirectory(paths.stateDir, { recursive: true });
        yield* Effect.scoped(
          Layer.build(SqlitePersistence.layerConfig).pipe(
            Effect.provide(ServerConfig.layer({ ...config, baseDir: base, ...paths })),
          ),
        );
        return { base, dbPath: paths.dbPath };
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    return migratedTemplate.then((template) => template.dbPath);
  });

afterAll(async () => {
  migratedTemplate = undefined;
  if (migratedTemplateBase)
    await NodeFSP.rm(migratedTemplateBase, { recursive: true, force: true });
  migratedTemplateBase = undefined;
});

export const buildAppUnderTest = (options?: {
  onPairingChangesSubscribed?: Effect.Effect<void>;
  // SCIENT-FORK:START — Select the Sources backend through its reference.
  scientSourcesBackend?: ScientSourcesBackendKind;
  // SCIENT-FORK:END
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
  // SCIENT-FORK:START — exercise namespace changes at the workspace read boundary.
  transformWorkspaceEntries?: (
    entries: WorkspaceEntries.WorkspaceEntries["Service"],
  ) => WorkspaceEntries.WorkspaceEntries["Service"];
  // SCIENT-FORK:END
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
    scientServerSettings?: Partial<ScientServerSettings["Service"]>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher["Service"]>;
    vcsDriver?: Partial<VcsDriver.VcsDriver["Service"]>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry["Service"]>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
    knownWorkspaces?: Partial<KnownWorkspaces.KnownWorkspaces["Service"]>;
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
    // Only the fixture's own database starts from the template; a caller's path is left alone.
    if (
      options?.config?.baseDir === undefined &&
      options?.config?.stateDir === undefined &&
      options?.config?.dbPath === undefined
    ) {
      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      yield* fileSystem.copyFile(yield* migratedDatabase(config), config.dbPath);
    }
    const layerConfig = ServerConfig.layer(config);
    const defaultVcsDriver: VcsDriver.VcsDriver["Service"] = {
      checkpoints: {
        captureCheckpoint: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        hasCheckpointRef: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        restoreCheckpoint: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        diffCheckpoints: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        listAuthoredPaths: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        deleteCheckpointRefs: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        resolveCleanHead: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
        captureHeadCheckpoint: () => Effect.die("VcsDriver.checkpoints not stubbed in this test"),
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
    const serverSettingsLayer = Layer.merge(
      Layer.mock(ServerSettings.ServerSettingsService)({
        managedPolicy: undefined,
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
        ...options?.layers?.serverSettings,
      }),
      Layer.mock(ScientServerSettings)({
        committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
        ...options?.layers?.scientServerSettings,
      }),
    );
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      // Worktree launches read the local branch names first; none block by default.
      listLocalBranchNames: () => Effect.succeed([]),
      // Status refreshes read refs first; no snapshot always rereads local status.
      readRefSnapshot: () => Effect.succeed(null),
      readLocalStatusRefSnapshot: () => Effect.succeed(null),
      ...options?.layers?.gitVcsDriver,
    });
    const gitManagerLayer = Layer.mock(GitManager.GitManager)({
      ...options?.layers?.gitManager,
    });
    // SCIENT-FORK:START — retain the real service behind the controlled read boundary.
    const workspaceEntriesLayer = Layer.effect(
      WorkspaceEntries.WorkspaceEntries,
      Effect.map(
        WorkspaceEntries.WorkspaceEntries,
        (entries) => options?.transformWorkspaceEntries?.(entries) ?? entries,
      ),
    ).pipe(
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(vcsDriverRegistryLayer),
        ),
      ),
    );
    // SCIENT-FORK:END
    // Every folder is known unless a test narrows it; WorkspaceFileSystem's own tests cover
    // the rejection.
    const knownWorkspacesLayer = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
      contains: () => Effect.succeed(true),
      assertContains: () => Effect.void,
      ...options?.layers?.knownWorkspaces,
    });
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      knownWorkspacesLayer,
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(workspaceEntriesLayer),
        Layer.provide(knownWorkspacesLayer),
      ),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer,
      // Single-folder threads: no task folder and no other tracked folders.
      Layer.mock(TaskFolders.TaskFolders)({
        plan: () => Effect.succeed(null),
        find: () => Effect.succeed(null),
        createForProjectFolder: () => Effect.succeed(null),
        removeIfTaskFolder: () => Effect.succeed(false),
      }),
      Layer.mock(LayoutCommandApprovalWrites.LayoutCommandApprovalWrites)({}),
      Layer.mock(WorkspaceFolders.WorkspaceFolders)({
        forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
        submodules: () => Effect.succeed([]),
      }),
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
          Layer.provide(ProjectStoreV2.layer),
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
                        EventSinkV2.EventSinkV2,
                        Context.get(context, EventSinkV2.EventSinkV2),
                      ),
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
              subscribeChanges: Effect.succeed(Stream.empty),
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
            Layer.mock(DatabaseStorage.DatabaseStorage)({
              reclaim: Effect.void,
              status: Stream.make(null),
            }),
            // T3's workflow runtime: one milestone hub and no forge, as no fixture runs workflows.
            MilestoneHub.layer,
            Layer.succeed(WorkflowForge.WorkflowForge, WorkflowForge.unavailable),
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
        // SCIENT-FORK:START — extensions RPCs and connector routes use the real owners,
        // backed by this fixture's state directory, project store and provider registry.
        Layer.provide(ScientExtensionsLayerLive.pipe(Layer.provide(ProjectStoreV2.layer))),
        // SCIENT-FORK:END
        // Provider installs run through T3's service, over the mocked installations below.
        Layer.provide(ProviderInstallation.layer),
        // Provider maintenance and text generation wait on the server's one installation gate.
        Layer.provide(Layer.merge(ProviderInstallationGate.layer, ThreadMcpStatusRegistry.layer)),
        Layer.provide(Layer.mock(SecretCheck.SecretCheck)({})),
        // The runtime layer, not the websocket layer, owns the one session scanner.
        Layer.provide(
          AgentSessionScanner.layer.pipe(
            Layer.provide(Layer.mergeAll(ProviderSessionRuntime.layer, ProjectStoreV2.layer)),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ModelManifest.ModelManifest)({
              // Upstream's adapter registry reads the current manifest for version checks.
              current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
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
              getProviderConnectionActionsForInstance: () => Effect.undefined,
              getProviderManagedRuntimeActionsForInstance: () => Effect.undefined,
              getVoiceTranscriptCorrectionForInstance: () =>
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
              // The extensions change feed follows instance replacement.
              streamChanges: Stream.never,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
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
              resize: () => Effect.die("PreviewManager not stubbed in this test"),
              reportStatus: () => Effect.void,
              close: () => Effect.void,
              registerBeforeClose: () => Effect.void,
              list: () => Effect.succeed({ sessions: [], serverEpoch: "test-server", revision: 0 }),
              events: Stream.empty,
              subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            }),
            Layer.mock(PreviewTunnel.PreviewTunnel)({
              connect: () => Effect.die("PreviewTunnel not stubbed in this test"),
            }),
            Layer.mock(PortScanner.PortDiscovery)({
              scan: () => Effect.succeed([]),
              subscribe: () => Effect.void,
              retain: Effect.void,
              registerTerminalProcesses: () => Effect.void,
              unregisterTerminal: () => Effect.void,
              trackAgent: () => () => undefined,
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
            Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
            Layer.mock(TriageService.TriageService)({}),
          ),
        ),
        Layer.provide(Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({})),
        Layer.provide(ThreadViewers.layer),
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
      // Own pipe: one pipe takes at most 20 steps.
      .pipe(
        // SCIENT-FORK:START — Scient Accounts: provide synthetic accounts to all server harnesses.
        Layer.provide(AccountsTestkit.layer),
        // SCIENT-FORK:END
        // SCIENT-FORK:START — Compute recipe updates come from GitHub; harnesses keep the shipped recipes.
        Layer.provide(Layer.succeed(ComputeRecipeNetwork)(false)),
        // SCIENT-FORK:END
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(FeatureFlags.layerTest()),
        // The real resolver, reading this fixture's settings, so secret reloads stay exercised.
        Layer.provide(SecretResolver.layer.pipe(Layer.provide(serverSettingsLayer))),
      )
      .pipe(
        Layer.provide(DocumentText.layer),
        Layer.provide(CloudLink.layer),
        Layer.provide(
          Layer.mock(ConnectReachability.ConnectReachability)({
            latest: Effect.succeedNone,
          }),
        ),
        Layer.provide(DirectEndpoints.layer),
        Layer.provide(workspaceBindingResolverLayer),
        Layer.provide(GeneratedDocumentStore.layer),
        Layer.provide(resourceTelemetryLayer),
        Layer.provide(UsageService.layerTest),
        Layer.provide(
          Layer.mock(AnalyticsService.AnalyticsService)({
            record: () => Effect.succeed(true),
            recordOwners: () => Effect.void,
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
          Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
            getEnvironmentId:
              options?.layers?.serverEnvironment?.getEnvironmentId ??
              Effect.succeed(testEnvironmentDescriptor.environmentId),
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
                inspectConnector: Effect.succeed(null),
                readinessChanged: Stream.empty,
                // Managed endpoint recovery stays inert in tests: no requests, no
                // side effects, and the link-state lock is a pass-through.
                recoveryRequests: Stream.empty,
                tunnelConnected: Stream.empty,
                requestRecovery: () => Effect.void,
                restartConnector: () => Effect.succeed(false),
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
            getExisting: Effect.succeedNone,
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
        Layer.provideMerge(
          Layer.mergeAll(AssetSigner.layer, EnvironmentKeys.layer, WorkspacePreviewRevisions.layer),
        ),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(workspaceAndProjectServicesLayer),
        // Reuse the same fixture owners for dependencies introduced by later layers.
        Layer.provide(gitVcsDriverLayer),
        Layer.provide(serverSettingsLayer),
        // Honour an injected client so relay-route tests can stub the upstream
        // response instead of reaching the network. Without this the option is
        // silently ignored and the cloud seam tests exercise the real client.
        Layer.provideMerge(
          options?.layers?.httpClient === undefined
            ? FetchHttpClient.layer
            : Layer.succeed(HttpClient.HttpClient, options.layers.httpClient),
        ),
        // Hosts are read through each driver's own services; no route test reads host media.
        Layer.provide(Layer.succeed(SourceControlBuiltInDrivers.SourceControlDrivers, [])),
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

    // SCIENT-FORK:START — Select the Sources backend through its reference.
    const backendLayer =
      options?.scientSourcesBackend === undefined
        ? appLayer
        : appLayer.pipe(
            Layer.provide(Layer.succeed(ScientSourcesBackend, options.scientSourcesBackend)),
          );
    const services = yield* Layer.build(backendLayer);
    // SCIENT-FORK:END
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
  }).pipe(Effect.provide(ManagedPolicy.layerTest()));

export const parseSessionCookieFromWsUrl = (
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
      const socket = new NodeWS.WebSocket(
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

export const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = Effect.Success<typeof makeWsRpcClient>;

export const withWsRpcClient = <A, E, R, E2 = never, R2 = never>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R> | Effect.Effect<A, E2, R2>,
  onMessage?: (message: string) => void,
) =>
  makeWsRpcClient.pipe(
    Effect.flatMap((client) => Effect.suspend<A, E | E2, R | R2>(() => f(client))),
    Effect.provide(wsRpcProtocolLayer(wsUrl, onMessage)),
  );

export const withFirstWsAckHeld = (
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

export const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

export const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

export const bootstrapBrowserSession = (
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

export const exchangeAccessToken = (
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

export const makeDpopProof = (input: {
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

export const makeCloudMintCredentialRequest = (input: {
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

export const makeCloudEnvironmentHealthRequest = (input: {
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

// Cloud configuration is read through Config and straight from process.env, so a test
// that opts into the cloud route sets the real process environment. Returns the restore.
export const setProcessEnvironment = (values: Readonly<Record<string, string>>) => {
  const previous = Object.keys(values).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

export const decodeCompactJwtPayload = <A>(token: string): A => {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    throw new Error("JWT does not contain a payload.");
  }
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as A;
};

class AuthenticationGetterError extends Schema.TaggedError<AuthenticationGetterError>()(
  "AuthenticationGetterError",
  { message: Schema.String },
) {}

class TestHttpRequestError extends Schema.TaggedError<TestHttpRequestError>()(
  "TestHttpRequestError",
  { cause: Schema.Defect() },
) {}

const testRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  const value = input.toString();
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

export const fetchEffect = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
      ? effect.pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            ...fixtureFetchOptions,
            redirect: "manual",
          }),
        )
      : effect
  ).pipe(Effect.mapError((cause) => new TestHttpRequestError({ cause })));
};

export const jsonRequestBody = (value: unknown): string => {
  return JSON.stringify(value);
};

export const responseJsonEffect = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) => json as A),
    Effect.mapError((cause) => new TestHttpRequestError({ cause })),
  );

const responseOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

export const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
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

// SCIENT-FORK:START — the desktop's own session skips WebSocket compression, so
// compression tests connect as a paired client.
export const getPairedClientCredential = Effect.gen(function* () {
  const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
  const response = yield* HttpClient.post("/api/auth/pairing-token", {
    headers: { cookie: ownerCookie },
    body: yield* HttpBody.json({}),
  });
  return ((yield* response.json) as { readonly credential: string }).credential;
});
// SCIENT-FORK:END

export const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* exchangeAccessToken(credential, {
      scope: AuthStandardClientScopes.join(" "),
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

export const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

export const splitHeaderTokens = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

export const assertBrowserApiCorsResponseHeaders = (
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

export const assertBrowserApiCorsPreflightHeaders = (
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
    ORCHESTRATION_PROTOCOL_HEADER,
  ]);
};
export const crossOriginClientOrigin = "http://remote-client.test:3773";

export const getWsServerUrl = (
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

// The access inventory is served only by the WebSocket subscription's first snapshot.
export const readAuthAccessSnapshot = (
  session: { readonly cookie: string } | { readonly bearer: string },
) =>
  Effect.gen(function* () {
    const baseWsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
    let wsUrl: string;
    if ("cookie" in session) {
      wsUrl = appendSessionCookieToWsUrl(baseWsUrl, session.cookie);
    } else {
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${session.bearer}` },
      });
      assert.equal(ticketResponse.status, 200);
      const { ticket } = (yield* ticketResponse.json) as { readonly ticket: string };
      wsUrl = `${baseWsUrl}&wsTicket=${encodeURIComponent(ticket)}`;
    }
    const event = yield* Effect.scoped(
      withWsRpcClient(wsUrl, (client) =>
        client.subscribeAuthAccess({}).pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
      ),
    );
    if (event.type !== "snapshot") {
      return yield* Effect.die(`Expected an auth access snapshot, received ${event.type}`);
    }
    return event.payload;
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

const fixtureFetchOptions: RequestInit = {
  keepalive: false,
  headers: { connection: "close" },
};
const testFetchClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, fixtureFetchOptions)),
);

// Close each HTTP connection instead of retaining sockets for ephemeral fixture ports.
export const NodeHttpServerTest = HttpServer.layerTestClient.pipe(
  Layer.provide(Layer.fresh(testFetchClientLayer)),
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
);

// Mirror the production permessage-deflate setting with the same connection policy.
export const NodeHttpServerTestWithWsDeflate = HttpServer.layerTestClient.pipe(
  Layer.provide(Layer.fresh(testFetchClientLayer)),
  Layer.provideMerge(
    NodeHttpServer.layer(NodeHttp.createServer, {
      host: "127.0.0.1",
      port: 0,
      websocket: { perMessageDeflate: true },
    }),
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

export const seedV2StreamThread = Effect.fn("seedV2StreamThread")(function* (
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

export const collectV2ThreadCatchup = (
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
export const collectV2ShellCatchup = (wsUrl: string, afterSequence?: number) =>
  withWsRpcClient(wsUrl, (client) =>
    client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
      ...(afterSequence === undefined ? {} : { afterSequence }),
      requestCompletionMarker: true,
    }).pipe(
      Stream.takeUntil((item) => item.kind === "synchronized"),
      Stream.runCollect,
    ),
  );

export const makeNativeArchiveFixture = Effect.fn("makeNativeArchiveFixture")(function* (
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

// Native launches are accepted before asynchronous workspace preparation.
// Failures keep the authored message and failed run; an explicitly requested
// worktree never silently falls back to the project checkout.
export const makeNativeLaunchFixture = Effect.fn("makeNativeLaunchFixture")(function* (
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
        resolveWorktreeBaseRemote: () => Effect.succeed(null),
        fetchWorktreeBaseCommit: () => Effect.die("A local launch must not fetch a remote base"),
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
