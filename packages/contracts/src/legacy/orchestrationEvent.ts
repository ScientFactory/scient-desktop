/** Historical V1 event encoding retained for migration and recovery readers. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  OrchestrationMessageRole,
  OrchestrationProposedPlan,
  SourceProposedPlanReference,
  OrchestrationThreadActivity,
} from "../scientConversationView.ts";
import {
  OrchestrationForkWorkspaceMode,
  ThreadForkAttachmentCopy,
} from "../scientConversationFork.ts";
import {
  OrchestrationConversationImport,
  OrchestrationConversationImportSource,
} from "../scientConversationOrigin.ts";
import { ChatAttachment } from "../chatAttachment.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  UserInputAttachments,
} from "../providerPolicy.ts";
import { SelectedScientSkillNames } from "../scientSkillSelection.ts";
import { OrchestrationMessageContext } from "../composerContext.ts";
import { RepositoryIdentity, ThreadEnvMode } from "../environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  ThreadSectionId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ProjectFaviconPath, ProjectIconOverride, ProjectScript } from "../project.ts";
import { ThreadTitleRegeneration } from "../threadTitle.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
} from "../threadPullRequest.ts";

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

/**
 * One imported turn. Imported turns are completed history with no provider
 * turn or checkpoint behind them, like a fork's inherited turns.
 */
export const ThreadConversationImportTurn = Schema.Struct({
  turnId: TurnId,
  userMessageId: Schema.NullOr(MessageId),
  assistantMessageId: Schema.NullOr(MessageId),
  requestedAt: IsoDateTime,
  completedAt: IsoDateTime,
});
export type ThreadConversationImportTurn = typeof ThreadConversationImportTurn.Type;

// Version changes even when a manual rename keeps the same text.
export const ThreadTitleState = Schema.Struct({
  source: Schema.Literals(["manual", "generated"]),
  version: CommandId,
  needsRefinement: Schema.Boolean,
});
export type ThreadTitleState = typeof ThreadTitleState.Type;

// SCIENT-FORK:START — Scient-owned conversation-fork command (additive union member).
// Forks the origin thread at a completed turn boundary into a NEW independent
// thread. The origin is never mutated. `createdAt` is intentionally absent: the
// decider stamps fork/lineage events with server time (like thread.delete),
// while re-emitted prefix events preserve their original message timestamps.
// Workspace substrate choice, made explicitly at fork time (the product "always
// asks"): "new-worktree" provisions a fresh worktree branched from the fork
// point; "local" reuses the origin thread's workspace.
// Provider continuity is explicit instead of being folded into a vague overall
// "fidelity" label. Exact-boundary forks start a fresh provider session and
// inject the retained transcript once with the first post-fork turn. This avoids
// leaking messages after the selected boundary from provider-native tip forks.
const OrchestrationForkProviderModeWire = Schema.Literals(["transcript-bootstrap", "cold-start"]);
export const OrchestrationForkProviderMode = OrchestrationForkProviderModeWire.pipe(
  Schema.decodeTo(
    Schema.Literal("transcript-bootstrap"),
    SchemaTransformation.transform<
      "transcript-bootstrap",
      typeof OrchestrationForkProviderModeWire.Type
    >({
      decode: () => "transcript-bootstrap",
      encode: () => "transcript-bootstrap",
    }),
  ),
);
export type OrchestrationForkProviderMode = typeof OrchestrationForkProviderMode.Type;

export const OrchestrationForkCheckpointStatus = Schema.Literals(["ready", "unavailable"]);
export type OrchestrationForkCheckpointStatus = typeof OrchestrationForkCheckpointStatus.Type;

export const OrchestrationForkWorkspaceStatus = Schema.Literals([
  "project-root",
  "shared",
  "worktree",
]);
export type OrchestrationForkWorkspaceStatus = typeof OrchestrationForkWorkspaceStatus.Type;

// SCIENT-FORK:END

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Optional so persisted events from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  /**
   * Nullable only to decode immutable events written by the retired
   * projectless-thread experiment. Current commands always require a project.
   */
  projectId: Schema.NullOr(ProjectId),
  /** Decode-only residue for those same historical events. */
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadAutoSettleSetPayload = Schema.Struct({
  threadId: ThreadId,
  // Null re-enables automatic settlement.
  autoSettleDisabledAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  // Order updates use this existing event so older clients can ignore the
  // new field while continuing to decode the event stream.
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // SCIENT-FORK:START — user-defined section. Absent means unchanged: other
  // meta updates omit it, and null files the thread back into General.
  sectionId: Schema.optional(Schema.NullOr(ThreadSectionId)),
  // SCIENT-FORK:END
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Decode-only compatibility for historical projectless-to-project moves. */
  projectId: Schema.optional(ProjectId),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // No longer produced; kept so persisted events from before
  // thread.pull-request-linked still decode and replay into the link table.
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  updatedAt: IsoDateTime,
});

export const ThreadPullRequestLinkedPayload = Schema.Struct({
  threadId: ThreadId,
  link: ThreadPullRequestLink,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestLinkedPayload = typeof ThreadPullRequestLinkedPayload.Type;

export const ThreadPullRequestUnlinkedPayload = Schema.Struct({
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestUnlinkedPayload = typeof ThreadPullRequestUnlinkedPayload.Type;

export const ThreadPullRequestSyncedPayload = Schema.Struct({
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
  snapshot: ThreadPullRequestSnapshot,
  stack: Schema.NullOr(ThreadPullRequestStack),
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestSyncedPayload = typeof ThreadPullRequestSyncedPayload.Type;

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  // Events persisted before the field existed carry no key at all.
  turnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  selectedScientSkillNames: Schema.optional(SelectedScientSkillNames),
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  sessionUpdatedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  restoreFiles: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

// SCIENT-FORK:START — immutable fork lineage plus explicit provider behavior.
/**
 * One completed logical turn copied into a fork's immutable transcript.
 *
 * Copied transcript turns are not native turns in the destination provider
 * session, so they deliberately carry no provider/checkpoint count. The
 * remapped identities are sufficient for resolving later forks of a fork
 * without walking ancestor threads or inventing provider history.
 */
export const ThreadForkCopiedBoundary = Schema.Struct({
  turnId: TurnId,
  userMessageId: Schema.NullOr(MessageId),
  assistantMessageId: MessageId,
  completedAt: IsoDateTime,
});
export type ThreadForkCopiedBoundary = typeof ThreadForkCopiedBoundary.Type;

/**
 * What a fork taken while the origin agent was still working captured of its
 * running turn. Items listed here were copied as they stood at the cut; the
 * provider handoff labels them so the fork's agent does not mistake a cut-off
 * reasoning trace or an unfinished tool call for a completed one.
 */
export const ThreadForkMidTurnCut = Schema.Struct({
  sourceTurnId: TurnId,
  importedTurnId: TurnId,
  cutSequence: NonNegativeInt,
  partialMessageIds: Schema.Array(MessageId),
  inFlightActivityIds: Schema.Array(EventId),
  /** Approvals or questions the origin was waiting on; history only. */
  pendingRequests: Schema.Array(Schema.String),
  touchedFiles: Schema.Array(Schema.String),
  sharedWorkspace: Schema.Boolean,
});
export type ThreadForkMidTurnCut = typeof ThreadForkMidTurnCut.Type;

export const ThreadForkedPayload = Schema.Struct({
  originThreadId: ThreadId,
  newThreadId: ThreadId,
  forkAtTurnId: Schema.NullOr(TurnId).pipe(
    Schema.withDecodingDefault(Effect.succeed(TurnId.make("legacy-fork-boundary"))),
  ),
  forkAtTurnCount: NonNegativeInt,
  sourceCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  baselineTurnId: TurnId.pipe(
    Schema.withDecodingDefault(Effect.succeed(TurnId.make("legacy-fork-baseline"))),
  ),
  baselineUserMessageId: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  baselineAssistantMessageId: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  forkPointKind: Schema.Literals(["assistant-response", "user-message", "running-turn"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("assistant-response" as const)),
    Schema.withConstructorDefault(Effect.succeed("assistant-response" as const)),
  ),
  sourceUserMessageId: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  copiedBoundaries: Schema.Array(ThreadForkCopiedBoundary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  workspaceMode: OrchestrationForkWorkspaceMode,
  providerMode: OrchestrationForkProviderMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("transcript-bootstrap" as const)),
  ),
  attachmentCopies: Schema.Array(ThreadForkAttachmentCopy).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * Every destination turn id holding inherited transcript; revert keeps them.
   * Older events omit it: derive it from `copiedBoundaries` and `baselineTurnId`.
   */
  inheritedTurnIds: Schema.optional(Schema.Array(TurnId)),
  /** External source history carried by a fork of imported history. */
  sourceImport: Schema.optional(OrchestrationConversationImportSource),
  midTurnCut: Schema.optional(ThreadForkMidTurnCut),
  createdAt: IsoDateTime,
});
export type ThreadForkedPayload = typeof ThreadForkedPayload.Type;

export const ThreadForkCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  checkpointStatus: OrchestrationForkCheckpointStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("unavailable" as const)),
  ),
  workspaceStatus: OrchestrationForkWorkspaceStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("project-root" as const)),
  ),
});
export type ThreadForkCompletedPayload = typeof ThreadForkCompletedPayload.Type;

/**
 * Closes a `thread.conversation.import` decision, after the thread and its
 * history: the import's provenance and the turns that hold imported history.
 */
export const ThreadConversationImportedPayload = Schema.Struct({
  threadId: ThreadId,
  origin: OrchestrationConversationImport,
  /** Every turn holding imported history; revert keeps them. */
  inheritedTurnIds: Schema.Array(TurnId),
  /** Imported turns that have a response, in order; projected as completed turns. */
  turns: Schema.Array(ThreadConversationImportTurn),
  createdAt: IsoDateTime,
});
export type ThreadConversationImportedPayload = typeof ThreadConversationImportedPayload.Type;
// SCIENT-FORK:END

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

/**
 * Which client connection dispatched the command that produced an event.
 * Stamped by the orchestration engine on client-dispatched commands; absent on
 * provider/server-originated events and on commands from clients too old to
 * report it.
 */
// The client-origin stamp moved to applicationEvent.ts upstream; the two
// definitions were identical, so V1 imports the canonical one.
import { OrchestrationClientOrigin } from "../applicationEvent.ts";
export { OrchestrationClientOrigin };

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
  historyImport: Schema.optional(Schema.Boolean),
  /**
   * The user message was persisted ahead of its turn (worktree bootstrap).
   * Reactors that key off a user message as "turn is starting" wait for the
   * turn-start event instead.
   */
  deferredTurn: Schema.optional(Schema.Boolean),
  origin: Schema.optional(OrchestrationClientOrigin),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.auto-settle-set"),
    payload: ThreadAutoSettleSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-linked"),
    payload: ThreadPullRequestLinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-unlinked"),
    payload: ThreadPullRequestUnlinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-synced"),
    payload: ThreadPullRequestSyncedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  // SCIENT-FORK:START
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.forked"),
    payload: ThreadForkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.fork-completed"),
    payload: ThreadForkCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-imported"),
    payload: ThreadConversationImportedPayload,
  }),
  // SCIENT-FORK:END
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;
