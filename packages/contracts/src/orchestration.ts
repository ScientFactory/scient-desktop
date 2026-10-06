import {
  OrchestrationMessageRole,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  SourceProposedPlanReference,
  OrchestrationThreadActivity,
  OrchestrationLatestTurn,
} from "./scientConversationView.ts";
export * from "./scientConversationView.ts";
import {
  OrchestrationForkWorkspaceMode,
  ThreadForkCommand,
  ThreadForkAttachmentCopy,
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
import { ScientCompletedAnswer } from "./scientAnswerAttention.ts";
export { ForkDisposition, OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import {
  OrchestrationConversationImport,
  OrchestrationConversationImportSource,
  OrchestrationForkLineage,
} from "./scientConversationOrigin.ts";
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
import * as SchemaTransformation from "effect/SchemaTransformation";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  // SCIENT-FORK:START
  ThreadSectionId,
  // SCIENT-FORK:END
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getForkOptions: "orchestration.getForkOptions",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

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

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to t3.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  // Optional on the wire so cached snapshots from older servers still decode.
  autoPull: Schema.optional(Schema.Boolean),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

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

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

// SCIENT-FORK:START — conversation completion is independent from Git state.
export const OrchestrationForkBoundary = Schema.Struct({
  // Turn zero has no provider turn identity yet. Later boundaries carry the
  // completed turn id so clients can reject a stale count after a rewrite.
  turnId: Schema.NullOr(TurnId),
  conversationTurnCount: NonNegativeInt,
  userMessageId: Schema.NullOr(MessageId),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
});
export type OrchestrationForkBoundary = typeof OrchestrationForkBoundary.Type;
export const isForkBaselineBoundary = (boundary: OrchestrationForkBoundary): boolean =>
  boundary.conversationTurnCount === 0 && boundary.turnId !== null;

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
// SCIENT-FORK:END

// Version changes even when a manual rename keeps the same text.
export const ThreadTitleState = Schema.Struct({
  source: Schema.Literals(["manual", "generated"]),
  version: CommandId,
  needsRefinement: Schema.Boolean,
});
export type ThreadTitleState = typeof ThreadTitleState.Type;

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

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  workspaceRoot: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  // Optional so payloads from pre-link servers still decode.
  pullRequests: Schema.Array(ThreadPullRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  // Scient: optional for compatibility with older servers and cached snapshots.
  latestCompletedAnswer: Schema.optional(Schema.NullOr(ScientCompletedAnswer)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the thread last re-entered the active list (any thread.unsettled).
  // Anchors the active-list sort so an unsettled thread surfaces at the top
  // instead of sinking back to its creation-order slot. Cleared on settle.
  // Optional so payloads from pre-stamp servers still decode.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Active pinned threads render in the pinned block. Settled and snoozed
  // threads remain in their respective shelves even when pinned.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Manual Active placement. Keyless threads retain their creation/re-entry
  // order above the arranged run. Settling clears this slot.
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // SCIENT-FORK:START — user-defined section. Independent of lifecycle state;
  // optional so snapshots from servers without sections still decode.
  sectionId: Schema.optional(Schema.NullOr(ThreadSectionId)),
  // SCIENT-FORK:END
  // Set while the user has turned automatic settlement off for this thread.
  // Survives manual settle, un-settle, and activity: only the user clears it.
  // Optional so payloads from older servers still decode.
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  // Legacy decode-only residue for older cached snapshots. Current servers no
  // longer populate this array; fork authority comes from SQL resolution and
  // the narrow `forkLineage` marker. Removable after older cache epochs age out.
  conversationForkBoundaries: Schema.optional(Schema.Array(OrchestrationForkBoundary)),
  // Narrow lineage marker for forked threads. Absent on plain threads and
  // old servers; survives shell/detail reloads, windowing, and sequence gaps.
  forkLineage: Schema.optional(Schema.NullOr(OrchestrationForkLineage)),
  // SCIENT-FORK:START — set on threads created by a conversation import.
  conversationImport: Schema.optional(Schema.NullOr(OrchestrationConversationImport)),
  // SCIENT-FORK:END
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

// The project shell moved to orchestrationProject.ts upstream; the two
// definitions were identical field for field, so V1 imports the canonical one.
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
export { OrchestrationProjectShell };

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  workspaceRoot: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.Array(ThreadPullRequestLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  // Scient: optional for compatibility with older servers and cached snapshots.
  latestCompletedAnswer: Schema.optional(Schema.NullOr(ScientCompletedAnswer)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // See OrchestrationThread.unsettledAt: last re-entry into the active list.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // SCIENT-FORK:START — user-defined section. Independent of lifecycle state;
  // optional so snapshots from servers without sections still decode.
  sectionId: Schema.optional(Schema.NullOr(ThreadSectionId)),
  // SCIENT-FORK:END
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
  // Narrow fork-lineage marker for shell rows. Absent on plain threads and
  // old servers; the shell snapshot populates it from scient_thread_lineage.
  forkLineage: Schema.optional(Schema.NullOr(OrchestrationForkLineage)),
  // SCIENT-FORK:START — set on threads created by a conversation import.
  conversationImport: Schema.optional(Schema.NullOr(OrchestrationConversationImport)),
  // SCIENT-FORK:END
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** Opt in to reasoning roles; older clients receive system messages instead. */
  reasoningMessages: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

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
import { OrchestrationClientOrigin } from "./applicationEvent.ts";
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

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

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

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

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
