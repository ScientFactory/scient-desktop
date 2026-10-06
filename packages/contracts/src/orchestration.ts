// SCIENT-FORK: retained snapshot schemas share one owner across the old RPC bridge and public API.
import {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./scientOrchestrationSnapshot.ts";
export {
  OrchestrationProject,
  OrchestrationCheckpointSummary,
  OrchestrationForkBoundary,
  isForkBaselineBoundary,
  OrchestrationThread,
  OrchestrationReadModel,
  OrchestrationThreadShell,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadDetailWindow,
  OrchestrationThreadDetailPage,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
} from "./scientOrchestrationSnapshot.ts";

import {
  OrchestrationSession,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadConversationImportTurn,
  OrchestrationForkCheckpointStatus,
  OrchestrationForkWorkspaceStatus,
} from "./legacy/orchestrationEvent.ts";
export {
  OrchestrationSessionStatus,
  OrchestrationSession,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadConversationImportTurn,
  ThreadTitleState,
  OrchestrationForkProviderMode,
  OrchestrationForkCheckpointStatus,
  OrchestrationForkWorkspaceStatus,
  OrchestrationAggregateKind,
  OrchestrationActorKind,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  ProjectDeletedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadArchivedPayload,
  ThreadUnarchivedPayload,
  ThreadSettledPayload,
  ThreadUnsettledPayload,
  ThreadSnoozedPayload,
  ThreadUnsnoozedPayload,
  ThreadPinnedPayload,
  ThreadUnpinnedPayload,
  ThreadPinReorderedPayload,
  ThreadAutoSettleSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadPullRequestLinkedPayload,
  ThreadPullRequestUnlinkedPayload,
  ThreadPullRequestSyncedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageSentPayload,
  ThreadTurnStartRequestedPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadApprovalResponseRequestedPayload,
  ThreadCheckpointRevertRequestedPayload,
  ThreadRevertedPayload,
  ThreadForkCopiedBoundary,
  ThreadForkMidTurnCut,
  ThreadForkedPayload,
  ThreadForkCompletedPayload,
  ThreadConversationImportedPayload,
  ThreadSessionStopRequestedPayload,
  ThreadSessionSetPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadActivityAppendedPayload,
  OrchestrationEventMetadata,
  OrchestrationEvent,
  OrchestrationClientOrigin,
} from "./legacy/orchestrationEvent.ts";

import {
  OrchestrationMessageRole,
  OrchestrationProposedPlan,
  SourceProposedPlanReference,
  OrchestrationThreadActivity,
} from "./scientConversationView.ts";
export * from "./scientConversationView.ts";
import {
  ThreadForkCommand,
  ScientConversationDispatchResult as DispatchResult,
} from "./scientConversationFork.ts";
export {
  OrchestrationForkWorkspaceMode,
  ThreadForkCommand,
  GetForkOptionsInput,
  ForkOptions,
  ThreadForkAttachmentCopy,
  ScientConversationDispatchResult as DispatchResult,
  OrchestrationGetSnapshotError,
} from "./scientConversationFork.ts";

export { ForkDisposition, OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import { OrchestrationConversationImport } from "./scientConversationOrigin.ts";

// The attachment and screenshot schemas moved to chatAttachment.ts upstream. They
// are imported here so the V1 contract keeps resolving while the engine port is
// in flight, and re-exported below so one declaration owns each name: two
// `export *` paths reaching the same symbol is unambiguous, but two separate
// definitions of it are not.
import {
  ChatAttachment,
  SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS,
  SnapShotAccessibilityNode,
  UploadChatAttachment,
} from "./chatAttachment.ts";
// Upstream relocated these two schemas to providerPolicy.ts. They are imported
// here rather than redeclared so one definition owns each name: two `export *`
// paths reaching different declarations is ambiguous and resolves to nothing.
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  UserInputAttachments,
} from "./providerPolicy.ts";
export * from "./chatAttachment.ts";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SelectedScientSkillNames } from "./scientSkillSelection.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ThreadEnvMode } from "./environment.ts";

import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  // SCIENT-FORK:START
  ThreadSectionId,
  // SCIENT-FORK:END
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

// SCIENT-FORK: current wire names have one dependency-free owner.
export { ORCHESTRATION_WS_METHODS } from "./scientOrchestrationRpcMethods.ts";

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
// `ModelSelection` moved to its own module during the V2 extraction. The two
// definitions were identical (same source struct, same wire target, same
// transform), so V1 re-exports the canonical one rather than keeping a copy
// that can drift from it.
import { ModelSelection } from "./modelSelection.ts";
export { ModelSelection };

// The provider policy literals moved to providerPolicy.ts upstream. Every
// declaration was identical to its canonical counterpart, so V1 imports the
// canonical one and re-exports it rather than keeping a copy that can drift.
export {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
};

// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const SnapShotAccessibilityBounds = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: PositiveInt,
  height: PositiveInt,
});

const SnapShotAccessibilityState = Schema.Struct({
  active: Schema.optional(Schema.Boolean),
  busy: Schema.optional(Schema.Boolean),
  checked: Schema.optional(Schema.Literals(["on", "off", "mixed"])),
  editable: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  expanded: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  visible: Schema.optional(Schema.Boolean),
});

const SnapShotAccessibilityWire = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("flat-text"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    format: Schema.Literal("element-tree"),
    coordinateSpace: Schema.Literal("captured-image"),
    imageSize: Schema.Struct({ width: PositiveInt, height: PositiveInt }),
    truncated: Schema.Boolean,
    root: SnapShotAccessibilityNode,
  }),
]);

export { questionAnswerMessageId } from "./scientQuestionAnswer.ts";

// SCIENT-FORK:START — the Scient thread queue stores upload-shaped
// attachments so a queued item dispatches through thread.turn.start
// unchanged. Re-export the wire schema rather than duplicating it.
export { UploadChatAttachment } from "./chatAttachment.ts";
// SCIENT-FORK:END

// The project script and icon schemas moved to project.ts upstream. Every
// declaration was identical to its canonical counterpart, so V1 imports the
// canonical ones and re-exports them rather than keeping copies that can drift.
import {
  ProjectFaviconPath,
  ProjectIconColor,
  ProjectIconOverride,
  ProjectMonogramText,
  ProjectScript,
  ProjectScriptIcon,
} from "./project.ts";
export {
  ProjectFaviconPath,
  ProjectIconColor,
  ProjectIconOverride,
  ProjectMonogramText,
  ProjectScript,
  ProjectScriptIcon,
};

// The in-flight title regeneration moved to threadTitle.ts upstream; the two
// definitions were identical, so V1 imports the canonical one.
import { ThreadTitleRegeneration } from "./threadTitle.ts";
export { ThreadTitleRegeneration };

// The thread ↔ pull request schemas moved to threadPullRequest.ts upstream.
// Every declaration was identical to its canonical counterpart, so V1 imports
// the canonical ones and re-exports them.
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  ThreadPullRequestStackLayer,
} from "./threadPullRequest.ts";
export {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  ThreadPullRequestStackLayer,
};

// The project shell moved to orchestrationProject.ts upstream; the two
// definitions were identical field for field, so V1 imports the canonical one.
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
export { OrchestrationProjectShell };

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  // Retained for older clients that sent an automatic create-time seed. The
  // server ignores it; explicit project defaults use project.meta.update.
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  historyImport: Schema.optional(Schema.Literal(true)),
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadAutoSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle"),
  commandId: CommandId,
  threadId: ThreadId,
  snapshotSequence: NonNegativeInt,
  settledAt: IsoDateTime,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

const ThreadAutoSettleSetCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle.set"),
  commandId: CommandId,
  threadId: ThreadId,
  // false turns automatic settlement off for this thread, true turns it back on.
  enabled: Schema.Boolean,
});

const ThreadActiveReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.active.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
});

// SCIENT-FORK:START — file a thread into a user-defined section (null clears it).
// A dedicated command, like thread.active.reorder, so organizing the list
// never reads as thread activity.
const ThreadSectionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.section.set"),
  commandId: CommandId,
  threadId: ThreadId,
  sectionId: Schema.NullOr(ThreadSectionId),
});
// SCIENT-FORK:END

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadPullRequestLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.link"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
});

const ThreadPullRequestUnlinkCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
  requireWorktree: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  submissionId: Schema.optional(TrimmedNonEmptyString),
  composerSnapshot: Schema.optional(Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024))),
  selectedScientSkillNames: Schema.optional(SelectedScientSkillNames),
  queueProtocolVersion: Schema.optional(Schema.Literal(2)),
  sendIntent: Schema.optional(Schema.Literals(["normal", "steer"])),
  queueItemId: Schema.optional(Schema.String),
  queueRevision: Schema.optional(Schema.Number),
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  submissionId: ThreadTurnStartCommand.fields.submissionId,
  composerSnapshot: ThreadTurnStartCommand.fields.composerSnapshot,
  selectedScientSkillNames: Schema.optional(SelectedScientSkillNames),
  queueProtocolVersion: Schema.optional(Schema.Literal(2)),
  sendIntent: Schema.optional(Schema.Literals(["normal", "steer"])),
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  /** Captures a turnless session when Stop targets background work. */
  sessionUpdatedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  createdAt: IsoDateTime,
});

// Closes an async question without answering it. The agent is not messaged;
// the composer is simply released. Native callback questions cannot be dismissed
// this way because the provider is blocked waiting on a reply.
const ThreadUserInputDismissCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.dismiss"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

// A separate command makes older servers reject history-only rewinds rather than
// ignoring an unfamiliar option and restoring files.
const ThreadConversationRevertCommand = Schema.Struct({
  ...ThreadCheckpointRevertCommand.fields,
  type: Schema.Literal("thread.conversation.revert"),
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadAutoSettleSetCommand,
  ThreadActiveReorderCommand,
  // SCIENT-FORK:START
  ThreadSectionSetCommand,
  // SCIENT-FORK:END
  ThreadMetaUpdateCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadSessionStopCommand,
  // SCIENT-FORK:START
  ThreadForkCommand,
  // SCIENT-FORK:END
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadAutoSettleSetCommand,
  ThreadActiveReorderCommand,
  // SCIENT-FORK:START
  ThreadSectionSetCommand,
  // SCIENT-FORK:END
  ThreadMetaUpdateCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadSessionStopCommand,
  // SCIENT-FORK:START
  ThreadForkCommand,
  // SCIENT-FORK:END
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  // Recovery writes are compare-and-set inside the serialized command decider.
  expectedSession: Schema.optional(OrchestrationSession),
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageReasoningDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.reasoning.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageReasoningCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.reasoning.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadHistoryImportCommand = Schema.Struct({
  type: Schema.Literal("thread.history.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ).check(Schema.isNonEmpty()),
});

/**
 * Persists a user message without starting a turn. Used by worktree bootstraps
 * so the send is durable while the worktree is still being prepared; the
 * turn that follows references the same message id.
 */
const ThreadMessageUserAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.message.user.append"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

// SCIENT-FORK:START — internal command: the durable fork worker reports exactly
// which code-state substrates it established. `threadId` is the NEW thread.
const ThreadForkCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.fork.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  checkpointStatus: OrchestrationForkCheckpointStatus,
  workspaceStatus: OrchestrationForkWorkspaceStatus,
  /** The inherited baseline turn; its turn-zero checkpoint exists only once copied. */
  checkpointBaseline: Schema.optional(
    Schema.Struct({ turnId: TurnId, assistantMessageId: Schema.NullOr(MessageId) }),
  ),
  createdAt: IsoDateTime,
});

/**
 * Internal command: create a new, independent thread holding an imported
 * conversation, in one decision. Only the server's conversation importer
 * dispatches it, after publishing every attachment the history references;
 * every id in it is new and local.
 */
const ThreadConversationImportCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.import"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Transcript messages and reasoning, in timeline order. */
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: OrchestrationMessageRole,
      text: Schema.String,
      attachments: Schema.optional(Schema.Array(ChatAttachment)),
      turnId: Schema.NullOr(TurnId),
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    }),
  ),
  proposedPlans: Schema.Array(OrchestrationProposedPlan),
  /** Work log and submitted question answers; history only, never executable. */
  activities: Schema.Array(OrchestrationThreadActivity),
  /** Every turn holding imported history, including turns without a response. */
  inheritedTurnIds: Schema.Array(TurnId),
  turns: Schema.Array(ThreadConversationImportTurn),
  origin: OrchestrationConversationImport,
  createdAt: IsoDateTime,
});
// SCIENT-FORK:END

const ThreadTitleGenerateCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.generate.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedTitle: TrimmedNonEmptyString,
  expectedVersion: Schema.NullOr(CommandId),
  title: TrimmedNonEmptyString,
  needsRefinement: Schema.Boolean,
});

const ThreadTitleRefineCommand = Schema.Struct({
  type: Schema.Literal("thread.title.refine"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedVersion: CommandId,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

const ThreadPullRequestSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  snapshotSequence: NonNegativeInt,
  expected: Schema.Struct({
    workspaceRoot: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
    branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  }),
  branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
});

const ThreadPullRequestLinkSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request-link.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  snapshot: ThreadPullRequestSnapshot,
  stack: Schema.NullOr(ThreadPullRequestStack),
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadAutoSettleCommand,
  ThreadPullRequestSyncCommand,
  ThreadPullRequestLinkSyncCommand,
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadMessageReasoningDeltaCommand,
  ThreadMessageReasoningCompleteCommand,
  ThreadHistoryImportCommand,
  ThreadMessageUserAppendCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  // SCIENT-FORK:START
  ThreadForkCompleteCommand,
  ThreadConversationImportCommand,
  // SCIENT-FORK:END
  ThreadTitleRegenerationCompleteCommand,
  ThreadTitleGenerateCompleteCommand,
  ThreadTitleRefineCommand,
  ThreadPullRequestSyncCommand,
  ThreadPullRequestLinkSyncCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.auto-settle-set",
  "thread.meta-updated",
  "thread.pull-request-linked",
  "thread.pull-request-unlinked",
  "thread.pull-request-synced",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  // SCIENT-FORK:START
  "thread.forked",
  "thread.fork-completed",
  "thread.conversation-imported",
  // SCIENT-FORK:END
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

// The turn-diff schemas moved to checkpointDiff.ts upstream. Every declaration
// was identical to its canonical counterpart, so V1 imports the canonical ones
// and re-exports them rather than keeping copies that can drift.
import {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  ThreadTurnDiff,
  TurnCountRange,
} from "./checkpointDiff.ts";
export {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  ThreadTurnDiff,
  TurnCountRange,
};

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

// SCIENT-FORK: retained SQL approval-history codecs have one current owner.
export {
  ProjectionPendingApprovalStatus,
  ProjectionPendingApprovalDecision,
} from "./scientApprovalProjection.ts";

// The thread-search scan input and match source moved to threadSearch.ts
// upstream; those two declarations were identical. Scient's nullable match
// remains distinct in scientThreadSearch.ts below.
import {
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchSource,
} from "./threadSearch.ts";
export {
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchSource,
};

// SCIENT-FORK:START — public/MCP search keeps Scient's nullable project ids.
// Modern RPC uses the distinct non-null result from threadSearch.ts.
import { OrchestrationSearchThreadsResult } from "./scientThreadSearch.ts";
export {
  OrchestrationThreadSearchMatch,
  OrchestrationSearchThreadsResult,
} from "./scientThreadSearch.ts";
// SCIENT-FORK:END

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

// The workflow-script failure moved to orchestrationV2.ts upstream; both
// declarations carried the same fields and the same reason-to-message table.
import { OrchestrationGetWorkflowScriptError } from "./orchestrationV2.ts";
export { OrchestrationGetWorkflowScriptError };

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;
