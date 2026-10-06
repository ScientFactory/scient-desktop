export * from "./baseSchemas.ts";
export * from "./orchestrationV2SnapshotWire.ts";
export * from "./assistantCitations.ts";
export * from "./fileCitations.ts";
export * from "./composerContext.ts";
export * from "./composerContextClipboard.ts";
export * from "./background.ts";
export * from "./acpRegistry.ts";
export * from "./auth.ts";
export * from "./environment.ts";
export * from "./environmentHttp.ts";
export * from "./relayClient.ts";
export * from "./desktopBootstrap.ts";
export * from "./desktopAppActivation.ts";
export * from "./remoteAccess.ts";
export * from "./ipc.ts";
export * from "./voice.ts";
export * from "./terminal.ts";
export * from "./provider.ts";
export * from "./providerInstance.ts";
export * from "./providerLifecycle.ts";
export * from "./providerSetup.ts";
export * from "./providerRuntime.ts";
export * from "./providerUsageLimits.ts";
export * from "./usageLimitSourceId.ts";
export * from "./usageAccountingSourceId.ts";
export * from "./providerPolicy.ts";
export * from "./modelSelection.ts";
export * from "./chatAttachment.ts";
export * from "./checkpointDiff.ts";
export * from "./model.ts";
export * from "./keybindings.ts";
export * from "./server.ts";
export * from "./settings.ts";
// SCIENT-FORK: conversation-fork preferences.
export * from "./scientForkSettings.ts";
export * from "./git.ts";
export * from "./vcs.ts";
export * from "./sourceControl.ts";
export * from "./projectClone.ts";
export * from "./pullRequest.ts";
// SCIENT-ORCHESTRATION:START — historical data keeps its canonical codecs
// after the V1 execution facade retires.
export * from "./legacy/orchestrationEvent.ts";
export { ScientConversationDispatchResult as DispatchResult } from "./scientConversationFork.ts";
export * from "./scientConversationOrigin.ts";
export * from "./scientConversationFork.ts";
export * from "./scientConversationView.ts";
// SCIENT-FORK: retained snapshot/view schemas have a dedicated canonical owner.
export * from "./scientOrchestrationSnapshot.ts";
export * from "./scientQuestionAnswer.ts";
// SCIENT-FORK:START — explicit exports select Scient's compatibility variants.
// Dispatch failures retain the fork disposition. Public/MCP search retains
// nullable project ids; modern RPC uses the non-null threadSearch.ts variant.
export {
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchMatch,
} from "./scientThreadSearch.ts";
// SCIENT-FORK:END
// SCIENT-ORCHESTRATION:END
export * from "./orchestrationDispatch.ts";
// SCIENT-FORK: current wire names stay independent of the legacy barrel.
export { ORCHESTRATION_WS_METHODS } from "./scientOrchestrationRpcMethods.ts";
// SCIENT-FORK: retained SQL approval codecs stay independent of the legacy barrel.
export {
  ProjectionPendingApprovalStatus,
  ProjectionPendingApprovalDecision,
} from "./scientApprovalProjection.ts";
export * from "./orchestrationProject.ts";
export * from "./orchestrationV2.ts";
export * from "./applicationEvent.ts";
export * from "./orchestratorMcp.ts";
export * from "./threadMetadataMcp.ts";
export * from "./threadPullRequest.ts";
export * from "./threadSearch.ts";
export * from "./threadTitle.ts";
export * from "./t3ProjectFile.ts";
export * from "./editor.ts";
export * from "./project.ts";
export * from "./filesystem.ts";
export * from "./fileOpening.ts";
export * from "./agentSessions.ts";
export * from "./assets.ts";
export * from "./review.ts";
export * from "./scientProject.ts";
export * from "./scientSources.ts";
export * from "./scientAnalytics.ts";
export * from "./scientAnalysis.ts";
export * from "./scientCompute.ts";
export * from "./scientSkills.ts";
export * from "./scientLatex.ts";
export * from "./latexPdfBuild.ts";
export * from "./browserPdfExport.ts";
export * from "./htmlPdfBuild.ts";
export * from "./scientDocumentExport.ts";
export * from "./scientMarkdown.ts";
// SCIENT-FORK:START — Scient thread queue contracts (new file, no upstream edits).
export * from "./scientThreadQueue.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START — Scient conversation export contracts (new file, no upstream edits).
export * from "./scientConversationExport.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START — Scient conversation import contracts (new file, no upstream edits).
export * from "./scientConversationImport.ts";
// SCIENT-FORK:END
// SCIENT-FORK:START — Scient managed Pandoc contracts (new file, no upstream edits).
export * from "./scientPandoc.ts";
// SCIENT-FORK:END
export * from "./browserImport.ts";
export * from "./browserProfile.ts";
export * from "./device.ts";
export * from "./preview.ts";
export * from "./previewAutomation.ts";
export * from "./resourceTelemetry.ts";
export * from "./usage.ts";
export * from "./scheduledTask.ts";
export * from "./worktreeMcp.ts";
export * from "./resourceTelemetry.ts";
export * from "./rpc.ts";
export * from "./customModels.ts";
export * from "./modelReasoning.ts";

export * from "./scientAnswerAttention.ts";
export * from "./worktreeSetup.ts";

export * from "./providerCitationPresentation.ts";
