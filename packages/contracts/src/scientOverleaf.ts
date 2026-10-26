import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Overleaf manual sync over HTTP (coordinator contract section 11). Requests
 * name the caller's workspace; the server resolves it and owns every tree,
 * commit, path and credential. Responses carry fixed categories, never a token
 * or Git's own text. See docs/internals/scient-overleaf-engine.md.
 */

export const ScientOverleafFilesystemRefusalReason = Schema.Literals([
  "unsupported-filesystem",
  "unsupported-windows-version",
  "network-filesystem",
  "volatile-filesystem",
  "file-busy",
  "alternate-data-streams",
  "encrypted-file",
  "multiple-hard-links",
  "unsupported-file-owner",
  "unsupported-file-policy",
  "online-only-file",
  "path-too-long",
  "component-too-long",
  "helper-unavailable",
  "identity-unavailable",
  "invalid-encoding",
]);
export type ScientOverleafFilesystemRefusalReason =
  typeof ScientOverleafFilesystemRefusalReason.Type;

const FILESYSTEM_REFUSAL_TEXT: Record<ScientOverleafFilesystemRefusalReason, string> = {
  "unsupported-windows-version":
    "Update this project's server to Windows 10 version 1809 or later, then sync again.",
  "unsupported-filesystem": "Move the project to a supported local disk, then relink it.",
  "network-filesystem":
    "Move the project from the network drive to a supported local disk, then relink it.",
  "volatile-filesystem": "Move the project to a permanent local disk, then relink it.",
  "file-busy": "Close the program using this file, then sync again.",
  "alternate-data-streams":
    "Remove alternate data streams or move an ordinary copy into the project, then sync again.",
  "encrypted-file":
    "Decrypt this file or move an unencrypted copy into the project, then sync again.",
  "unsupported-file-owner":
    "Choose files owned by the account running this project’s server, then sync again.",
  "unsupported-file-policy": "Use a file with a supported Windows access policy, then sync again.",
  "multiple-hard-links": "Replace this hard-linked file with an independent copy, then sync again.",
  "online-only-file": "Download this file from your cloud storage first, then sync again.",
  "path-too-long":
    "Move the project to a shorter path or shorten its folder names, then relink it.",
  "component-too-long": "Shorten this file or folder name, then sync again.",
  "helper-unavailable": "Repair or update Scient on this project's server, then sync again.",
  "identity-unavailable":
    "Reconnect the project's disk or move the project to a supported local disk, then relink it.",
  "invalid-encoding": "Rename the file or folder with a valid Unicode name, then sync again.",
};

export function overleafFilesystemRefusalText(reason: string): string | null {
  return Object.hasOwn(FILESYSTEM_REFUSAL_TEXT, reason)
    ? FILESYSTEM_REFUSAL_TEXT[reason as ScientOverleafFilesystemRefusalReason]
    : null;
}

/** A component is preserved verbatim; validation never repairs a filesystem name. */
export function overleafNameProblem(name: string): "component-too-long" | "invalid-name" | null {
  if (name.length > 255 || new TextEncoder().encode(name).length > 255) return "component-too-long";
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    /[\uD800-\uDFFF]/u.test(name) ||
    /^ |[ .]$/u.test(name) ||
    /[<>:"/\\|?*]/u.test(name) ||
    [...name].some(
      (character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
    ) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)
  )
    return "invalid-name";
  return null;
}

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
  Schema.TaggedStruct("requested", { operationId: Schema.String }),
  Schema.TaggedStruct("nothing-running", {}),
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
  Schema.TaggedStruct("done", {
    connection: ScientOverleafConnectionSummary,
    reconnected: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("refused", { reason: Schema.String }),
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
      Schema.TaggedStruct("read", {
        changed: Schema.Number,
        deleted: Schema.Number,
        added: Schema.Number,
      }),
      Schema.TaggedStruct("unread", { reason: Schema.String }),
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
  Schema.TaggedStruct("review", {
    review: ScientOverleafReview,
    settled: ScientOverleafSettled,
  }),
  Schema.TaggedStruct("refused", {
    refusal: ScientOverleafRefusal,
    settled: ScientOverleafSettled,
  }),
  Schema.TaggedStruct("recovered", {}),
]);
export type ScientOverleafPreviewResult = typeof ScientOverleafPreviewResult.Type;

export const ScientOverleafSyncResult = Schema.Union([
  Schema.TaggedStruct("synced", {
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
  Schema.TaggedStruct("needs-decision", {
    review: ScientOverleafReview,
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
    activity: OtherAgents,
    linkedElsewhere: Schema.Boolean,
  }),
  Schema.TaggedStruct("refused", {
    refusal: ScientOverleafRefusal,
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
  }),
  Schema.TaggedStruct("duplicate", { category: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("unsettled", {
    reason: Schema.String,
    retried: Schema.Boolean,
    settled: ScientOverleafSettled,
  }),
  Schema.TaggedStruct("cancelled", {
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
      /** Absolute location on the project's machine. */
      path: Schema.String,
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
  Schema.TaggedStruct("restored", { outcome: ScientOverleafApplyOutcome }),
  Schema.Struct({ _tag: Schema.Literals(["stale", "unknown-copy", "duplicate"]) }),
]);
export type ScientOverleafRestoreResult = typeof ScientOverleafRestoreResult.Type;

export const ScientOverleafUndoRequest = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  connectionId: ConnectionId,
  requestId: RequestId,
  /** The accepted send to undo, by its number (`send #N` in a sync result). */
  attemptNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The pending per-file decisions, which the sync after the undo carries like any sync. */
  files: Schema.optional(FileDecisions),
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

/** An undo: what it put back and every path left alone with why; `outcome` is how
 * its apply ended (null if nothing was written) and `sync` the sync that followed.
 * A partway/replanned apply is not synced (`not-synced`): nothing was sent. */
export const ScientOverleafUndoResult = Schema.Union([
  Schema.TaggedStruct("undone", {
    /** Files the send changed, back to Overleaf's earlier version. */
    restored: Schema.Array(ManuscriptPath),
    /** Files the send added, removed. */
    removed: Schema.Array(ManuscriptPath),
    /** Files the send deleted, written again. */
    recreated: Schema.Array(ManuscriptPath),
    skipped: Schema.Array(
      Schema.Struct({
        path: ManuscriptPath,
        reason: Schema.Literals([
          "changed",
          "already-undone",
          "name-clash",
          "too-large",
          "kept-only-here",
        ]),
      }),
    ),
    outcome: Schema.NullOr(ScientOverleafApplyOutcome),
    sync: Schema.Union([
      ScientOverleafSyncResult,
      Schema.TaggedStruct("not-synced", {
        reason: Schema.Literal("undo-incomplete"),
      }),
    ]),
  }),
  Schema.TaggedStruct("not-eligible", {
    reason: Schema.Literals([
      "not-recorded",
      "unresolved",
      "not-sent",
      "out-of-date",
      "history-unavailable",
    ]),
  }),
  Schema.TaggedStruct("refused", { refusal: ScientOverleafRefusal }),
  Schema.TaggedStruct("duplicate", {}),
  /** Stopped on request after saving editors, before anything was put back. */
  Schema.TaggedStruct("cancelled", {}),
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
