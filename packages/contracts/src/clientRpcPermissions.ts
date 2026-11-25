import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  mcpClientScopes,
} from "./auth.ts";
import { PeerLinkLinkPairingInput } from "./peerLink.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
// SCIENT-FORK:START — Extensions mutations share the destination settings grant.
import { SCIENT_EXTENSION_GUARDED_RPC_SCOPES } from "./scient/extensionsPermissions.ts";
import { SCIENT_SKILL_GUARDED_RPC_SCOPES } from "./scient/skillsPermissions.ts";
import {
  SCIENT_SOURCES_GUARDED_HTTP_SCOPES,
  scientPaperRequestScopes,
} from "./scient/sourcesPermissions.ts";
export * from "./scient/sourcesPermissions.ts";
// Linked results write project files, so they take the file-write grant.
import { AuthFilesystemReadScope, AuthFilesystemWriteScope } from "./auth.ts";
// SCIENT-FORK:END

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  // SCIENT-FORK:START — linked results: placing, updating and undoing write project files, as
  // any file write does; re-run starts a run.
  [WS_METHODS.computeResultsPlaceFigure]: AuthFilesystemWriteScope,
  [WS_METHODS.voiceManageWords]: AuthSettingsWriteScope,
  [WS_METHODS.voiceDictate]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceDictationWait]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceCloudChoices]: AuthSettingsWriteScope,
  [WS_METHODS.voiceSavedKeys]: AuthAccessWriteScope,
  [WS_METHODS.voiceConfigureCloud]: AuthSettingsWriteScope,
  [WS_METHODS.voiceChooseCloud]: AuthSettingsWriteScope,
  [WS_METHODS.voiceReadWords]: AuthOrchestrationOperateScope,
  [WS_METHODS.computeResultsRerun]: AuthOrchestrationOperateScope,
  [WS_METHODS.computeResultsPlaceLatex]: AuthFilesystemWriteScope,
  [WS_METHODS.computeResultsUpdateFiles]: AuthFilesystemWriteScope,
  [WS_METHODS.computeResultsUndoUpdate]: AuthFilesystemWriteScope,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — fresh notebooks submit work and read its status.
  [WS_METHODS.notebookEdit]: AuthFilesystemWriteScope,
  [WS_METHODS.notebookFreshStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookFreshStatus]: AuthFilesystemReadScope,
  [WS_METHODS.notebookFreshStop]: AuthOrchestrationOperateScope,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — save views and export derived dataset files.
  [WS_METHODS.dataSaveView]: AuthFilesystemWriteScope,
  [WS_METHODS.dataMaterializeView]: AuthFilesystemWriteScope,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — result package writes and verification require current grants.
  [WS_METHODS.computeResultsExport]: AuthFilesystemWriteScope,
  [WS_METHODS.computeResultsExportProgress]: AuthFilesystemWriteScope,
  [WS_METHODS.computeResultsVerify]: AuthOrchestrationOperateScope,
  [WS_METHODS.computeResultsCancelVerification]: AuthOrchestrationOperateScope,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — provider plugin mutations use the destination settings grant.
  ...SCIENT_EXTENSION_GUARDED_RPC_SCOPES,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — personal skills read local files and change the user's skills.
  ...SCIENT_SKILL_GUARDED_RPC_SCOPES,
  // SCIENT-FORK:END
  // SCIENT-FORK:START — Scient Accounts: recheck credential and settings authority at execution.
  [WS_METHODS.accountsSave]: AuthSettingsWriteScope,
  [WS_METHODS.accountsRemove]: AuthSettingsWriteScope,
  [WS_METHODS.accountsTest]: AuthSettingsWriteScope,
  [WS_METHODS.accountsCheck]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSignInSeen]: AuthSettingsWriteScope,
  [WS_METHODS.accountsGoogleSessionsSeen]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionEnded]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSetCodeSources]: AuthSettingsWriteScope,
  [WS_METHODS.accountsLinkKey]: AuthSettingsWriteScope,
  [WS_METHODS.accountsPaperForSource]: AuthSettingsWriteScope,
  [WS_METHODS.accountsPapersRequest]: AuthSettingsWriteScope,
  [WS_METHODS.accountsPapersContinue]: AuthSettingsWriteScope,
  [WS_METHODS.accountsPapersList]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSignInAsPerson]: AuthSettingsWriteScope,
  [WS_METHODS.accountsUniversitySignIn]: AuthSettingsWriteScope,
  [WS_METHODS.accountsUniversityBrowse]: AuthSettingsWriteScope,
  [WS_METHODS.accountsUniversitySearch]: AuthSettingsWriteScope,
  [WS_METHODS.accountsPlainKeys]: AuthSettingsWriteScope,
  [WS_METHODS.accountsKeepPlainKey]: AuthSettingsWriteScope,
  [WS_METHODS.accountsUnlinkKey]: AuthSettingsWriteScope,
  [WS_METHODS.accountsRestoreKeptKeys]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSetControls]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSetAgentAccess]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileRemove]: AuthSettingsWriteScope,
  [WS_METHODS.accountsHandoffCancel]: AuthSettingsWriteScope,
  [WS_METHODS.accountsHandoffShow]: AuthSettingsWriteScope,
  [WS_METHODS.accountsApprovalRespond]: AuthSettingsWriteScope,
  [WS_METHODS.accountsPasswordStore]: AuthSettingsWriteScope,
  [WS_METHODS.accountsOnePasswordConnect]: AuthSettingsWriteScope,
  [WS_METHODS.accountsOnePasswordDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.accountsImportPasswords]: AuthSettingsWriteScope,
  [WS_METHODS.accountsFillValues]: AuthSettingsWriteScope,
  [WS_METHODS.accountsMatchSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileChoose]: AuthSettingsWriteScope,
  [WS_METHODS.accountsMainFilled]: AuthSettingsWriteScope,
  [WS_METHODS.accountsMainBackfilled]: AuthSettingsWriteScope,
  [WS_METHODS.accountsMainFolded]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileRetire]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsSeen]: AuthSettingsWriteScope,
  [WS_METHODS.accountsKeepTyped]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsQualify]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsReceive]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsApplied]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsWithdraw]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsSignOutLocal]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileSendLog]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileResend]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileSignedOut]: AuthSettingsWriteScope,
  [WS_METHODS.accountsMainWithdrawn]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfileShared]: AuthSettingsWriteScope,
  [WS_METHODS.accountsProfilesUnshared]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsBind]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSessionsForget]: AuthSettingsWriteScope,
  [WS_METHODS.accountsSenderKey]: AuthSettingsWriteScope,
  [WS_METHODS.accountsKeepSenderKey]: AuthSettingsWriteScope,
  [WS_METHODS.accountsKeychainCandidates]: AuthSettingsWriteScope,
  // SCIENT-FORK:END
  [WS_METHODS.documentsExportServerBrowserPdf]: AuthPreviewOperateScope,
  [WS_METHODS.documentsNavigateServerBrowser]: AuthPreviewOperateScope,
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  // An MCP sign-in stores a credential for the agent, as an account sign-in does.
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  // SCIENT-FORK: an Antigravity plugin sign-in takes the same grant as an MCP sign-in.
  [WS_METHODS.pluginSignInOpen]: AuthProvidersManageScope,
  // SCIENT-FORK:START — managed runtime changes, offered outside Settings too, take the server's grant.
  [WS_METHODS.serverPlanProviderRuntime]: AuthProvidersManageScope,
  [WS_METHODS.serverStartProviderRuntime]: AuthProvidersManageScope,
  [WS_METHODS.serverCancelProviderRuntime]: AuthProvidersManageScope,
  // SCIENT-FORK:END
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  // A tracker credential and a project's binding are settings, saved under the same grant.
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.workspaceAddTaskFolderRepository]: AuthSourceControlWriteScope,
  // The server runs an approved layout command: approving one is running code there, as a terminal does.
  [WS_METHODS.workspaceApproveLayoutCommands]: AuthTerminalOperateScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // An answer, a resume and a cancel each decide what a run's agents do next.
  [WS_METHODS.workflowsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCancel]: AuthOrchestrationOperateScope,
  // The server runs this file: saving it is running code there, as a terminal does.
  [WS_METHODS.workflowsSaveDefinition]: AuthTerminalOperateScope,
  [WS_METHODS.workflowsDeleteDefinition]: AuthTerminalOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  // SCIENT-FORK: a room invite hands thread access to someone outside, like a guest link.
  [WS_METHODS.threadRoomInvite]: AuthAccessWriteScope,
  [WS_METHODS.threadRoomInviteLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairClient]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairLink]: AuthAccessWriteScope,
  // Send stores and sends a report from a thread's turn: the bar of running that thread.
  [WS_METHODS.agentFeedbackAnswerRequest]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

// SCIENT-FORK:START — HTTP commands checked like guarded RPCs; the server's RPC table excludes them.
const CLIENT_GUARDED_HTTP_SCOPES = {
  ...SCIENT_SOURCES_GUARDED_HTTP_SCOPES,
} as const;
export type ClientGuardedHttpTag = keyof typeof CLIENT_GUARDED_HTTP_SCOPES;
// SCIENT-FORK:END

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeLinkPairing = Schema.decodeUnknownSync(PeerLinkLinkPairingInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.voiceSavedKeys)
    return [AuthAccessWriteScope, AuthSettingsWriteScope, AuthProvidersManageScope];
  if (method === WS_METHODS.voiceConfigureCloud)
    return [AuthSettingsWriteScope, AuthProvidersManageScope];
  if (method === WS_METHODS.documentsExportServerBrowserPdf)
    return [AuthPreviewOperateScope, AuthOrchestrationOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  // Handing out access takes holding it: the caller gets back a credential it can spend itself.
  if (method === WS_METHODS.peerLinksPairLink && input !== undefined) {
    const held = mcpClientScopes(decodeLinkPairing(input).access);
    return [AuthAccessWriteScope, ...held];
  }
  if (method === WS_METHODS.guestShareCreate) {
    return [AuthAccessWriteScope, AuthOrchestrationReadScope];
  }
  // SCIENT-FORK:START — package operations require file access and the matching Compute grant.
  if (
    method === WS_METHODS.computeResultsExport ||
    method === WS_METHODS.computeResultsExportProgress
  )
    return [AuthOrchestrationReadScope, AuthFilesystemReadScope, AuthFilesystemWriteScope];
  if (
    method === WS_METHODS.computeResultsVerify ||
    method === WS_METHODS.computeResultsCancelVerification
  )
    return [AuthOrchestrationOperateScope, AuthFilesystemReadScope, AuthFilesystemWriteScope];
  // SCIENT-FORK:END
  // SCIENT-FORK:START — guarded HTTP commands and Library paper requests share this check.
  const paperScopes = scientPaperRequestScopes(method, input);
  if (paperScopes !== undefined) return paperScopes;
  if (Object.hasOwn(CLIENT_GUARDED_HTTP_SCOPES, method))
    return [CLIENT_GUARDED_HTTP_SCOPES[method as ClientGuardedHttpTag]];
  // SCIENT-FORK:END
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
