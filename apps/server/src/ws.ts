import * as Crypto from "effect/Crypto";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SchemaAST from "effect/SchemaAST";
import { rpcInitialItems } from "./rpcInitialItems.ts";
import {
  OrchestrationDispatchCommandError,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AcpRegistryOperationError,
  CommandId,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  type DiscoveredLocalServerList,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationClientOrigin,
  type OrchestrationV2Command,
  type ClientOrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type AcpRegistryImportSessionInput,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDisableProviderInput,
  type AcpRegistryListProvidersInput,
  type AcpRegistryListSessionsInput,
  type AcpRegistrySetProviderInput,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type ProviderConnectionOperation,
  type ServerLifecycleStreamEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
  WsRpcGroup,
  WsConversationRpcGroup,
  WsServerManagementRpcGroup,
  WsRepositoryRpcGroup,
  WsScientificRpcGroup,
  WsWorkspaceRpcGroup,
  WsInteractiveRpcGroup,
  WsDeviceAndTelemetryRpcGroup,
  CustomModelError,
  TextGenerationError,
  supportsModelConnections,
  AuthOrchestrationOperateScope,
  type OrchestrationEvent,
  OrchestrationGetSnapshotError,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_DISPLAY_NAMES,
  type ProjectCreateNewInput,
  type ProjectDirectoryFailure,
  type ProjectDirectoryOperation,
  type ProjectFileErrorReason,
  ProjectListDirectoryError,
  ProjectRenameFileError,
  type ServerProvider,
  ScientSkillManagementError,
  AssetGeneratedDocumentAuthorityMismatchError,
  AssetGeneratedDocumentNotFoundError,
  AssetGeneratedDocumentResolutionError,
  AssetAnalysisArtifactNotFoundError,
  AssetAnalysisArtifactResolutionError,
  AssetComputeOutputNotFoundError,
  AssetComputeOutputResolutionError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as IdAllocator from "./orchestration-v2/IdAllocator.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import {
  archivedShellStreamItemFromThreadShell,
  buildActiveShellSnapshot,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "./orchestration-v2/ShellStream.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import { bufferLiveStream } from "./orchestration-v2/LiveStreamBudget.ts";
import { coalesceThreadLiveStream } from "./orchestration-v2/ThreadLiveEventCoalescer.ts";
import {
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./orchestration-v2/ThreadStream.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import {
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/Services/OrchestrationEventStore.ts";
import { dispatchCommandRpcError } from "./orchestration-v2/DispatchCommandRpcError.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as AcpRegistrySupport from "./provider/acp/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./provider/acp/AcpRegistryRuntimeCoordinator.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderMaintenance from "./provider/providerMaintenance.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderAuthService from "./provider/Services/ProviderAuthService.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { persistChatAttachments } from "./AttachmentPersistence.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration-v2/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { refreshPushedPullRequests } from "./git/refreshPushedPullRequests.ts";
import { linkCreatedPullRequest } from "./git/linkCreatedPullRequest.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { projectMutationOperation } from "./project/ProjectMutation.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod, requiredScopeForDeviceList } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as ForgejoCli from "./sourceControl/ForgejoCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as Cause from "effect/Cause";
import { createModelSelection } from "@t3tools/shared/model";
import * as EffectAcpErrors from "effect-acp/errors";
import { customModelProviderId } from "./customModels.ts";
import { droidCustomModelId } from "./provider/droid/DroidCustomModels.ts";
import { droidToolGuardTestRefusal } from "./textGeneration/DroidTextGeneration.ts";
import { encodeOmpModelSlug } from "./provider/omp/OmpModel.ts";
import { encodePiModelSlug } from "./provider/pi/PiModel.ts";
import * as Predicate from "effect/Predicate";
import { rejectCodexSubscriptionSharing } from "./scient/providerLifecycle/codexSubscriptionSharingPolicy.ts";
import { ConversationForkService } from "./orchestration-v2/scient-fork/ConversationForkService.ts";
import * as ProviderConnectionManager from "./scient/providerLifecycle/ProviderConnectionManager.ts";
import * as ProviderLifecycleCoordinator from "./scient/providerLifecycle/ProviderLifecycleCoordinator.ts";
import * as ProviderRuntimeManager from "./scient/providerLifecycle/ProviderRuntimeManager.ts";
import * as ManagedRuntimeCatalog from "./scient/providerLifecycle/ManagedRuntimeCatalog.ts";
import { reconcileManagedRuntimeProviders } from "./scient/providerLifecycle/ManagedRuntimeCatalogReconciler.ts";
import { workspaceEntryDisposition } from "./scient/workspace/WorkspaceEntryPolicy.ts";
import * as GeneratedDocumentStore from "./scient/documentArtifacts/GeneratedDocumentStore.ts";
import { publishBrowserPdfExport } from "./scient/documentArtifacts/BrowserPdfExportPublication.ts";
import { publishCapturedDocumentPdf } from "./scient/documentExport/DocumentPdfPublication.ts";
import { prepareMarkdownPdf } from "./scient/documentExport/MarkdownPdfPreparation.ts";
import { prepareConversationPdf } from "./scient/documentExport/ConversationPdfPreparation.ts";
import { removeDocumentCapture } from "./scient/documentExport/DocumentCapture.ts";
import { ConversationExportService } from "./scient/conversationExport/ConversationExportService.ts";
import * as AnalysisService from "./scient/analysis/AnalysisService.ts";
import { makeComputeRpcGateway } from "./scient/compute/ComputeRpcGateway.ts";
import { WorkspaceBindingResolver } from "./scient/projectScope/WorkspaceBindingResolver.ts";
import { ScientificRuntimePreferences } from "./scient/compute/ScientificRuntimePreferences.ts";
import * as ComputeSessionService from "./scient/compute/ComputeSessionService.ts";
import * as ScientSkillManagement from "./scient/skills/ScientSkillManagement.ts";
import * as ProviderSkillManagement from "./scient/skills/ProviderSkillManagement.ts";
import { makeVoiceTranscriptCorrection } from "./scient/voice/VoiceTranscriptCorrection.ts";
import {
  prepareEnvironmentFileOpen,
  watchEnvironmentFile,
} from "./scient/fileOpening/EnvironmentFileOpen.ts";
import { resolveEnvironmentFileLink } from "./scient/fileOpening/EnvironmentFileLinkResolve.ts";
import * as NewProject from "./project/NewProject.ts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isTextGenerationError = Schema.is(TextGenerationError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isProviderUploadFeedbackError = Schema.is(ProviderUploadFeedbackError);

const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

const compactProviderError = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
};

const CUSTOM_MODEL_TEST_TIMEOUT_SECONDS = 45;

/** Names the agent the test ran through: its instance label, else the driver's name. */
const customModelTestFailure = (
  instance: { readonly driverKind: ProviderDriverKind; readonly displayName: string | undefined },
  cause: unknown,
) => {
  const agent =
    instance.displayName ?? PROVIDER_DISPLAY_NAMES[instance.driverKind] ?? instance.driverKind;
  if (Predicate.isTagged(cause, "TimeoutError"))
    return new CustomModelError({
      message: `${agent}: No response within ${CUSTOM_MODEL_TEST_TIMEOUT_SECONDS} s.`,
    });
  // Droid refuses to run without its tool blocking; say so for a Test, not for titles.
  const toolGuard = isTextGenerationError(cause) ? droidToolGuardTestRefusal(cause) : undefined;
  if (toolGuard !== undefined) return new CustomModelError({ message: `${agent}: ${toolGuard}` });
  if (isTextGenerationError(cause) && isAcpRequestError(cause.cause)) {
    const providerDetail = compactProviderError(cause.cause.data);
    if (providerDetail) return new CustomModelError({ message: `${agent}: ${providerDetail}` });
    const providerMessage = compactProviderError(cause.cause.errorMessage);
    if (providerMessage) return new CustomModelError({ message: `${agent}: ${providerMessage}` });
  }
  return new CustomModelError({
    message: `${agent} could not use this model. Check the key, model ID and model settings.`,
  });
};

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

const hasAuthorizationMaterial = (
  operation: ProviderConnectionOperation | null | undefined,
): operation is ProviderConnectionOperation =>
  operation !== null &&
  operation !== undefined &&
  (operation.authorizationUrl !== undefined ||
    operation.userCode !== undefined ||
    operation.instructions !== undefined);

const withoutAuthorizationMaterial = (
  operation: ProviderConnectionOperation,
): ProviderConnectionOperation => {
  const redactedOperation = { ...operation };
  delete redactedOperation.authorizationUrl;
  delete redactedOperation.authorizationUrlKind;
  delete redactedOperation.userCode;
  // The provider's own wording can repeat the device code.
  delete redactedOperation.instructions;
  return redactedOperation;
};

const redactProviderAuthorizationForReadOnlyClient = (provider: ServerProvider): ServerProvider => {
  const connection = provider.connection;
  if (connection === undefined) return provider;
  const { operation, accountOperation } = connection;
  if (!hasAuthorizationMaterial(operation) && !hasAuthorizationMaterial(accountOperation)) {
    return provider;
  }
  return {
    ...provider,
    connection: {
      ...connection,
      ...(hasAuthorizationMaterial(operation)
        ? { operation: withoutAuthorizationMaterial(operation) }
        : {}),
      ...(hasAuthorizationMaterial(accountOperation)
        ? { accountOperation: withoutAuthorizationMaterial(accountOperation) }
        : {}),
    },
  };
};

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

/** The operating system's error code for a failed file operation, when it gave one. */
function projectFileOsErrorCode(cause: unknown): string | undefined {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : undefined;
}

/** The operating system's reason for a failed file operation, when it gave one. */
function projectFileErrorReason(code: string | undefined): ProjectFileErrorReason | undefined {
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    default:
      return undefined;
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly currentRevision?: string;
  readonly reason?: ProjectFileErrorReason;
  readonly osErrorCode?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError": {
      const osErrorCode = projectFileOsErrorCode(error.cause);
      const reason = projectFileErrorReason(osErrorCode);
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
        ...(reason ? { reason } : {}),
        ...(osErrorCode ? { osErrorCode } : {}),
      };
    }
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceFileExistsError":
      return { failure: "path_exists", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    case "WorkspaceFileRevisionConflictError":
      return {
        failure: "revision_conflict",
        resolvedPath: error.resolvedPath,
        currentRevision: error.currentRevision,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectDirectoryFailureContext(
  error: WorkspaceEntries.WorkspaceEntriesListDirectoryError,
): {
  readonly failure: ProjectDirectoryFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectDirectoryOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return { failure: "workspace_root_not_found", resolvedPath: error.normalizedWorkspaceRoot };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        resolvedPath: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return { failure: "workspace_root_stat_failed", resolvedPath: error.normalizedWorkspaceRoot };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        resolvedPath: error.normalizedWorkspaceRoot,
      };
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceDirectoryError":
      return {
        failure: error.failure,
        ...(error.resolvedPath === undefined ? {} : { resolvedPath: error.resolvedPath }),
        ...(error.resolvedWorkspaceRoot === undefined
          ? {}
          : { resolvedWorkspaceRoot: error.resolvedWorkspaceRoot }),
        ...(error.operation === undefined ? {} : { operation: error.operation }),
        ...(error.operationPath === undefined ? {} : { operationPath: error.operationPath }),
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}
const PROVIDER_STATUS_DEBOUNCE_MS = 200;

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_COALESCE_MAX_CHUNK = 256;
const PROVIDER_STATUS_COALESCE_WINDOW = Duration.millis(200);

/**
 * Bound provider-status traffic without waiting for the entire stream to go
 * quiet. Runtime downloads can publish progress continuously, so a trailing
 * debounce can indefinitely hide the final succeeded/failed snapshot from
 * connected clients. Fixed windows preserve the latest snapshot at least once
 * per window while still collapsing noisy byte-level progress updates.
 */
export const coalesceProviderStatusUpdates = <E, R>(
  updates: Stream.Stream<ReadonlyArray<ServerProvider>, E, R>,
): Stream.Stream<ReadonlyArray<ServerProvider>, E, R> =>
  updates.pipe(
    Stream.groupedWithin(PROVIDER_STATUS_COALESCE_MAX_CHUNK, PROVIDER_STATUS_COALESCE_WINDOW),
    Stream.map((batch) => batch[batch.length - 1]!),
  );

const ServerWsRpcGroup = WsRpcGroup;
// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Thread replay counts only this thread's rows. Busy or pruned unrelated
// streams must not force a full thread snapshot.
// Row count alone does not bound replay memory: a few events with large tool
// payloads can decode to gigabytes. Before replaying, sum the serialized
// payload bytes of the range in SQL and reset with a snapshot past this budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

export function hasCompatibleOrchestrationProtocol(url: URL): boolean {
  return (
    url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
    String(ORCHESTRATION_PROTOCOL_VERSION)
  );
}

export function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
}): boolean {
  return input.acceptBoundedSnapshot === true;
}

// Optional client identity announced on the /ws upgrade URL next to wsTicket.
// Lenient by design: absent or malformed values degrade to {} so a connection
// never fails over attribution metadata.
function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}

// Client telemetry stays in this socket's RPC layer. It must not become a
// server-global "current client" because several client types can connect at once.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

const canReplayPersistedRange = Effect.fnUntraced(function* (
  afterSequence: number,
  headSequence: number,
  maxGap: number,
) {
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

  const replayGap = headSequence - afterSequence;
  if (replayGap < 0 || replayGap > maxGap) {
    return false;
  }
  const stats = yield* applicationEvents.getReplayStats({
    afterSequence,
    throughSequence: headSequence,
  });
  if (stats.rawPayloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
    yield* Effect.logDebug("orchestration replay replaced by snapshot", {
      afterSequence,
      headSequence,
      replayGap,
      eventCount: stats.eventCount,
      payloadBytes: stats.rawPayloadBytes,
      payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
    });
    return false;
  }
  return true;
});

const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
  (projects: ReadonlyArray<OrchestrationProjectShell>) =>
    Effect.flatMap(ProjectEnrichmentService.ProjectEnrichmentService, (projectEnrichment) =>
      Effect.forEach(
        projects,
        (project) =>
          // Non-blocking: emit with cached identity (or null) and schedule
          // background resolution. subscribeChanges is attached before
          // loadSnapshot, so later identity completions push refreshed
          // shells for multi-env grouping without blocking the initial
          // snapshot or completion marker on slow git probes.
          projectEnrichment.getAvailable(project.workspaceRoot).pipe(
            Effect.map((enrichment) => ({
              project: {
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              },
              repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
            })),
          ),
        { concurrency: 16 },
      ).pipe(
        Effect.map((enriched) => ({
          projects: enriched.map((entry) => entry.project),
          resolvedRepositoryIdentityRoots: enriched
            .filter((entry) => entry.repositoryIdentityResolved)
            .map((entry) => entry.project.workspaceRoot),
        })),
      ),
    ),
);

export const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly acceptBoundedSnapshot?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
    });
    yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to hydrate migrated thread ${input.threadId}`,
            cause,
          }),
      ),
    );

    const eventStreamFrom = (afterSequence: number) =>
      threadManagement
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          coalesceThreadLiveStream,
          Stream.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
      applicationEvents
        .readAgentEvents({
          threadId: input.threadId,
          afterSequence,
          throughSequence,
          limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;

    const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(function* () {
      const useBoundedSnapshot = shouldUseBoundedThreadSnapshot(input);
      const snapshot = yield* (
        useBoundedSnapshot
          ? threadManagement.getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            })
          : threadManagement.getThreadSnapshot(input.threadId)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to load orchestration V2 thread ${input.threadId}`,
              cause,
            }),
        ),
      );
      const { snapshotSequence } = snapshot;
      const snapshotItem = useBoundedSnapshot
        ? buildBoundedThreadStreamSnapshot(snapshot)
        : {
            kind: "snapshot" as const,
            snapshotSequence,
            projection: projectThreadProjectionForWire(snapshot.projection),
          };
      return Stream.concat(
        Stream.concat(rpcInitialItems([snapshotItem]), completionMarker),
        eventStreamFrom(snapshotSequence),
      );
    });

    // When the client already holds the projection (cached, or loaded over
    // HTTP) it passes that snapshot's sequence, and we resume by replaying
    // persisted events after it instead of re-sending the (potentially
    // multi-KB) snapshot frame over the socket. The event sink subscribes
    // to live events before reading the persisted tail, so no event
    // published during the replay window is lost; overlapping events are
    // deduped by sequence on the client.
    if (input.afterSequence !== undefined) {
      const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      if (input.afterSequence > highWater) {
        return yield* snapshotThenLive();
      }
      const stats = yield* applicationEvents
        .getAgentReplayStats({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          maxEvents: THREAD_RESUME_MAX_REPLAY_EVENTS,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to measure orchestration V2 thread ${input.threadId} replay`,
                cause,
              }),
          ),
        );
      // Bound stored JSON before decoding, then check projected event
      // size separately. Neither byte count is a bound on process memory.
      if (
        stats.eventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
        !isThreadReplayRawPayloadSafe(stats.rawPayloadBytes)
      ) {
        return yield* snapshotThenLive();
      }
      if (stats.hasCreateEvent) {
        const shell = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to locate recreated orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );
        // A retained creation can belong to a thread already deleted.
        // Only replace its bounded replay when a snapshot can exist.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replay = yield* loadReplayThrough(input.afterSequence, highWater);
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return Stream.concat(
        Stream.concat(rpcInitialItems(replay), completionMarker),
        eventStreamFrom(highWater),
      );
    }

    return yield* snapshotThenLive();
  },
);

export const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
  function* (input: {
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;

    const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
    const loadProjectMetadataSnapshot = Effect.fn("ws.orchestrationV2.loadProjectMetadataSnapshot")(
      function* (snapshotSequence: number) {
        const enriched = yield* enrichProjectShells(yield* projects.listShells());
        return {
          snapshot: {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence,
            projects: enriched.projects,
            threads: [],
            archivedThreads: [],
          } as OrchestrationV2ShellSnapshot,
          resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
        };
      },
    );
    const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const threads = yield* threadManagement.getShellSnapshot({ location: "active" });
          return buildActiveShellSnapshot({
            projects: yield* projects.listShells(),
            threads,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
          });
        }),
      );
      const enriched = yield* enrichProjectShells(base.projects);
      return {
        snapshot: { ...base, projects: enriched.projects } as OrchestrationV2ShellSnapshot,
        resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
      };
    });
    const projectItem = Effect.fn("ws.orchestrationV2.projectShellItem")(function* (
      stored: Extract<ShellApplicationEvent, { readonly aggregateKind: "project" }>,
    ) {
      if (stored.type === "project.deleted") {
        return {
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        };
      }
      const project = yield* projectService.getShell(stored.aggregateId);
      return Option.match(project, {
        onNone: () => ({
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        }),
        onSome: (value) => ({
          kind: "project.updated" as const,
          sequence: stored.sequence,
          project: value,
        }),
      });
    });

    // Coalescing makes each per-thread shell read represent every event
    // for that thread in the current window; reading only the affected
    // threads keeps the cost of a busy stream independent of how many
    // threads exist overall.
    const projectShellItems = Effect.fn("ws.orchestrationV2.projectShellItems")(function* (
      events: ReadonlyArray<ShellApplicationEvent>,
    ) {
      return yield* Effect.forEach(
        coalesceShellApplicationEvents(events),
        (stored) =>
          Effect.gen(function* () {
            if ("aggregateKind" in stored) {
              return yield* projectItem(stored).pipe(
                Effect.retry({ times: 2, schedule: Schedule.exponential(Duration.millis(25)) }),
              );
            }
            const shell = yield* threadManagement
              .getThreadShell(stored.event.threadId)
              .pipe(
                Effect.retry({ times: 2, schedule: Schedule.exponential(Duration.millis(25)) }),
              );
            return shellStreamItemFromThreadShell({ stored, shell });
          }),
        { concurrency: 8 },
      );
    });

    const toShellStream = <E, R>(stream: Stream.Stream<ShellApplicationEvent, E, R>) =>
      stream.pipe(
        Stream.groupedWithin(512, Duration.millis(50)),
        Stream.mapEffect((events) => projectShellItems(Array.from(events))),
        Stream.flatMap(Stream.fromIterable),
      );

    const liveFrom = (afterSequence: number) =>
      bufferLiveStream(
        toShellStream(
          applicationEvents.streamProjectedApplicationEvents({
            afterSequence,
            project: toShellApplicationEvent,
          }),
        ),
      );

    const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
      Stream.filter((change) => change.repositoryIdentityResolved),
      Stream.groupedWithin(64, Duration.millis(25)),
      // Build the refresh from the identities the changes carry. Re-enriching
      // every project here re-requested each expired root, whose resolution
      // published again, so one expiry kept every subscriber reloading every
      // project's metadata once a minute.
      Stream.mapEffect((changes) =>
        Effect.gen(function* () {
          const identities = new Map(
            Array.from(changes, (change) => [
              change.workspaceRoot,
              change.enrichment.repositoryIdentity,
            ]),
          );
          const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
          const changedProjects = (yield* projects.listShells()).flatMap((project) =>
            identities.has(project.workspaceRoot)
              ? [{ ...project, repositoryIdentity: identities.get(project.workspaceRoot) ?? null }]
              : [],
          );
          return shellStreamItemFromEnrichmentRefresh({
            snapshot: {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence,
              projects: changedProjects,
              threads: [],
              archivedThreads: [],
            } as OrchestrationV2ShellSnapshot,
            changes: Array.from(changes),
          });
        }),
      ),
    );

    // Always attach the enrichment subscription before the first load so
    // completions that race HTTP snapshot fetch still push a refresh.
    // When the client already holds a shell snapshot (cached, or loaded
    // over HTTP) it passes that snapshot's sequence. We still emit one
    // compact metadata refresh up front: getAvailable may have been cold on the
    // HTTP path (null identity), and enrichment PubSub events published
    // before this subscribe attached are dropped. Rehydrating here fills
    // repositoryIdentity for cross-environment project grouping even on
    // afterSequence resumes. Application events after the sequence still
    // stream as deltas; overlapping events are deduped by sequence on the
    // client.
    //
    // After the unmarked authoritative frame, emit a same-sequence
    // metadata-only frame for roots that already resolved successfully
    // (including cached null). Cold/failed roots stay unmarked and use
    // the PubSub enrichment path when they complete later.
    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;
    const initialSnapshotItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromInitialSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    const initialEnrichmentItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromResumeSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    // Initial unmarked (+ optional same-load marked) always drains first.
    // Enrichment merges only with the post-prefix tail so a ready marked
    // refresh cannot interleave before the authoritative initial frame.
    const completionThenLive = (afterSequence: number) =>
      Stream.concat(completionMarker, liveFrom(afterSequence));

    const stream = yield* Effect.gen(function* () {
      if (input.afterSequence === undefined) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      const highWater = yield* applicationEvents.latestApplicationSequence;
      if (!(yield* canReplayPersistedRange(input.afterSequence, highWater, SHELL_RESUME_MAX_GAP))) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      const loaded = yield* loadProjectMetadataSnapshot(highWater);
      const replay = toShellStream(
        applicationEvents.readApplicationEvents({
          afterSequence: input.afterSequence,
          throughSequence: highWater,
        }),
      );
      return composeShellStreamWithEnrichment({
        initial: initialEnrichmentItems(loaded),
        tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(highWater)),
        enrichment: enrichmentRefreshes,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to prepare the application shell stream",
            cause,
          }),
      ),
    );

    return stream.pipe(
      dedupeShellEnrichment,
      Stream.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed while streaming the application shell",
            cause,
          }),
      ),
    );
  },
);

// SCIENT-FORK:START — one wire tag, native V2 authority.
// `ORCHESTRATION_WS_METHODS.dispatchCommand` and `ORCHESTRATION_V2_WS_METHODS.dispatchCommand`
// are the same string, so `RpcGroup.make` can hold exactly one handler body under it.
// `ClientOrchestrationCommand` is still the transport for commands `OrchestrationV2Command`
// has no schema for, so the single body dispatches on the command itself.

/** Command-type literals of a tagged schema, read from its AST. */
const commandTypeLiterals = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  if (SchemaAST.isUnion(ast)) return ast.types.flatMap(commandTypeLiterals);
  if (SchemaAST.isLiteral(ast)) return typeof ast.literal === "string" ? [ast.literal] : [];
  if (SchemaAST.isObjects(ast)) {
    const type = ast.propertySignatures.find((property) => property.name === "type");
    return type === undefined ? [] : commandTypeLiterals(type.type);
  }
  return [];
};

/**
 * Every command type the V2 dispatch RPC accepts, read from its payload schema
 * so the list cannot drift from it.
 */
const ORCHESTRATION_V2_COMMAND_TYPES: ReadonlySet<string> = new Set(
  commandTypeLiterals(OrchestrationV2RpcSchemas.dispatchCommand.input.ast),
);

/**
 * Routes a `dispatchCommand` payload to the legacy engine.
 *
 * The rule: the V2 intake owns a command when — and only when —
 * `OrchestrationV2Command` declares a schema for that command's `type`. Everything
 * else is a retained compatibility command. The conversation fork has its own
 * V2 service; unsupported legacy commands fail explicitly. Deriving the
 * set from the schema keeps the other direction true too: a new V2 command type
 * routes to the V2 intake without anyone editing this file.
 *
 * `thread.fork` is the one tag both unions declare, and the tag alone cannot separate
 * them. V1's fork names `originThreadId`/`newThreadId`/`workspaceMode` and its result
 * carries `forkAttachmentIdMap`, which web reads; V2's fork names
 * `sourceThreadId`/`targetThreadId`/`sourcePoint` and its result is `{ sequence }`. The
 * tag cannot decide, so the fork's own fields do.
 *
 * The declared guard widens to all of `ClientOrchestrationCommand` on purpose: every
 * V1 union member satisfies it, so the legacy branch keeps upstream's own parameter
 * type, and the V2 branch is left holding only the V2 members V1 does not already
 * cover.
 */
const isV1OnlyDispatchCommand = (
  command: ClientOrchestrationCommand | OrchestrationV2Command,
): command is ClientOrchestrationCommand =>
  !ORCHESTRATION_V2_COMMAND_TYPES.has(command.type) ||
  (command.type === "thread.fork" && "originThreadId" in command);
// SCIENT-FORK:END

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const intakeContext = yield* Effect.context<
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | FileSystem.FileSystem
        | ServerConfig.ServerConfig
        | ProjectCloneTracker.ProjectCloneTracker
      >();
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const projectService = yield* ProjectService.ProjectService;
      const threadSearch = yield* ThreadSearch.ThreadSearch;

      const providerSessionsV2 = yield* ProviderSessionManager.ProviderSessionManagerV2;
      // Client-origin attribution (#7774): every thread/turn the connecting
      // client starts is credited to its surface + app version. Best-effort:
      // attribution must never fail the user's command.
      const originProps = clientAnalyticsProps;
      const recordV2ClientCommandAnalytics = (command: OrchestrationV2Command) => {
        switch (command.type) {
          case "message.dispatch":
            return analytics.record("client.turn.requested", originProps).pipe(Effect.ignore);
          default:
            return Effect.void;
        }
      };
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
      const crypto = yield* Crypto.Crypto;
      const sql = yield* SqlClient.SqlClient;
      /** A reference's host-level link key; the project's own host where the ref names none. */
      const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
        reference.host !== undefined && reference.repository.includes("/")
          ? Effect.succeed(pullRequestSyncKey(reference))
          : projectService.getShell(reference.projectId).pipe(
              Effect.map((project) =>
                pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
              ),
              Effect.orElseSucceed(() => null),
            );
      const orchestratorV2 = yield* Orchestrator.OrchestratorV2;
      const conversationForks = yield* ConversationForkService;
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const deviceService = yield* DeviceService.DeviceService;
      const deviceHostContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const providerVersionCache = yield* ProviderMaintenance.ProviderVersionCache;
      const managedRuntimeCatalog = yield* ManagedRuntimeCatalog.ManagedRuntimeCatalog;
      const providerConnectionManager = yield* ProviderConnectionManager.ProviderConnectionManager;
      const providerRuntimeManager = yield* ProviderRuntimeManager.ProviderRuntimeManager;
      const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const acpRegistryCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const acpRegistryRuntimeCoordinator =
        yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAuth = yield* ProviderAuthService.ProviderAuthService;
      const providerInstallation = yield* makeProviderInstallation();
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const voiceTranscriptCorrection = makeVoiceTranscriptCorrection({
        registry: providerRegistry,
        serverSettings,
      });
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const analysis = yield* AnalysisService.AnalysisService;
      const compute = yield* ComputeSessionService.ComputeSessionService;
      const computeGateway = makeComputeRpcGateway({
        workspaceResolver: yield* WorkspaceBindingResolver,
        compute,
        serverSettings: yield* ScientificRuntimePreferences,
        workspaceFileSystem,
      });
      const scientSkillManagement = yield* ScientSkillManagement.ScientSkillManagement;
      const skillContextError = (operation: string, message: string) =>
        new ScientSkillManagementError({ operation, message });
      const resolveScientSkillProjectRoot = Effect.fn("ws.resolveScientSkillProjectRoot")(
        function* (input: {
          readonly projectId?: ProjectId | undefined;
          readonly threadId?: ThreadId | undefined;
        }) {
          if (input.threadId) {
            const thread = yield* threadManagement.getThreadShell(input.threadId).pipe(
              Effect.map((thread) => (thread === null ? Option.none() : Option.some(thread))),
              Effect.mapError(() =>
                skillContextError("list", "The thread workspace could not be resolved."),
              ),
            );
            if (Option.isNone(thread)) {
              return yield* skillContextError("list", "That thread is not available.");
            }
            if (input.projectId && thread.value.projectId !== input.projectId) {
              return yield* skillContextError(
                "list",
                "The requested thread does not belong to that project.",
              );
            }
            if (thread.value.worktreePath) return thread.value.worktreePath;
            if (thread.value.projectId) {
              const project = yield* projectService
                .getShell(thread.value.projectId)
                .pipe(
                  Effect.mapError(() =>
                    skillContextError("list", "The project workspace could not be resolved."),
                  ),
                );
              if (Option.isSome(project)) return project.value.workspaceRoot;
            }
            return yield* skillContextError("list", "That thread has no project workspace.");
          }
          if (input.projectId) {
            const project = yield* projectService
              .getShell(input.projectId)
              .pipe(
                Effect.mapError(() =>
                  skillContextError("list", "The project workspace could not be resolved."),
                ),
              );
            if (Option.isNone(project)) {
              return yield* skillContextError("list", "That project is not available.");
            }
            return project.value.workspaceRoot;
          }
          return undefined;
        },
      );
      const providerSkillManagement =
        ProviderSkillManagement.makeProviderSkillManagement(providerRegistry);
      const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const generatedDocuments = yield* GeneratedDocumentStore.GeneratedDocumentStore;
      const conversationExports = yield* ConversationExportService;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const withPullRequestViewer = pullRequests.withRoutingCredential;
      const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const hostResources = yield* HostResources.HostResources;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const usage = yield* UsageService.UsageService;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const projectProvidersForCurrentSession = currentSession.scopes.includes(
        AuthOrchestrationOperateScope,
      )
        ? (providers: ReadonlyArray<ServerProvider>) => providers
        : (providers: ReadonlyArray<ServerProvider>) =>
            providers.map(redactProviderAuthorizationForReadOnlyClient);

      const acpRegistryProject = Effect.fn("ws.acpRegistry.project")(function* (
        projectId: ProjectId,
      ) {
        const project = yield* projectService.getById(projectId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "project_not_found",
                message: `Project ${projectId} is unavailable.`,
                cause,
              }),
          ),
        );
        return yield* Option.match(project, {
          onNone: () =>
            Effect.fail(
              new AcpRegistryOperationError({
                reason: "project_not_found",
                message: `Project ${projectId} was not found.`,
              }),
            ),
          onSome: Effect.succeed,
        });
      });

      const acpSessionManager = Effect.fn("ws.acpRegistry.sessionManager")(function* (
        instanceId: ProviderInstanceId,
      ) {
        const instance = yield* providerInstances.getInstance(instanceId);
        if (instance === undefined) {
          return yield* new AcpRegistryOperationError({
            reason: "instance_not_found",
            message: `Provider instance ${instanceId} was not found.`,
          });
        }
        if (instance.acpSessionManagement === undefined) {
          return yield* new AcpRegistryOperationError({
            reason: "session_list_unsupported",
            message: `Provider instance ${instanceId} does not expose ACP session management.`,
          });
        }
        return { instance, manager: instance.acpSessionManagement };
      });

      const importedAcpThreadId = (input: {
        readonly driver: ProviderDriverKind;
        readonly instanceId: ProviderInstanceId;
        readonly sessionId: string;
      }) =>
        IdAllocator.deriveThreadFromProviderThread({
          driver: input.driver,
          providerInstanceId: input.instanceId,
          nativeThreadId: input.sessionId,
        });

      const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
        input: AcpRegistryListSessionsInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const listed = yield* manager.listSessions({
          cwd: project.workspaceRoot,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const sessions = yield* Effect.forEach(
          listed.sessions,
          (session) => {
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: session.sessionId,
            });
            return threadManagement.getThreadShell(threadId).pipe(
              Effect.map((thread) => ({
                ...session,
                importedThreadId: thread === null ? null : threadId,
              })),
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_import_failed",
                    message: "Could not inspect existing imported ACP sessions.",
                    cause,
                  }),
              ),
            );
          },
          { concurrency: 16 },
        );
        return { ...listed, sessions };
      });

      const importAcpRegistrySession = Effect.fn("ws.acpRegistry.importSession")(function* (
        input: AcpRegistryImportSessionInput,
      ) {
        return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
          Effect.gen(function* () {
            yield* acpRegistryProject(input.projectId);
            const { instance } = yield* acpSessionManager(input.instanceId);
            const providerSnapshot = yield* instance.snapshot.getSnapshot;
            if (
              providerSnapshot.nativeSessions?.canLoad !== true &&
              providerSnapshot.nativeSessions?.canResume !== true
            ) {
              return yield* new AcpRegistryOperationError({
                reason: "session_resume_unsupported",
                message: "The ACP agent cannot load or resume native sessions.",
              });
            }
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: input.sessionId,
            });
            const existing = yield* threadManagement.getThreadShell(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_import_failed",
                    message: "Could not inspect the imported ACP session mapping.",
                    cause,
                  }),
              ),
            );
            if (existing !== null) return { threadId, imported: false } as const;

            const provider = (yield* providerRegistry.getProviders).find(
              (candidate) => candidate.instanceId === input.instanceId,
            );
            const model =
              provider?.models.find((candidate) => candidate.isDefault)?.slug ??
              provider?.models[0]?.slug ??
              "default";
            const commandId = CommandId.make(NodeCrypto.randomUUID());
            const launched = yield* Effect.result(
              startup.enqueueCommand(
                threadLaunch.launch({
                  commandId,
                  threadId,
                  projectId: input.projectId,
                  title: input.title ?? "Imported ACP session",
                  modelSelection: { instanceId: input.instanceId, model },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  workspaceStrategy: { type: "root" },
                  importedNativeThread: {
                    ref: {
                      driver: instance.driverKind,
                      nativeId: input.sessionId,
                      strength: "strong",
                    },
                    metadata: {
                      itemIdentityVersion: 2,
                      ...(input.title === undefined ? {} : { title: input.title }),
                      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
                    },
                  },
                  createdBy: "user",
                  creationSource: "web",
                }),
              ),
            );
            if (Result.isFailure(launched)) {
              const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "session_import_failed",
                      message: "Could not inspect the imported ACP session after launch failed.",
                      cause,
                    }),
                ),
              );
              if (racedImport !== null) return { threadId, imported: false } as const;
              return yield* new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not create a Scient thread for the ACP session.",
                cause: launched.failure,
              });
            }
            return { threadId, imported: true } as const;
          }),
        );
      });

      const deleteAcpRegistrySession = Effect.fn("ws.acpRegistry.deleteSession")(function* (
        input: AcpRegistryDeleteSessionInput,
      ) {
        return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
          Effect.gen(function* () {
            const project = yield* acpRegistryProject(input.projectId);
            const { instance, manager } = yield* acpSessionManager(input.instanceId);
            const snapshot = yield* instance.snapshot.getSnapshot;
            if (snapshot.nativeSessions?.canDelete !== true) {
              return yield* new AcpRegistryOperationError({
                reason: "session_delete_unsupported",
                message: "The ACP agent does not advertise session deletion.",
              });
            }
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: input.sessionId,
            });
            const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_delete_failed",
                    message: "Could not inspect the imported ACP session mapping.",
                    cause,
                  }),
              ),
            );
            if (importedThread !== null) {
              return yield* new AcpRegistryOperationError({
                reason: "session_delete_failed",
                message:
                  "Delete the imported Scient thread before deleting its native ACP session.",
              });
            }
            yield* manager.deleteSession({
              cwd: project.workspaceRoot,
              sessionId: input.sessionId,
            });
            return { deleted: true } as const;
          }),
        );
      });

      const listAcpRegistryProviders = Effect.fn("ws.acpRegistry.listProviders")(function* (
        input: AcpRegistryListProvidersInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.configurableProviders !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "providers_unsupported",
            message: "The ACP agent does not advertise provider configuration.",
          });
        }
        return yield* manager.listProviders(project.workspaceRoot);
      });

      const setAcpRegistryProvider = Effect.fn("ws.acpRegistry.setProvider")(function* (
        input: AcpRegistrySetProviderInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { manager } = yield* acpSessionManager(input.instanceId);
        if (input.headers !== undefined && Object.keys(input.headers).length > 32) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "ACP provider configuration accepts at most 32 headers.",
          });
        }
        const listed = yield* manager.listProviders(project.workspaceRoot);
        const provider = listed.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || !provider.supported.includes(input.apiType)) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: `Provider ${input.providerId} does not support ${input.apiType}.`,
          });
        }
        yield* providerSessionManager.closeInstance(input.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "provider_configuration_failed",
                message: "Could not stop live sessions before updating the ACP provider.",
                cause,
              }),
          ),
        );
        yield* manager.setProvider({
          cwd: project.workspaceRoot,
          providerId: input.providerId,
          apiType: input.apiType,
          baseUrl: input.baseUrl,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
        });
        yield* providerRegistry.refreshInstance(input.instanceId);
        return { configured: true } as const;
      });

      const disableAcpRegistryProvider = Effect.fn("ws.acpRegistry.disableProvider")(function* (
        input: AcpRegistryDisableProviderInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { manager } = yield* acpSessionManager(input.instanceId);
        const listed = yield* manager.listProviders(project.workspaceRoot);
        const provider = listed.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || provider.required) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message:
              provider === undefined
                ? `Provider ${input.providerId} was not advertised by the ACP agent.`
                : `Provider ${input.providerId} is required and cannot be disabled.`,
          });
        }
        yield* providerSessionManager.closeInstance(input.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "provider_configuration_failed",
                message: "Could not stop live sessions before disabling the ACP provider.",
                cause,
              }),
          ),
        );
        yield* manager.disableProvider({
          cwd: project.workspaceRoot,
          providerId: input.providerId,
        });
        yield* providerRegistry.refreshInstance(input.instanceId);
        return { disabled: true } as const;
      });
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const path = yield* Path.Path;
      // Scratch threads run in a plain folder. Production uses the data dir;
      // the dev runner can select isolated storage outside its checkout.
      // Offer it only when the selected parent is outside any work tree,
      // so it cannot inherit a repository's Git status and checkpoints. Detection failures and
      // defects fail closed and hide the folder, never the config.
      // Probed once per connection: a negative VCS detection is not cached.
      // An interrupt stays an interrupt, so a config load cancelled mid-probe
      // invalidates the cache and the next load probes again.
      // SCIENT-FORK:START — Product policy and environment capability share
      // this advertisement. Scratch retains a real owning project; each
      // thread's registered plain folder is also admitted by Scient's resolver.
      const scratchThreadsOffered = SCIENT_DESKTOP_IDENTITY.projectlessThreadsEnabled;
      const scratchWorkspaceRoot = ServerConfig.scratchWorkspaceRoot(config, path);
      // SCIENT-FORK:END
      const [cachedScratchWorkspaceRoot, invalidateScratchWorkspaceRoot] =
        yield* Effect.cachedInvalidateWithTTL(
          gitWorkflow.isRepository(path.dirname(scratchWorkspaceRoot)).pipe(
            Effect.map((isRepository) =>
              !scratchThreadsOffered || isRepository ? undefined : scratchWorkspaceRoot,
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined),
            ),
          ),
          Duration.infinity,
        );
      const resolveScratchWorkspaceRoot = cachedScratchWorkspaceRoot.pipe(
        Effect.onInterrupt(() => invalidateScratchWorkspaceRoot),
      );

      const fileSystem = yield* FileSystem.FileSystem;
      // Each Scratch thread gets its own folder under the Scratch root, named
      // from its date, first words, and id. It rides in worktreePath like any
      // thread that runs outside its project root, so the provider, terminal,
      // and file tree all use it. Threads that already name a folder keep it.
      // One Scratch project per environment, created the first time a client
      // asks. Two clients racing the create both reach dispatch; the loser's
      // duplicate-root rejection resolves to the project the winner made.
      // The folder is (re)made on every call so a deleted Scratch still runs.
      const ensureScratchProject = Effect.gen(function* () {
        const workspaceRoot = yield* resolveScratchWorkspaceRoot;
        if (workspaceRoot === undefined) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Threads without a project are not available on this environment.",
          });
        }
        yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to create the folder for threads without a project.",
                cause,
              }),
          ),
        );
        const findScratchProjectId = projectService.getByWorkspaceRoot(workspaceRoot).pipe(
          Effect.map(Option.map((project) => project.id)),
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to look up the home for threads without a project.",
                cause,
              }),
          ),
        );
        const existingProjectId = yield* findScratchProjectId;
        if (Option.isSome(existingProjectId)) {
          return { projectId: existingProjectId.value };
        }
        const projectId = ProjectId.make(yield* randomUUID);
        return yield* Effect.gen(function* () {
          yield* projectService.create({
            commandId: yield* serverCommandId("scratch-project-create"),
            projectId,
            title: "No project",
            workspaceRoot,
          });
          yield* projectService.update({
            commandId: yield* serverCommandId("scratch-project-icon"),
            projectId,
            projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
          });
          return { projectId };
        }).pipe(
          Effect.catch((error) =>
            findScratchProjectId.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(error),
                  onSome: (racedProjectId) => Effect.succeed({ projectId: racedProjectId }),
                }),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to create the Scratch project."),
        ),
      );

      // Projects started from just a name live beside Scratch and worktrees,
      // away from folders the user organizes by hand. A nested repository is
      // fine here (unlike Scratch) because each project gets its own `git init`.
      // SCIENT-FORK:START — Scient already creates a project from any typed
      // path ("Create & Add"), and that path also runs Scient's project
      // initialization. Upstream's name-only root skips all of that, so it stays
      // unadvertised until the owner picks between the two paths.
      const newProjectsRoot = SCIENT_DESKTOP_IDENTITY.createProjectFromNameEnabled
        ? path.resolve(config.baseDir, "projects")
        : undefined;
      // SCIENT-FORK:END
      const createNewProject = (input: ProjectCreateNewInput) =>
        Effect.gen(function* () {
          if (newProjectsRoot === undefined) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Starting a project from just a name is not available on this environment.",
            });
          }
          const folder = yield* NewProject.createNewProjectFolder({
            root: newProjectsRoot,
            name: input.name,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to create the project folder.",
                  cause,
                }),
            ),
          );
          const projectId = ProjectId.make(yield* randomUUID);
          yield* Effect.gen(function* () {
            yield* projectService.create({
              commandId: yield* serverCommandId("project-create-new"),
              projectId,
              title: input.name,
              workspaceRoot: folder.workspaceRoot,
            });
          }).pipe(
            // Only a rejected command means no project uses the folder. An
            // interrupt can land after the command is queued, so keep it then.
            Effect.tapError(() =>
              projectService.getById(projectId).pipe(
                Effect.flatMap((project) =>
                  Option.isSome(project)
                    ? Effect.void
                    : fileSystem.remove(folder.workspaceRoot, { recursive: true }),
                ),
                Effect.ignoreCause({ log: true }),
              ),
            ),
          );
          return {
            projectId,
            workspaceRoot: folder.workspaceRoot,
            ...(folder.commitError === undefined ? {} : { commitError: folder.commitError }),
          };
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to create the project."),
          ),
        );

      // Only clients that answer /usage-limits themselves see it in the catalogs;
      // an older client would send the injected command to the provider.
      const loadServerConfig = (options: { readonly usageLimitsCommand: boolean }) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.loadConfigState;
          const currentProviders = projectProvidersForCurrentSession(
            yield* providerRegistry.getProviders,
          );
          const providers = options.usageLimitsCommand
            ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
            : currentProviders;
          const settings = ServerSettings.redactServerSettingsForClient(
            yield* serverSettings.getSettings,
          );
          const environment = yield* serverEnvironment.getDescriptor;
          const auth = yield* serverAuth.getDescriptor();
          const scratchWorkspaceRoot = yield* resolveScratchWorkspaceRoot;
          const availableEditors: ReadonlyArray<EditorId> = yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          );
          const fileManagerRevealKind = availableEditors.includes("file-manager")
            ? yield* resolveFileManagerRevealKindForConfig(
                externalLauncher.resolveFileManagerRevealKind(),
              )
            : undefined;

          return {
            environment,
            auth,
            cwd: config.cwd,
            keybindingsConfigPath: config.keybindingsConfigPath,
            keybindings: keybindingsConfig.keybindings,
            issues: keybindingsConfig.issues,
            providers,
            availableEditors,
            // Same discovery-with-timeout treatment as editors: a slow probe
            // must not stall server.getConfig, so it degrades to no targets.
            remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
              remoteOpenTargets.resolveTargets(),
            ),
            observability: {
              logsDirectoryPath: config.logsDir,
              localTracingEnabled: true,
              ...(config.otlpTracesUrl !== undefined
                ? { otlpTracesUrl: config.otlpTracesUrl }
                : {}),
              otlpTracesEnabled: config.otlpTracesUrl !== undefined,
              ...(config.otlpMetricsUrl !== undefined
                ? { otlpMetricsUrl: config.otlpMetricsUrl }
                : {}),
              otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
              ...(config.otlpLogsUrl !== undefined ? { otlpLogsUrl: config.otlpLogsUrl } : {}),
              otlpLogsEnabled: config.otlpLogsUrl !== undefined,
            },
            settings,
            shellResumeCompletionMarker: true,
            ...(fileManagerRevealKind === undefined
              ? {}
              : {
                  shellRevealInFileManager: true,
                  shellRevealInFileManagerKind: fileManagerRevealKind,
                }),
            threadResumeCompletionMarker: true,
            threadSnapshotPagination: true,
            reasoningMessages: true,
            ...(scratchWorkspaceRoot === undefined ? {} : { scratchWorkspaceRoot }),
            ...(newProjectsRoot === undefined ? {} : { newProjectsRoot }),
          };
        });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const getOrchestrationV2ArchivedShellSnapshot = sql
        .withTransaction(
          Effect.gen(function* () {
            const threads = yield* threadManagement.getShellSnapshot({ location: "archive" });
            return {
              schemaVersion: threads.schemaVersion,
              snapshotSequence: yield* applicationEvents.latestApplicationSequence,
              projects: yield* projectStore.listShells(),
              threads: threads.archivedThreads,
            } as const;
          }),
        )
        .pipe(
          Effect.flatMap((snapshot) =>
            enrichProjectShells(snapshot.projects).pipe(
              Effect.map(({ projects }) => ({ ...snapshot, projects })),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetShellSnapshotError({
                message: "Failed to load archived thread snapshot",
                cause,
              }),
          ),
        );

      const subscribeOrchestrationV2ArchivedShell = Effect.fn(
        "ws.orchestrationV2.subscribeArchivedShell",
      )(function* () {
        const snapshot = yield* getOrchestrationV2ArchivedShellSnapshot;
        const live = threadManagement
          .streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence })
          .pipe(
            Stream.groupedWithin(512, Duration.millis(50)),
            Stream.mapEffect((events) =>
              Effect.forEach(
                coalesceStoredThreadEvents(Array.from(events)),
                (stored) =>
                  threadManagement
                    .getThreadShell(stored.event.threadId)
                    .pipe(
                      Effect.map((shell) =>
                        archivedShellStreamItemFromThreadShell({ stored, shell }),
                      ),
                    ),
                { concurrency: 8 },
              ),
            ),
            Stream.flatMap(Stream.fromIterable),
            Stream.filterMap((item) => (item === null ? Result.failVoid : Result.succeed(item))),
            (stream) => bufferLiveStream(stream),
            Stream.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed while streaming archived threads",
                  cause,
                }),
            ),
          );
        return Stream.concat(rpcInitialItems([{ kind: "snapshot" as const, snapshot }]), live);
      });

      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        return yield* projectMutationOperation(projectService, mutation);
      });

      const handlers0 = WsConversationRpcGroup.of({
        // Retained conversation-fork transport commits native V2 history and effects.
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          isV1OnlyDispatchCommand(command)
            ? observeRpcEffect(
                ORCHESTRATION_WS_METHODS.dispatchCommand,
                command.type === "thread.fork"
                  ? startup.enqueueCommand(conversationForks.dispatch(command)).pipe(
                      Effect.mapError((cause) =>
                        isOrchestrationDispatchCommandError(cause)
                          ? cause
                          : new OrchestrationDispatchCommandError({
                              message: cause.message,
                              cause,
                            }),
                      ),
                    )
                  : Effect.fail(
                      new OrchestrationDispatchCommandError({
                        message: "This legacy command is unsupported. Update the client.",
                      }),
                    ),
                { "rpc.aggregate": "orchestration" },
              )
            : observeRpcEffect(
                ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
                startup
                  .enqueueCommand(
                    ThreadMessageIntake.dispatchCommand(
                      ThreadManagementService.withCreationProvenance(command, {
                        createdBy: "user",
                        creationSource:
                          "creationSource" in command ? command.creationSource : "web",
                      }),
                    ).pipe(Effect.provide(intakeContext)),
                  )
                  .pipe(
                    Effect.tap(() => recordV2ClientCommandAnalytics(command)),
                    Effect.map((result) =>
                      ThreadMessageIntake.dispatchCommandReceipt(command, result),
                    ),
                    Effect.mapError((cause) => dispatchCommandRpcError(command, cause)),
                  ),
                {
                  "rpc.aggregate": "orchestrationV2",
                  "orchestration_v2.command_id": command.commandId,
                  "orchestration_v2.command_type": command.type,
                  "orchestration_v2.thread_id":
                    command.type === "thread.fork" || command.type === "thread.merge_back"
                      ? command.targetThreadId
                      : command.type === "delegated_task.request" ||
                          command.type === "delegated_task.wake-policy" ||
                          command.type === "delegated_task.completion-delivery.acknowledge" ||
                          command.type === "delegated_task.completion-delivery.dispose" ||
                          command.type === "thread.created.record"
                        ? command.parentThreadId
                        : command.threadId,
                  ...(command.type === "thread.fork" || command.type === "thread.merge_back"
                    ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
                    : {}),
                },
              ),
        [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
            readWorkflowScript({ scriptPath: input.scriptPath }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.searchThreads,
            threadSearch.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
            getOrchestrationV2ArchivedShellSnapshot,
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
            // Pre-pagination clients still call this compatibility endpoint.
            // Keep stale clients from materializing an unbounded transcript.
            threadManagement
              .getThreadSnapshotWindow(input.threadId, {
                rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              })
              .pipe(
                Effect.map((snapshot) =>
                  projectThreadProjectionForWire(
                    buildBoundedThreadProjection({
                      projection: snapshot.projection,
                      snapshotSequence: snapshot.snapshotSequence,
                    }).projection,
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to load orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              ),
            {
              "rpc.aggregate": "orchestrationV2",
              "orchestration_v2.thread_id": input.threadId,
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.launchThread,
            startup
              .enqueueCommand(
                ThreadMessageIntake.launchThread({
                  commandId: input.commandId,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  ...(input.reuseExistingThread === undefined
                    ? {}
                    : { reuseExistingThread: input.reuseExistingThread }),
                  projectId: input.projectId,
                  title: input.title,
                  ...(input.generateTitle === undefined
                    ? {}
                    : { generateTitle: input.generateTitle }),
                  modelSelection: input.modelSelection,
                  runtimeMode: input.runtimeMode,
                  interactionMode: input.interactionMode,
                  workspaceStrategy: input.workspaceStrategy,
                  ...(input.initialMessage === undefined
                    ? {}
                    : {
                        initialMessage: {
                          ...(input.initialMessage.messageId === undefined
                            ? {}
                            : { messageId: input.initialMessage.messageId }),
                          text: input.initialMessage.text,
                          attachments: input.initialMessage.attachments,
                          ...(input.initialMessage.context === undefined
                            ? {}
                            : { context: input.initialMessage.context }),
                        },
                      }),
                  createdBy: "user",
                  creationSource: input.creationSource ?? "web",
                }).pipe(Effect.provide(intakeContext)),
              )
              .pipe(
                Effect.tap(() =>
                  analytics
                    .record("client.thread.started", originProps)
                    .pipe(
                      Effect.andThen(
                        input.initialMessage === undefined
                          ? Effect.void
                          : analytics.record("client.turn.requested", originProps),
                      ),
                      Effect.ignore,
                    ),
                ),
                Effect.map((result) => ({
                  ...result,
                  projection: projectThreadProjectionForWire(result.projection),
                })),
                Effect.catchTags({
                  AttachmentClaimError: (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: cause.message,
                      cause,
                    }),
                  ThreadLaunchError: (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: "Failed to launch thread",
                      cause,
                    }),
                  ServerRuntimeStartupError: (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: "Failed to launch thread",
                      cause,
                    }),
                }),
              ),
            {
              "rpc.aggregate": "orchestration",
              "orchestration_v2.command_id": input.commandId,
              "orchestration_v2.project_id": input.projectId,
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
            subscribeOrchestrationV2ArchivedShell(),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_V2_WS_METHODS.subscribeShell,
            subscribeOrchestrationV2Shell(input),
            {
              "rpc.aggregate": "orchestrationV2",
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_V2_WS_METHODS.subscribeThread,
            subscribeOrchestrationV2Thread(input),
            {
              "rpc.aggregate": "orchestrationV2",
              "orchestration_v2.thread_id": input.threadId,
            },
          ),
        [WS_METHODS.scheduledTasksList]: (_input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksList, scheduledTasks.list(), {
            "rpc.aggregate": "scheduledTasks",
          }),
        [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
          observeRpcStream(WS_METHODS.scheduledTasksSubscribe, scheduledTasks.subscribeList(), {
            "rpc.aggregate": "scheduledTasks",
          }),
        [WS_METHODS.scheduledTasksUpsert]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksUpsert, scheduledTasks.upsert(input), {
            "rpc.aggregate": "scheduledTasks",
          }),
        [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksSetEnabled, scheduledTasks.setEnabled(input), {
            "rpc.aggregate": "scheduledTasks",
            "scheduled_task.id": input.id,
          }),
        [WS_METHODS.scheduledTasksDelete]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksDelete, scheduledTasks.delete(input), {
            "rpc.aggregate": "scheduledTasks",
            "scheduled_task.id": input.id,
          }),
        [WS_METHODS.scheduledTasksRunNow]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksRunNow, scheduledTasks.runNow(input), {
            "rpc.aggregate": "scheduledTasks",
            "scheduled_task.id": input.id,
          }),
        [WS_METHODS.serverSearchAcpRegistry]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSearchAcpRegistry,
            acpRegistryCatalog
              .search(input)
              .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverPrepareAcpRegistryAgent]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverPrepareAcpRegistryAgent,
            acpRegistryCatalog
              .prepare(input)
              .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
            {
              "rpc.aggregate": "server",
              "acp_registry.agent_id": input.agentId,
            },
          ),
        [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUninstallAcpRegistryManagedBinary,
            serverSettings
              .withSettingsSnapshot((settings) =>
                acpRegistryCatalog.uninstallManagedBinary(
                  input,
                  Effect.succeed(
                    Object.values(settings.providerInstances).some((instance) => {
                      if (
                        instance.driver !== "acpRegistry" ||
                        instance.config === null ||
                        typeof instance.config !== "object"
                      ) {
                        return false;
                      }
                      return (instance.config as Record<string, unknown>).agentId === input.agentId;
                    }),
                  ),
                ),
              )
              .pipe(
                Effect.mapError((cause) =>
                  AcpRegistrySupport.isAcpRegistryError(cause)
                    ? cause
                    : new AcpRegistrySupport.AcpRegistryError({
                        reason: "install_failed",
                        detail: `Could not read provider settings while checking references for ACP Registry agent ${input.agentId}.`,
                        cause,
                      }),
                ),
                Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError),
              ),
            {
              "rpc.aggregate": "server",
              "acp_registry.agent_id": input.agentId,
            },
          ),
        [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverAcceptAcpRegistryUrlAuth,
            acpRegistryRuntimeCoordinator
              .acceptUrlAuthentication(input)
              .pipe(Effect.map((accepted) => ({ accepted }))),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
            },
          ),
        [WS_METHODS.serverListAcpRegistrySessions]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverListAcpRegistrySessions,
            listAcpRegistrySessions(input),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
              "project.id": input.projectId,
            },
          ),
        [WS_METHODS.serverImportAcpRegistrySession]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverImportAcpRegistrySession,
            importAcpRegistrySession(input),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
              "project.id": input.projectId,
            },
          ),
        [WS_METHODS.serverDeleteAcpRegistrySession]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverDeleteAcpRegistrySession,
            deleteAcpRegistrySession(input),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
              "project.id": input.projectId,
            },
          ),
        [WS_METHODS.serverListAcpRegistryProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverListAcpRegistryProviders,
            listAcpRegistryProviders(input),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
              "project.id": input.projectId,
            },
          ),
        [WS_METHODS.serverSetAcpRegistryProvider]: (input) =>
          observeRpcEffect(WS_METHODS.serverSetAcpRegistryProvider, setAcpRegistryProvider(input), {
            "rpc.aggregate": "server",
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }),
        [WS_METHODS.serverDisableAcpRegistryProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverDisableAcpRegistryProvider,
            disableAcpRegistryProvider(input),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
              "project.id": input.projectId,
            },
          ),
        [WS_METHODS.serverLogoutAcpRegistry]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverLogoutAcpRegistry,
            Effect.gen(function* () {
              const { instance, manager } = yield* acpSessionManager(input.instanceId);
              const snapshot = yield* instance.snapshot.getSnapshot;
              if (snapshot.auth.canLogout !== true) {
                return yield* new AcpRegistryOperationError({
                  reason: "logout_unsupported",
                  message: "The ACP agent does not advertise logout.",
                });
              }
              if (instance.auth) {
                yield* providerAuth.logout(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AcpRegistryOperationError({
                        reason: "logout_failed",
                        message: "Could not sign out of the ACP agent.",
                        cause,
                      }),
                  ),
                );
              } else {
                yield* providerSessionManager.closeInstance(input.instanceId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AcpRegistryOperationError({
                        reason: "logout_failed",
                        message: "Could not stop live sessions before ACP logout.",
                        cause,
                      }),
                  ),
                );
                yield* manager.logout(config.cwd);
              }
              yield* providerRegistry.refreshInstance(input.instanceId);
              return { loggedOut: true } as const;
            }),
            {
              "rpc.aggregate": "server",
              "provider.instance_id": input.instanceId,
            },
          ),
        [WS_METHODS.projectsMutate]: (mutation) =>
          observeRpcEffect(
            WS_METHODS.projectsMutate,
            startup.enqueueCommand(mutateProject(mutation)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectMutationError({
                    commandId: mutation.commandId,
                    message:
                      cause._tag === "ProjectNotEmptyError"
                        ? cause.message
                        : "Failed to mutate project.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.assetsPersistChatAttachments]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsPersistChatAttachments,
            persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getForkOptions]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getForkOptions,
            conversationForks
              .getOptions(input)
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestrationGetSnapshotError({ message: cause.message, cause }),
                ),
              ),
            { "rpc.aggregate": "orchestration" },
          ),
      });

      const handlers1 = WsServerManagementRpcGroup.of({
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetConfig,
            loadServerConfig({ usageLimitsCommand: false }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            Effect.gen(function* () {
              // Only explicit catalog refreshes bypass T3's caches. Workspace
              // discovery and background status checks retain their timers.
              if (input.refreshModels) {
                yield* modelManifest.forceRefresh;
                const instances = yield* providerInstances.listInstances;
                yield* Effect.forEach(
                  instances.filter(
                    (instance) =>
                      input.instanceId === undefined || input.instanceId === instance.instanceId,
                  ),
                  (instance) =>
                    Effect.gen(function* () {
                      yield* instance.invalidateCaches ?? Effect.void;
                      const maintenance = yield* instance.snapshot.resolveMaintenance({
                        fresh: true,
                      });
                      if (maintenance.packageName)
                        providerVersionCache.delete(maintenance.packageName);
                      if (maintenance.homebrewApiUrl)
                        providerVersionCache.delete(maintenance.homebrewApiUrl);
                    }),
                  { concurrency: "unbounded", discard: true },
                );
              }
              if (input.refreshManagedRuntimeCatalog === true) {
                // An explicit runtime refresh re-checks a runtime that fell back
                // after a failed check; switching back waits for running work.
                const reselectInstances = yield* providerInstances.listInstances;
                yield* Effect.forEach(
                  reselectInstances.filter(
                    (instance) =>
                      input.instanceId === undefined || input.instanceId === instance.instanceId,
                  ),
                  (instance) =>
                    providerRuntimeManager.reselect(instance.instanceId).pipe(Effect.forkDetach),
                  { discard: true },
                );
                const before = yield* managedRuntimeCatalog.current;
                const after = yield* managedRuntimeCatalog.refreshNow;
                const changedProviders = ManagedRuntimeCatalog.changedManagedRuntimeProviders(
                  before,
                  after,
                );
                if (changedProviders.length > 0) {
                  // Refresh publishes an async event for the process
                  // reconciler. Reconcile here too so this explicit RPC
                  // returns new actions without a UI race.
                  yield* reconcileManagedRuntimeProviders(changedProviders);
                }
              }
              // An untargeted refresh is "re-read everything's status", which
              // includes quota from configured usage-limit sources. Awaited,
              // not forked: the RPC scope closes on return and would
              // interrupt a fork before the hub answered.
              if (input.instanceId === undefined) {
                yield* usageLimitSources.refresh;
              }
              let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
                ? providerRegistry.refreshWorkspaceSnapshot({
                    instanceId: input.instanceId,
                    cwd: input.cwd,
                    fresh: input.fresh === true,
                  })
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
              if (input.refreshModels) {
                const instances = yield* providerInstances.listInstances;
                for (const instance of instances) {
                  if (
                    !instance.refreshModels ||
                    (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                    !providers.some(
                      (provider) =>
                        provider.instanceId === instance.instanceId &&
                        provider.enabled &&
                        provider.installed,
                    )
                  )
                    continue;
                  yield* instance.refreshModels().pipe(
                    Effect.mapError(
                      (error) =>
                        new ProviderSetupError({
                          instanceId: instance.instanceId,
                          operation: "refresh-models",
                          detail: error.detail,
                        }),
                    ),
                  );
                  providers = yield* providerRegistry.refreshInstance(instance.instanceId);
                }
              }
              return { providers };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.providerSkillsSetEnabled]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerSkillsSetEnabled,
            providerSkillManagement.setEnabled(input),
            { "rpc.aggregate": "skills" },
          ),
        [WS_METHODS.voiceCorrectTranscript]: (input) =>
          observeRpcEffect(
            WS_METHODS.voiceCorrectTranscript,
            voiceTranscriptCorrection.correct(input),
            { "rpc.aggregate": "voice" },
          ),
        [WS_METHODS.providerUploadFeedback]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUploadFeedback,
            Effect.gen(function* () {
              const projection = yield* threadManagement.getThreadRecords(input.threadId, [
                "providerThreads",
              ]);
              const providerThread =
                projection.providerThreads.find(
                  (candidate) => candidate.id === projection.thread.activeProviderThreadId,
                ) ?? projection.providerThreads.at(-1);
              const providerSessionId = providerThread?.providerSessionId ?? null;
              if (providerThread === undefined || providerSessionId === null) {
                return yield* Effect.fail(
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause: "No provider session has run in this thread yet.",
                  }),
                );
              }
              const runtime = Option.getOrNull(yield* providerSessionsV2.get(providerSessionId));
              if (runtime === null) {
                return yield* Effect.fail(
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause: "The provider session is no longer running. Send a message first.",
                  }),
                );
              }
              if (runtime.uploadFeedback === undefined) {
                return yield* Effect.fail(
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause: `Provider '${runtime.driver}' does not support feedback uploads.`,
                  }),
                );
              }
              return yield* runtime.uploadFeedback({
                providerThread,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              });
            }).pipe(
              Effect.mapError((cause) =>
                isProviderUploadFeedbackError(cause)
                  ? cause
                  : new ProviderUploadFeedbackError({
                      threadId: input.threadId,
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverStartProviderConnection]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverStartProviderConnection,
            providerConnectionManager.start(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCancelProviderConnection]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCancelProviderConnection,
            providerConnectionManager.cancel(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSubmitProviderAuthorizationCode]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSubmitProviderAuthorizationCode,
            providerConnectionManager.submitAuthorizationCode(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverDisconnectProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverDisconnectProvider,
            providerConnectionManager.disconnect(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverPlanProviderRuntime]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverPlanProviderRuntime,
            providerRuntimeManager.plan(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverStartProviderRuntime]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverStartProviderRuntime,
            providerRuntimeManager.start(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCancelProviderRuntime]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCancelProviderRuntime,
            providerRuntimeManager.cancel(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.providerConsumeResetCredit]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerConsumeResetCredit,
            Effect.gen(function* () {
              if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
              const instance = yield* providerInstances.getInstance(input.instanceId);
              // A disabled instance must not spend anything on its account.
              if (instance === undefined || !instance.enabled) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: instance ? "This provider is disabled." : "Provider instance not found.",
                });
              }
              if (instance.consumeResetCredit === undefined) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: "This provider does not bank reset credits.",
                });
              }
              const outcome = yield* instance.consumeResetCredit().pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderSetupError({
                      instanceId: input.instanceId,
                      operation: "consume-reset-credit",
                      detail: error.detail,
                      cause: error,
                    }),
                ),
              );
              return { outcome };
            }),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthStart,
            providerAuth.start(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthRespond,
            providerAuth.respond(input, currentSessionId),
            {
              "rpc.aggregate": "provider",
              instanceId: input.instanceId,
            },
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthComplete,
            providerAuth.complete(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.chatGptReconnectProfile]: (input) =>
          rejectCodexSubscriptionSharing(input.instanceId, "export"),
        [WS_METHODS.chatGptImportProfile]: (input) =>
          rejectCodexSubscriptionSharing(input.instanceId, "import"),
        [WS_METHODS.chatGptHandoffSubscribe]: (input) =>
          Stream.fromEffect(rejectCodexSubscriptionSharing(input.instanceId, "handoff")),
        [WS_METHODS.codexAuthCallbackSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.codexAuthCallbackSubscribe,
            Stream.fromEffect(rejectCodexSubscriptionSharing(input.instanceId, "callback")),
            {
              "rpc.aggregate": "provider",
            },
          ),
        [WS_METHODS.providerAuthCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthCancel,
            providerAuth.cancel(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthLogout]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthLogout, providerAuth.logout(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerAuthSubscribe,
            providerAuth.subscribe(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallStart, providerInstallation.start(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallCancel]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallCancel, providerInstallation.cancel(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerInstallSubscribe,
            providerInstallation.subscribe(input),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallRemove]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallRemove, providerInstallation.remove(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverSelfUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverSelfUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCommitDesktopUpdate,
            serverSelfUpdate.commitDesktopUpdate(input.requestId),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSaveCustomModel]: (input) => serverSettings.saveCustomModel(input),
        [WS_METHODS.serverRemoveCustomModel]: (input) => serverSettings.removeCustomModel(input),
        [WS_METHODS.serverTestCustomModel]: (input) =>
          Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings;
            if (settings.customModels.revision !== input.revision)
              return yield* new CustomModelError({
                message: "Custom models changed. Test the updated configuration.",
              });
            const connection = settings.customModels.connections.find(
              (c) => c.id === input.connectionId,
            );
            const model = connection?.models.find((m) => m.id === input.modelId);
            const instance = yield* providerInstances.getInstance(input.instanceId);
            if (
              !connection ||
              !model ||
              !model.instanceIds.includes(input.instanceId) ||
              !instance?.enabled ||
              !supportsModelConnections(instance.driverKind, connection.protocol)
            )
              return yield* new CustomModelError({
                message:
                  "Connect this model to an enabled Pi, Droid, Oh My Pi, or Scient agent first.",
              });
            const resolved = yield* serverSettings.resolveCustomModels(input.instanceId);
            const credentialError = resolved.find((c) => c.id === connection.id)?.credentialError;
            if (credentialError !== undefined)
              return yield* new CustomModelError({ message: credentialError });
            const slug =
              instance.driverKind === "droid"
                ? droidCustomModelId(connection.id, model.id)
                : instance.driverKind === "omp" || instance.driverKind === "scient"
                  ? encodeOmpModelSlug(customModelProviderId(connection.id), model.modelId)
                  : encodePiModelSlug(customModelProviderId(connection.id), model.modelId);
            if (!slug) return yield* new CustomModelError({ message: "Invalid model ID." });
            yield* instance.textGeneration
              .generateThreadTitle({
                cwd: config.cwd,
                message: "Connection test",
                modelSelection: createModelSelection(input.instanceId, slug),
              })
              .pipe(
                Effect.timeout(Duration.seconds(CUSTOM_MODEL_TEST_TIMEOUT_SECONDS)),
                Effect.mapError((cause) => customModelTestFailure(instance, cause)),
              );
            const latest = yield* serverSettings.getSettings;
            if (latest.customModels.revision !== input.revision)
              return yield* new CustomModelError({
                message: "Custom models changed during the test. Test again.",
              });
            return { revision: input.revision };
          }).pipe(
            Effect.catchTag("ServerSettingsError", () =>
              Effect.fail(new CustomModelError({ message: "Could not read custom models." })),
            ),
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch, providerInstanceMutation }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            Effect.gen(function* () {
              const deviceHosts = patch.deviceHosts
                ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(
                    Effect.provide(deviceHostContext),
                  )
                : undefined;
              const nextPatch = { ...patch, ...(deviceHosts ? { deviceHosts } : {}) };
              const settings = yield* providerInstanceMutation === undefined
                ? serverSettings.updateSettings(nextPatch)
                : serverSettings.updateProviderInstance(providerInstanceMutation, nextPatch);
              return ServerSettings.redactServerSettingsForClient(settings);
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.skillsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.skillsList,
            Effect.gen(function* () {
              const projectRoot = yield* resolveScientSkillProjectRoot(input);
              return yield* scientSkillManagement.list(projectRoot);
            }),
            { "rpc.aggregate": "skills" },
          ),
        [WS_METHODS.skillsReadDocument]: (input) =>
          observeRpcEffect(
            WS_METHODS.skillsReadDocument,
            scientSkillManagement.readDocument(input.releaseKey),
            { "rpc.aggregate": "skills" },
          ),
        [WS_METHODS.skillsSetProjectPreference]: (input) =>
          observeRpcEffect(
            WS_METHODS.skillsSetProjectPreference,
            Effect.gen(function* () {
              const projectRoot = yield* resolveScientSkillProjectRoot({
                projectId: input.projectId,
              });
              if (!projectRoot) {
                return yield* skillContextError(
                  "setProjectPreference",
                  "That project has no workspace.",
                );
              }
              return yield* scientSkillManagement.setProjectPreference({
                projectRoot,
                name: input.name,
                active: input.active,
                invocationPolicy: input.invocationPolicy,
              });
            }),
            { "rpc.aggregate": "skills" },
          ),
        [WS_METHODS.skillsSetUserActivation]: (input) =>
          observeRpcEffect(
            WS_METHODS.skillsSetUserActivation,
            scientSkillManagement.setUserActivation(input),
            { "rpc.aggregate": "skills" },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetHostResources]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetHostResources, hostResources.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetUsageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.serverGetUsageSummary, usage.readSummary(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshUsageRates]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRefreshUsageRates, usage.refreshRates, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
      });

      const handlers2 = WsRepositoryRpcGroup.of({
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsListStats]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsListStats, pullRequests.listStats(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsRoutingIdentity]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRoutingIdentity,
            pullRequests.routingIdentity(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsRouting]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsRouting, pullRequests.routing(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSummary,
            withPullRequestViewer(input, pullRequests.summary(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsStack]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsStack,
            withPullRequestViewer(input, pullRequests.stack(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsLinkedThreads,
            resolvePullRequestSyncKey(input).pipe(
              Effect.flatMap((key) =>
                key === null
                  ? Effect.succeed({ threads: [] })
                  : listLinkedPullRequestThreads(key).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    ),
              ),
            ),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDetail,
            withPullRequestViewer(input, pullRequests.detail(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsPreview]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsPreview,
            withPullRequestViewer(input, pullRequests.preview(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsChecks]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsChecks,
            withPullRequestViewer(input, pullRequests.checks(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsActivity,
            withPullRequestViewer(input, pullRequests.activity(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsThreadComments,
            withPullRequestViewer(input, pullRequests.threadComments(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDiffFileContents,
            withPullRequestViewer(input, pullRequests.diffFileContents(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsFilesViewed]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsFilesViewed,
            withPullRequestViewer(input, pullRequests.filesViewed(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetFilesViewed,
            withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRunAction,
            withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
              Effect.tap(() =>
                resolvePullRequestSyncKey(input).pipe(
                  Effect.flatMap((key) =>
                    key === null ? Effect.void : pullRequestSync.requestSync(key),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdate,
            withPullRequestViewer(input, pullRequests.update(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsComment,
            withPullRequestViewer(input, pullRequests.comment(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdateComment,
            withPullRequestViewer(input, pullRequests.updateComment(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSubmitReview,
            withPullRequestViewer(input, pullRequests.submitReview(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            withPullRequestViewer(input, pullRequests.replyToThread(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetReaction,
            withPullRequestViewer(input, pullRequests.setReaction(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsInvalidate,
            pullRequests.invalidate(input, { notifyReaders: true }).pipe(
              // A reader asking for fresh host state also wants the thread badges it feeds to
              // catch up, including a merged link the sweep would otherwise never revisit.
              Effect.andThen(
                input.reference === undefined || input.filesViewedOnly === true
                  ? Effect.void
                  : resolvePullRequestSyncKey(input.reference).pipe(
                      Effect.flatMap((key) =>
                        key === null ? Effect.void : pullRequestSync.requestSync(key),
                      ),
                    ),
              ),
            ),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
          observeRpcStream(
            WS_METHODS.pullRequestsSubscribeRefreshes,
            pullRequests.subscribeRefreshes,
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            withPullRequestViewer(input, pullRequests.requestReviewers(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsLabelCandidates,
            withPullRequestViewer(input, pullRequests.labelCandidates(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetLabels,
            withPullRequestViewer(input, pullRequests.setLabels(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectCloneStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectCloneStart,
            projectCloneTracker.start(input, {
              createProject: (project) =>
                Effect.gen(function* () {
                  yield* projectService.create({
                    commandId: yield* serverCommandId("project-clone-create"),
                    projectId: project.projectId,
                    title: project.title,
                    workspaceRoot: project.workspaceRoot,
                    createWorkspaceRootIfMissing: true,
                  });
                }).pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to register the cloned project."),
                  ),
                ),
              onCloned: (project) =>
                // The project was created against an empty directory, so its
                // cached identity is "not a repository" until this refresh.
                // Re-emitting the project shell carries the new identity to
                // every client without a round trip.
                projectEnrichment.invalidate([project.workspaceRoot]).pipe(
                  Effect.andThen(
                    repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }),
                  ),
                  Effect.andThen(
                    Effect.gen(function* () {
                      yield* projectService.update({
                        commandId: yield* serverCommandId("project-clone-done"),
                        projectId: project.projectId,
                      });
                    }),
                  ),
                  Effect.andThen(refreshGitStatus(project.workspaceRoot)),
                  Effect.ignoreCause({ log: true }),
                ),
            }),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.projectsEnsureScratch]: () =>
          observeRpcEffect(WS_METHODS.projectsEnsureScratch, ensureScratchProject, {
            "rpc.aggregate": "orchestration",
          }),
        [WS_METHODS.projectsCreateNew]: (input) =>
          observeRpcEffect(WS_METHODS.projectsCreateNew, createNewProject(input), {
            "rpc.aggregate": "orchestration",
          }),
        [WS_METHODS.projectCloneCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectCloneCancel,
            projectCloneTracker
              .cancel(input.projectId)
              .pipe(Effect.map((applied) => ({ applied }))),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.projectCloneRetry]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectCloneRetry,
            projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.subscribeProjectClones]: () =>
          observeRpcStream(WS_METHODS.subscribeProjectClones, projectCloneTracker.stream, {
            "rpc.aggregate": "source-control",
          }),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories.publishRepository(input).pipe(
              // A new remote can change the cached identity. Only the `cwd` entry
              // refreshes, so after a publish from a linked worktree the project
              // root entry waits for its TTL.
              Effect.tap(() => repositoryIdentityResolver.resolve(input.cwd, { refresh: true })),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListDirectory]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListDirectory,
            workspaceEntries.listDirectory(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListDirectoryError({
                    ...input,
                    ...projectDirectoryFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            // The viewer's read: a file is shown wherever it lives, read-only
            // outside the project. Every other feature reads with readFile.
            workspaceFileSystem.viewFile(input).pipe(
              Effect.map((result) => ({
                ...result,
                readOnly:
                  result.readOnly === true ||
                  workspaceEntryDisposition(result.relativePath).mutation === "owner",
              })),
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSubscribeFileChanges]: (input) =>
          observeRpcStream(
            WS_METHODS.projectsSubscribeFileChanges,
            workspaceFileSystem.watchFile(input).pipe(
              Stream.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeDocumentBindingChanges]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDocumentBindingChanges,
            generatedDocuments.changes.pipe(
              Stream.filter(
                (change) =>
                  change.authority === input.authority &&
                  change.logicalDocumentKey === input.logicalDocumentKey,
              ),
            ),
            { "rpc.aggregate": "document-artifacts" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            Effect.gen(function* () {
              const target = yield* workspaceFileSystem.inspectWriteTarget(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectWriteFileError({
                      cwd: input.cwd,
                      relativePath: input.relativePath,
                      ...projectFileFailureContext(cause),
                      cause,
                    }),
                ),
              );
              const requestedDisposition = workspaceEntryDisposition(target.relativePath);
              const canonicalDisposition = workspaceEntryDisposition(target.canonicalRelativePath);
              if (
                target.traversesSymlink ||
                requestedDisposition.mutation === "owner" ||
                canonicalDisposition.mutation === "owner"
              ) {
                return yield* new ProjectWriteFileError({
                  cwd: input.cwd,
                  relativePath: target.relativePath,
                  failure: "read_only_in_files",
                });
              }
              return yield* workspaceFileSystem.writeFile(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectWriteFileError({
                      cwd: input.cwd,
                      relativePath: input.relativePath,
                      ...projectFileFailureContext(cause),
                      cause,
                    }),
                ),
              );
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsRenameFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsRenameFile,
            workspaceFileSystem.renameFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectRenameFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    destinationRelativePath: input.destinationRelativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.analysisInspectRuntimes]: (input) =>
          observeRpcEffect(WS_METHODS.analysisInspectRuntimes, analysis.inspectRuntimes(input), {
            "rpc.aggregate": "analysis",
          }),
      });

      const handlers3 = WsScientificRpcGroup.of({
        [WS_METHODS.analysisConfigureRuntime]: (input) =>
          observeRpcEffect(WS_METHODS.analysisConfigureRuntime, analysis.configureRuntime(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisVerifyRuntime]: (input) =>
          observeRpcEffect(WS_METHODS.analysisVerifyRuntime, analysis.verifyRuntime(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisStartRun]: (input) =>
          observeRpcEffect(WS_METHODS.analysisStartRun, analysis.startRun(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisCancelRun]: (input) =>
          observeRpcEffect(WS_METHODS.analysisCancelRun, analysis.cancelRun(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisListRuns]: (input) =>
          observeRpcEffect(WS_METHODS.analysisListRuns, analysis.listRuns(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisGetRun]: (input) =>
          observeRpcEffect(WS_METHODS.analysisGetRun, analysis.getRun(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisStorageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.analysisStorageSummary, analysis.storageSummary(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisCleanupRun]: (input) =>
          observeRpcEffect(WS_METHODS.analysisCleanupRun, analysis.cleanupRun(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisCleanupProject]: (input) =>
          observeRpcEffect(WS_METHODS.analysisCleanupProject, analysis.cleanupProject(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.analysisPromoteRun]: (input) =>
          observeRpcEffect(WS_METHODS.analysisPromoteRun, analysis.promoteRun(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.subscribeAnalysisRuns]: (input) =>
          observeRpcStreamEffect(WS_METHODS.subscribeAnalysisRuns, analysis.subscribeRuns(input), {
            "rpc.aggregate": "analysis",
          }),
        [WS_METHODS.computeInspectRuntimes]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeInspectRuntimes,
            computeGateway.inspectRuntimes(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.computeRuntimeInventory]: () =>
          observeRpcEffect(WS_METHODS.computeRuntimeInventory, computeGateway.runtimeInventory(), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeVerifyRuntime]: (input) =>
          observeRpcEffect(WS_METHODS.computeVerifyRuntime, computeGateway.verifyRuntime(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeManagedRuntimeStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeManagedRuntimeStatus,
            computeGateway.managedRuntimeStatus(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.computeManageRuntime]: (input) =>
          observeRpcEffect(WS_METHODS.computeManageRuntime, computeGateway.manageRuntime(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeCancelManagedRuntime]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeCancelManagedRuntime,
            computeGateway.cancelManagedRuntime(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.computeStartSession]: (input) =>
          observeRpcEffect(WS_METHODS.computeStartSession, computeGateway.startSession(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeListSessions]: (input) =>
          observeRpcEffect(WS_METHODS.computeListSessions, computeGateway.listSessions(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeGetSession]: (input) =>
          observeRpcEffect(WS_METHODS.computeGetSession, computeGateway.getSession(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeRestartSession]: (input) =>
          observeRpcEffect(WS_METHODS.computeRestartSession, computeGateway.restartSession(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeStopSession]: (input) =>
          observeRpcEffect(WS_METHODS.computeStopSession, computeGateway.stopSession(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeSubmitExecution]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeSubmitExecution,
            computeGateway.submitExecution(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.computeCancelExecution]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeCancelExecution,
            computeGateway.cancelExecution(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.computeInterruptSession]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeInterruptSession,
            computeGateway.interruptSession(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.computeListExecutions]: (input) =>
          observeRpcEffect(WS_METHODS.computeListExecutions, computeGateway.listExecutions(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeListOutputs]: (input) =>
          observeRpcEffect(WS_METHODS.computeListOutputs, computeGateway.listOutputs(input), {
            "rpc.aggregate": "compute",
          }),
        [WS_METHODS.computeInspectVariables]: (input) =>
          observeRpcEffect(
            WS_METHODS.computeInspectVariables,
            computeGateway.inspectVariables(input),
            { "rpc.aggregate": "compute" },
          ),
        [WS_METHODS.subscribeComputeSessions]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeComputeSessions,
            computeGateway.subscribeSessions(input),
            { "rpc.aggregate": "compute" },
          ),
      });

      const handlers4 = WsWorkspaceRpcGroup.of({
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.filesystemPrepareFileOpen]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemPrepareFileOpen,
            prepareEnvironmentFileOpen(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.filesystemResolveFileLink]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemResolveFileLink,
            resolveEnvironmentFileLink(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.filesystemSubscribeFileChanges]: (input) =>
          observeRpcStream(WS_METHODS.filesystemSubscribeFileChanges, watchEnvironmentFile(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.documentsPublishBrowserPdfExport]: (input) =>
          observeRpcEffect(
            WS_METHODS.documentsPublishBrowserPdfExport,
            publishBrowserPdfExport(generatedDocuments, input),
            { "rpc.aggregate": "documents" },
          ),
        [WS_METHODS.documentsPrepareMarkdownPdf]: (input) =>
          observeRpcEffect(WS_METHODS.documentsPrepareMarkdownPdf, prepareMarkdownPdf(input), {
            "rpc.aggregate": "documents",
          }),
        [WS_METHODS.documentsPrepareConversationPdf]: (input) =>
          observeRpcEffect(
            WS_METHODS.documentsPrepareConversationPdf,
            prepareConversationPdf(input).pipe(
              Effect.provideService(ConversationExportService, conversationExports),
            ),
            { "rpc.aggregate": "documents" },
          ),
        [WS_METHODS.documentsPublishDocumentPdf]: (input) =>
          observeRpcEffect(
            WS_METHODS.documentsPublishDocumentPdf,
            publishCapturedDocumentPdf(input).pipe(
              Effect.provideService(
                GeneratedDocumentStore.GeneratedDocumentStore,
                generatedDocuments,
              ),
            ),
            { "rpc.aggregate": "documents" },
          ),
        [WS_METHODS.documentsReleaseDocumentPdf]: (input) =>
          observeRpcEffect(
            WS_METHODS.documentsReleaseDocumentPdf,
            removeDocumentCapture(input.captureId),
            { "rpc.aggregate": "documents" },
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) =>
          observeRpcEffect(WS_METHODS.attachmentsCreateUploadUrl, issueAttachmentUploadUrl(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.attachmentsDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.attachmentsDelete,
            deletePendingAttachment(input.attachmentId),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.agentSessionsScan]: () =>
          observeRpcEffect(WS_METHODS.agentSessionsScan, agentSessionScanner.scan, {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.agentSessionsImport]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentSessionsImport,
            agentSessionImporter.importRecentAgentThreads(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              const path = yield* Path.Path;
              if (input.resource._tag === "analysis-artifact") {
                const analysisArtifact = yield* analysis.resolveArtifact(input.resource).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetAnalysisArtifactResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
                if (analysisArtifact === null) {
                  return yield* new AssetAnalysisArtifactNotFoundError({
                    resource: input.resource,
                  });
                }
                return yield* issueAssetUrl({ resource: input.resource, analysisArtifact });
              }
              if (input.resource._tag === "compute-output") {
                const computeOutput = yield* compute.resolveOutputResource(input.resource).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetComputeOutputResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
                // An image whose bytes are gone or no longer hash to what was
                // asked for is not an image: a session's transcript outlives
                // the files it points at, so this is an ordinary outcome
                // rather than a fault.
                if (computeOutput === null) {
                  return yield* new AssetComputeOutputNotFoundError({
                    resource: input.resource,
                  });
                }
                return yield* issueAssetUrl({ resource: input.resource, computeOutput });
              }
              if (input.resource._tag === "generated-document") {
                const retained = yield* generatedDocuments
                  .resolveRevisionForAsset(input.resource)
                  .pipe(
                    Effect.mapError((cause) => {
                      if (cause.reason === "authority-mismatch") {
                        return new AssetGeneratedDocumentAuthorityMismatchError({
                          resource: input.resource,
                        });
                      }
                      if (cause.reason === "missing-revision") {
                        return new AssetGeneratedDocumentNotFoundError({
                          resource: input.resource,
                        });
                      }
                      return new AssetGeneratedDocumentResolutionError({
                        resource: input.resource,
                        cause,
                      });
                    }),
                  );
                return yield* issueAssetUrl({
                  resource: input.resource,
                  generatedDocument: retained.document,
                  generatedDocumentExpiresAtEpochMs: retained.expiresAtEpochMs,
                });
              }
              // An absolute media path can be linked from a thread on another environment.
              if (
                input.resource._tag === "attachment" ||
                input.resource._tag === "native-app-icon" ||
                // GitHub media names the repository it authenticates through itself.
                input.resource._tag === "github-media" ||
                (input.resource._tag === "media-file" && path.isAbsolute(input.resource.path))
              ) {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (
                input.resource._tag === "environment-file" ||
                input.resource._tag === "media-file"
              ) {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource._tag === "draft-workspace-file") {
                // A project draft names its workspace directly; there is no
                // thread to resolve one from.
                return yield* issueAssetUrl({
                  resource: input.resource,
                  workspaceRoot: input.resource.cwd,
                });
              }
              if (input.resource._tag === "project-favicon") {
                const project = yield* projectStore
                  .findActiveByWorkspaceRoot(input.resource.cwd)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new AssetWorkspaceContextResolutionError({
                          resource: input.resource,
                          cause,
                        }),
                    ),
                  );
                if (Option.isNone(project)) {
                  return yield* new AssetWorkspaceContextNotFoundError({
                    resource: input.resource,
                  });
                }
                // A cloned project exists before its files do. Clients ask again
                // when the clone lands (see createProjectFaviconUrlAtomFamily).
                const clone = yield* projectCloneTracker.get(project.value.projectId);
                return yield* issueAssetUrl({
                  resource: input.resource,
                  ...(project.value.faviconPath
                    ? { projectFaviconPath: project.value.faviconPath }
                    : {}),
                  projectCheckoutPending:
                    clone !== null &&
                    clone.phase !== "done" &&
                    clone.destinationPath === project.value.workspaceRoot,
                });
              }
              // SCIENT-WORKSPACE-ASSET: a workspace file is rooted in the
              // authenticated environment, not in the lifecycle of a chat.
              if (input.resource.cwd !== undefined && input.resource.relativePath !== undefined) {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource.threadId === undefined || input.resource.path === undefined) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const thread = yield* threadManagement
                .getThreadRecords(input.resource.threadId, [])
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              const project = yield* projectService.getById(thread.thread.projectId).pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceContextResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
      });

      const handlers5 = WsInteractiveRpcGroup.of({
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.subscribeWorktreeSetup]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeWorktreeSetup,
            worktreeSetupTracker.stream(input.threadId),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.worktreeSetupCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.worktreeSetupCancel,
            worktreeSetupTracker
              .cancel(input.threadId)
              .pipe(Effect.map((cancelled) => ({ cancelled }))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: (result) =>
                      (input.threadId === undefined
                        ? Effect.void
                        : linkCreatedPullRequest({
                            threadId: input.threadId,
                            result,
                            commandId: serverCommandId("pr-created-link"),
                          }).pipe(
                            Effect.provideService(Orchestrator.OrchestratorV2, orchestratorV2),
                            Effect.provideService(ProjectService.ProjectService, projectService),
                          )
                      ).pipe(
                        Effect.andThen(
                          refreshPushedPullRequests(input, result).pipe(
                            Effect.provideService(Orchestrator.OrchestratorV2, orchestratorV2),
                            Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
                            Effect.provideService(
                              PullRequestService.PullRequestService,
                              pullRequests,
                            ),
                          ),
                        ),
                        Effect.andThen(refreshGitStatus(input.cwd)),
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.reviewGetDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffFileContents,
            review.getDiffFileContents(input),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
      });

      const handlers6 = WsDeviceAndTelemetryRpcGroup.of({
        [WS_METHODS.deviceConfigure]: (input) =>
          observeRpcEffect(WS_METHODS.deviceConfigure, deviceService.configure(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceTestHost]: (input) =>
          observeRpcEffect(WS_METHODS.deviceTestHost, deviceService.testHost(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceList]: (input) =>
          observeRpcEffect(
            WS_METHODS.deviceList,
            input.inspectOnly && !input.updateTool
              ? deviceService.inspect
              : authorizeEffect(
                  requiredScopeForDeviceList(input),
                  input.updateTool
                    ? deviceService.updateTool(input.updateTool)
                    : input.retryHostId
                      ? deviceService.retryHost(input.retryHostId)
                      : deviceService.list,
                ),
            {
              "rpc.aggregate": "device",
            },
          ),
        [WS_METHODS.deviceOpen]: (input) =>
          observeRpcEffect(WS_METHODS.deviceOpen, deviceService.open(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceClose]: (input) =>
          observeRpcEffect(WS_METHODS.deviceClose, deviceService.close(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceShutdown]: (input) =>
          observeRpcEffect(WS_METHODS.deviceShutdown, deviceService.shutdown(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceDetail]: (input) =>
          observeRpcEffect(WS_METHODS.deviceDetail, deviceService.detail(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceAction]: (input) =>
          observeRpcEffect(WS_METHODS.deviceAction, deviceService.action(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.subscribeDeviceState]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDeviceState,
            DeviceService.stateStream(deviceService),
            { "rpc.aggregate": "device" },
          ),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                const configuredUrls = input.configuredUrls ?? [];
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan(configuredUrls);
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                  configuredUrlProbing: true,
                });
                yield* portDiscovery.subscribe(
                  { configuredUrls, initialSnapshot: initial },
                  (servers) =>
                    Effect.gen(function* () {
                      const scannedAt = DateTime.formatIso(yield* DateTime.now);
                      yield* Queue.offer(queue, {
                        servers,
                        scannedAt,
                        configuredUrlProbing: true,
                      });
                    }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const usageLimitsCommand = input.usageLimitsCommand === true;
              const config = yield* loadServerConfig({ usageLimitsCommand });
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = Stream.zipLatestWith(
                // The registry stream carries changes only. Seed it with the current
                // providers so a source refresh that lands before any provider change
                // still pairs up and reaches the client.
                Stream.concat(
                  Stream.fromEffect(providerRegistry.getProviders),
                  providerRegistry.streamChanges,
                ),
                usageLimitSources.streamChanges.pipe(
                  // Quota updates already have their own stream. Republish the model
                  // catalog only when the set of providers offered the command changes.
                  Stream.changesWith(
                    usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true,
                  ),
                ),
                (providers, sources) => {
                  const projected = projectProvidersForCurrentSession(providers);
                  return usageLimitsCommand
                    ? withUsageLimitsCommands(projected, sources)
                    : projected;
                },
              ).pipe(
                // Both sides replay their current value, so the first pairing normally
                // repeats the snapshot the client already holds. Compare against that
                // snapshot rather than dropping blindly: a refresh that landed between
                // the snapshot and the subscription still goes out.
                (updates) => Stream.concat(rpcInitialItems([config.providers]), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // The only source of published themes: the stream emits the
              // current set before any change, so the snapshot carrying it too
              // would just send every client the same array twice per connect.
              // Gated on the subscriber's capability flag because an
              // already-shipped client decodes this stream against the old
              // event union and its whole config subscription dies on an
              // unknown member.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              // Same gate as themes: an older client dies on an unknown event.
              const usageLimitSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: { sources },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                  ),
                ),
              );

              return Stream.concat(
                rpcInitialItems([{ version: 1 as const, type: "snapshot" as const, config }]),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
                ),
                { startImmediately: true },
              );
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = Stream.fromQueue(liveBuffer).pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(rpcInitialItems(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                rpcInitialItems([
                  {
                    version: 1 as const,
                    revision: 1,
                    type: "snapshot" as const,
                    payload: initialSnapshot,
                  },
                ]),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
      return Layer.mergeAll(
        WsConversationRpcGroup.toLayer(handlers0),
        WsServerManagementRpcGroup.toLayer(handlers1),
        WsRepositoryRpcGroup.toLayer(handlers2),
        WsScientificRpcGroup.toLayer(handlers3),
        WsWorkspaceRpcGroup.toLayer(handlers4),
        WsInteractiveRpcGroup.toLayer(handlers5),
        WsDeviceAndTelemetryRpcGroup.toLayer(handlers6),
      );
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const analysis = yield* AnalysisService.AnalysisService;
    const compute = yield* ComputeSessionService.ComputeSessionService;
    const runtimePreferences = yield* ScientificRuntimePreferences;
    const conversationExports = yield* ConversationExportService;
    const sql = yield* SqlClient.SqlClient;
    const providerConnectionManager = yield* ProviderConnectionManager.ProviderConnectionManager;
    const providerLifecycleCoordinator =
      yield* ProviderLifecycleCoordinator.ProviderLifecycleCoordinator;
    const providerRuntimeManager = yield* ProviderRuntimeManager.ProviderRuntimeManager;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requestUrl = HttpServerRequest.toURL(request);
        if (Option.isNone(requestUrl) || !hasCompatibleOrchestrationProtocol(requestUrl.value)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "orchestration_protocol_incompatible",
              message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            { status: 426 },
          );
        }
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        yield* analytics.record("client.connected", clientAnalyticsProps);
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(ServerWsRpcGroup, { disableTracing: true }).pipe(
            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
            Effect.forkScoped,
          );
          // @effect-diagnostics-next-line returnEffectInGen:off
          return httpEffect;
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(
              session,
              clientOrigin,
              clientAnalyticsProps,
              previewAutomationBroker,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(
                ProviderMaintenanceRunner.layer.pipe(
                  Layer.provide(
                    Layer.succeed(
                      ProviderLifecycleCoordinator.ProviderLifecycleCoordinator,
                      providerLifecycleCoordinator,
                    ),
                  ),
                ),
              ),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    ProviderConnectionManager.ProviderConnectionManager,
                    providerConnectionManager,
                  ),
                  Layer.succeed(
                    ProviderRuntimeManager.ProviderRuntimeManager,
                    providerRuntimeManager,
                  ),
                ),
              ),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              Layer.provide(AgentSessionScanner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(Layer.succeed(AnalysisService.AnalysisService, analysis)),
              Layer.provide(Layer.succeed(ComputeSessionService.ComputeSessionService, compute)),
              Layer.provide(Layer.succeed(ScientificRuntimePreferences, runtimePreferences)),
              Layer.provide(Layer.succeed(ConversationExportService, conversationExports)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                          ForgejoCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
