import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Overleaf manual sync over HTTP (coordinator contract section 11). Requests
 * name the caller's workspace; the server resolves it and owns every tree,
 * commit, path and credential. Responses carry fixed categories, never a token
 * or Git's own text. See docs/internals/scient-overleaf-engine.md.
 */

const WorkspaceRoot = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const ConnectionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u));
const RequestId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/u));
const RelativeFolder = Schema.String.check(Schema.isMaxLength(4_096));
const ManuscriptPath = Schema.String.check(Schema.isMaxLength(4_096));

export const ScientOverleafConflictChoice = Schema.Literals(["mine", "theirs", "markers"]);
export type ScientOverleafConflictChoice = typeof ScientOverleafConflictChoice.Type;

export const ScientOverleafTokenStatus = Schema.Struct({ saved: Schema.Boolean });
export type ScientOverleafTokenStatus = typeof ScientOverleafTokenStatus.Type;

export const ScientOverleafSaveTokenRequest = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export type ScientOverleafSaveTokenRequest = typeof ScientOverleafSaveTokenRequest.Type;

export const ScientOverleafWorkspaceRequest = Schema.Struct({ workspaceRoot: WorkspaceRoot });
export type ScientOverleafWorkspaceRequest = typeof ScientOverleafWorkspaceRequest.Type;

export const ScientOverleafConnectionRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
});
export type ScientOverleafConnectionRequest = typeof ScientOverleafConnectionRequest.Type;

export const ScientOverleafConnectRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  /** Relative to the workspace; empty links the workspace itself. */
  folder: RelativeFolder,
  /** Create the folder and bring the project in, rather than link an existing folder. */
  create: Schema.Boolean,
  /** An Overleaf project link or ID. */
  project: Schema.String.check(Schema.isMaxLength(2_048)),
  requestId: RequestId,
});
export type ScientOverleafConnectRequest = typeof ScientOverleafConnectRequest.Type;

/**
 * Per-file decisions: keep new files only here, send skipped or kept-only files,
 * or send files held back for their conflict marks as they are (`release`).
 */
const FileDecisions = Schema.Struct({
  keepOnlyHere: Schema.optional(Schema.Array(ManuscriptPath).check(Schema.isMaxLength(2_000))),
  send: Schema.optional(Schema.Array(ManuscriptPath).check(Schema.isMaxLength(2_000))),
  release: Schema.optional(Schema.Array(ManuscriptPath).check(Schema.isMaxLength(2_000))),
});

const Choice = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(200)),
  choice: ScientOverleafConflictChoice,
});

export const ScientOverleafPreviewRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  choices: Schema.optional(Schema.Array(Choice).check(Schema.isMaxLength(4_000))),
  files: Schema.optional(FileDecisions),
});
export type ScientOverleafPreviewRequest = typeof ScientOverleafPreviewRequest.Type;

export const ScientOverleafSyncRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  requestId: RequestId,
  choices: Schema.optional(Schema.Array(Choice).check(Schema.isMaxLength(4_000))),
  files: Schema.optional(FileDecisions),
  /** The `remoteTree` of the review whose conflicts `choices` answer. */
  reviewedRemote: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u))),
});
export type ScientOverleafSyncRequest = typeof ScientOverleafSyncRequest.Type;

export const ScientOverleafRelinkRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  folder: RelativeFolder,
  requestId: RequestId,
});
export type ScientOverleafRelinkRequest = typeof ScientOverleafRelinkRequest.Type;

export const ScientOverleafDisconnectRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  requestId: RequestId,
});
export type ScientOverleafDisconnectRequest = typeof ScientOverleafDisconnectRequest.Type;

export const ScientOverleafCancelResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("requested"), operationId: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("nothing-running") }),
]);
export type ScientOverleafCancelResult = typeof ScientOverleafCancelResult.Type;

export const ScientOverleafRestoreRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  requestId: RequestId,
  applyId: Schema.String.check(Schema.isMaxLength(64)),
  kept: Schema.String.check(Schema.isMaxLength(256)),
  keptRevision: Schema.String.check(Schema.isMaxLength(100)),
  currentRevision: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
});
export type ScientOverleafRestoreRequest = typeof ScientOverleafRestoreRequest.Type;

export const ScientOverleafConnectionSummary = Schema.Struct({
  connectionId: Schema.String,
  checkoutRoot: Schema.String,
  folder: Schema.String,
  projectId: Schema.String,
  branch: Schema.Literals(["main", "master"]),
  state: Schema.Literals(["active", "archived"]),
  completedSyncCount: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ScientOverleafConnectionSummary = typeof ScientOverleafConnectionSummary.Type;

export const ScientOverleafConnectionList = Schema.Struct({
  connections: Schema.Array(
    Schema.Struct({ ...ScientOverleafConnectionSummary.fields, linkedHere: Schema.Boolean }),
  ),
});
export type ScientOverleafConnectionList = typeof ScientOverleafConnectionList.Type;

/** Connect, relink or disconnect: done, or a fixed reason it did nothing. */
export const ScientOverleafManageResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("done"),
    connection: ScientOverleafConnectionSummary,
    reconnected: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ _tag: Schema.Literal("refused"), reason: Schema.String }),
]);
export type ScientOverleafManageResult = typeof ScientOverleafManageResult.Type;

export const ScientOverleafStatus = Schema.Struct({
  connection: ScientOverleafConnectionSummary,
  availability: Schema.Literals([
    "ready",
    "recovery-required",
    "attention",
    "unavailable",
    "disconnected",
  ]),
  reasons: Schema.Array(Schema.String),
  local: Schema.NullOr(
    Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("read"),
        changed: Schema.Number,
        deleted: Schema.Number,
        added: Schema.Number,
      }),
      Schema.Struct({ _tag: Schema.Literal("unread"), reason: Schema.String }),
    ]),
  ),
  markerPaths: Schema.Array(ManuscriptPath),
  unresolvedSends: Schema.Number,
  keptCopies: Schema.Number,
  busy: Schema.Boolean,
  linkedElsewhere: Schema.Boolean,
});
export type ScientOverleafStatus = typeof ScientOverleafStatus.Type;

export const ScientOverleafChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["added", "deleted", "modified"]), path: ManuscriptPath }),
  Schema.Struct({ kind: Schema.Literal("renamed"), from: ManuscriptPath, to: ManuscriptPath }),
]);
export type ScientOverleafChange = typeof ScientOverleafChange.Type;

/** A review warning: what the sync result reports. `kind` names it; the rest locates it. */
export const ScientOverleafWarning = Schema.Struct({
  kind: Schema.String,
  path: Schema.optional(ManuscriptPath),
  from: Schema.optional(ManuscriptPath),
  to: Schema.optional(ManuscriptPath),
  bytes: Schema.optional(Schema.Number),
  attemptNumber: Schema.optional(Schema.Number),
});
export type ScientOverleafWarning = typeof ScientOverleafWarning.Type;

export const ScientOverleafReview = Schema.Struct({
  reviewId: Schema.String,
  digest: Schema.String,
  remoteTree: Schema.String,
  upToDate: Schema.Boolean,
  needsDecision: Schema.Boolean,
  incoming: Schema.Array(ScientOverleafChange),
  outgoing: Schema.Array(ScientOverleafChange),
  conflicts: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      paths: Schema.Array(ManuscriptPath),
      allowed: Schema.Array(ScientOverleafConflictChoice),
      chosen: Schema.NullOr(ScientOverleafConflictChoice),
    }),
  ),
  warnings: Schema.Array(ScientOverleafWarning),
  /** Files held back for their conflict marks: they wait, everything else is sent. */
  unresolvedMarkers: Schema.Array(ManuscriptPath),
  /** Files with marks this review sends as they are, as `files.release` asked. */
  released: Schema.Array(ManuscriptPath),
  collisions: Schema.Array(ManuscriptPath),
  selectedAdditions: Schema.Array(ManuscriptPath),
  additions: Schema.Array(
    Schema.Struct({
      path: ManuscriptPath,
      size: Schema.Number,
      selected: Schema.Boolean,
      skippedBecause: Schema.NullOr(Schema.String),
    }),
  ),
  localOnly: Schema.Array(ManuscriptPath),
});
export type ScientOverleafReview = typeof ScientOverleafReview.Type;

/** Why a review could not be built: the engine's fixed reason and the path it concerns. */
export const ScientOverleafRefusal = Schema.Struct({
  reason: Schema.String,
  path: Schema.optional(ManuscriptPath),
});
export type ScientOverleafRefusal = typeof ScientOverleafRefusal.Type;

export const ScientOverleafPublication = Schema.Struct({
  _tag: Schema.Literals([
    "none",
    "blocked",
    "not-verified",
    "not-sent",
    "accepted",
    "out-of-date",
    "unknown",
  ]),
  reason: Schema.optional(Schema.String),
  attemptNumber: Schema.optional(Schema.Number),
});
export type ScientOverleafPublication = typeof ScientOverleafPublication.Type;

const OtherAgents = Schema.NullOr(
  Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
);

/**
 * An interrupted earlier sync this operation finished first, which wrote the
 * folder, and how its apply ended (`complete`, `replan` or `attention`).
 */
const ScientOverleafSettledApply = Schema.Struct({
  outcome: Schema.String,
  interrupted: Schema.Number,
  markerPaths: Schema.Array(ManuscriptPath),
});
const ScientOverleafSettled = Schema.NullOr(ScientOverleafSettledApply);

export const ScientOverleafPreviewResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("review"),
    review: ScientOverleafReview,
    settled: ScientOverleafSettled,
  }),
  Schema.Struct({
    _tag: Schema.Literal("refused"),
    refusal: ScientOverleafRefusal,
    settled: ScientOverleafSettled,
  }),
  Schema.Struct({ _tag: Schema.Literal("recovered") }),
]);
export type ScientOverleafPreviewResult = typeof ScientOverleafPreviewResult.Type;

export const ScientOverleafSyncResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("synced"),
    review: ScientOverleafReview,
    outcome: Schema.String,
    interrupted: Schema.Number,
    markerPaths: Schema.Array(ManuscriptPath),
    publication: ScientOverleafPublication,
    /** The first attempt applied a review, and Overleaf moved while sending (nothing sent). */
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
    activity: OtherAgents,
    linkedElsewhere: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.Literal("needs-decision"),
    review: ScientOverleafReview,
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
    activity: OtherAgents,
    linkedElsewhere: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.Literal("refused"),
    refusal: ScientOverleafRefusal,
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
  }),
  Schema.Struct({ _tag: Schema.Literal("duplicate"), category: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    _tag: Schema.Literal("unsettled"),
    reason: Schema.String,
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
  }),
  Schema.Struct({
    _tag: Schema.Literal("cancelled"),
    stage: Schema.Literals(["before-prepare", "before-apply"]),
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
  }),
]);
export type ScientOverleafSyncResult = typeof ScientOverleafSyncResult.Type;

export const ScientOverleafRecoverResult = Schema.Struct({
  recovered: Schema.Boolean,
  /** Null when Overleaf could not be reached to check earlier sends. */
  accepted: Schema.NullOr(Schema.Array(Schema.Number)),
  unresolved: Schema.NullOr(Schema.Array(Schema.Number)),
});
export type ScientOverleafRecoverResult = typeof ScientOverleafRecoverResult.Type;

export const ScientOverleafKeptCopies = Schema.Struct({
  copies: Schema.Array(
    Schema.Struct({
      applyId: Schema.String,
      kept: Schema.String,
      relativePath: ManuscriptPath,
      state: Schema.String,
      retainedAt: Schema.String,
      revision: Schema.NullOr(Schema.String),
      keptRevision: Schema.NullOr(Schema.String),
      currentRevision: Schema.NullOr(Schema.String),
      unread: Schema.Boolean,
    }),
  ),
});
export type ScientOverleafKeptCopies = typeof ScientOverleafKeptCopies.Type;

/** How a local apply (a kept-copy restore, an undo) ended. */
const ScientOverleafApplyOutcome = Schema.Literals(["complete", "replan", "attention"]);

/**
 * A kept-copy restore. `restored` ran its apply, and `outcome` says how it ended:
 * only `complete` put the copy back; `replan` wrote nothing (the folder changed
 * first); `attention` may have stopped partway. The others wrote nothing.
 */
export const ScientOverleafRestoreResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("restored"), outcome: ScientOverleafApplyOutcome }),
  Schema.Struct({ _tag: Schema.Literals(["stale", "unknown-copy", "duplicate"]) }),
]);
export type ScientOverleafRestoreResult = typeof ScientOverleafRestoreResult.Type;

export const ScientOverleafUndoRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  requestId: RequestId,
  /** The accepted send to undo, by its number (`send #N` in a sync result). */
  attemptNumber: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientOverleafUndoRequest = typeof ScientOverleafUndoRequest.Type;

/** Sends Undo can put back, newest first, each with what it changed on Overleaf. */
export const ScientOverleafUndoableSends = Schema.Struct({
  sends: Schema.Array(
    Schema.Struct({
      attemptNumber: Schema.Number,
      recordedAt: Schema.String,
      changes: Schema.Array(ScientOverleafChange),
    }),
  ),
});
export type ScientOverleafUndoableSends = typeof ScientOverleafUndoableSends.Type;

/**
 * An undo (design section 4.3). `undone` lists what it set out to put back and
 * every path it left alone, with why; `outcome` is how its apply ended (null when
 * every path was skipped and nothing was written), and `sync` the sync that sent
 * the restored files, run only when the apply completed.
 */
export const ScientOverleafUndoResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("undone"),
    /** Files the send changed, back to Overleaf's earlier version. */
    restored: Schema.Array(ManuscriptPath),
    /** Files the send added, removed. */
    removed: Schema.Array(ManuscriptPath),
    /** Files the send deleted, written again. */
    recreated: Schema.Array(ManuscriptPath),
    skipped: Schema.Array(
      Schema.Struct({
        path: ManuscriptPath,
        reason: Schema.Literals(["changed", "already-undone", "name-clash", "too-large"]),
      }),
    ),
    outcome: Schema.NullOr(ScientOverleafApplyOutcome),
    sync: Schema.NullOr(ScientOverleafSyncResult),
  }),
  Schema.Struct({
    _tag: Schema.Literal("not-eligible"),
    reason: Schema.Literals([
      "not-recorded",
      "unresolved",
      "not-sent",
      "out-of-date",
      "history-unavailable",
    ]),
  }),
  Schema.Struct({ _tag: Schema.Literal("refused"), refusal: ScientOverleafRefusal }),
  Schema.Struct({ _tag: Schema.Literal("duplicate") }),
]);
export type ScientOverleafUndoResult = typeof ScientOverleafUndoResult.Type;

/**
 * An Overleaf operation that did not run, with a fixed reason: another one holds
 * the connection, the token is missing, an open editor could not save, and so on.
 */
export class ScientOverleafOperationError extends Schema.TaggedError<ScientOverleafOperationError>()(
  "ScientOverleafOperationError",
  {
    reason: Schema.String,
    message: Schema.String,
    /** For `editor-unsaved`: the files that could not be saved, relative to the checkout. */
    paths: Schema.optional(Schema.Array(ManuscriptPath)),
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientOverleafOperationError)(this, { status: 409 });
  }
}
