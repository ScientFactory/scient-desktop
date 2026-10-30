import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { WorkspaceScope } from "@scientfactory/operations";

import {
  ComputeDiagnostic,
  ComputeEnvironmentFingerprint,
  ComputeExecutionId,
  ComputeExecutionOutcome,
  ComputeExecutionStatus,
  ComputeLanguageId,
  ComputeOutput,
  ComputeRuntimeIdentity,
  ComputeRuntimeProfile,
  ComputeSessionActivity,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeSessionStatus,
  ComputeTransportKind,
} from "./contract.ts";
import {
  ByteLength,
  ContentHash,
  Count,
  EntityId,
  Label,
  ObservedAt,
  Sequence,
  ShortText,
  StreamText,
} from "./primitives.ts";

/**
 * Separate durable records from live transport events while sharing bounds. History must retain
 * submitted code/context/outcome across runtime loss; transient image bytes must never enter those
 * snapshots.
 */

/** A project identifier as the server knows it, used as a storage segment. */
export const ComputeProjectId = EntityId.pipe(Schema.brand("ComputeProjectId"));
export type ComputeProjectId = typeof ComputeProjectId.Type;

/** Where in a document an execution came from. Zero-based, end-exclusive. */
export const ComputeSourceRange = Schema.Struct({
  startLine: Count,
  startColumn: Count,
  endLine: Count,
  endColumn: Count,
}).check(
  Schema.makeFilter(
    (range) =>
      range.endLine > range.startLine ||
      (range.endLine === range.startLine && range.endColumn >= range.startColumn),
    { expected: "an ordered, end-exclusive source range" },
  ),
);
export type ComputeSourceRange = typeof ComputeSourceRange.Type;

/**
 * Store exact submitted code regardless of buffer state. Dirty bytes must not be attributed to
 * saved source; revision names only the saved base and detects moved ranges. Use a union so console
 * origin cannot accidentally carry a document locator.
 */
export const ComputeExecutionSource = Schema.Union([
  Schema.TaggedStruct("console", {}),
  Schema.TaggedStruct("document", {
    origin: Schema.Literals(["file", "selection", "cell"]),
    path: ShortText,
    bufferState: Schema.Literals(["saved", "dirty"]),
    revision: Schema.NullOr(Label),
    range: Schema.NullOr(ComputeSourceRange),
    /** The notebook cell this run belongs to. */
    cell: Schema.optional(ShortText),
  }),
]);
export type ComputeExecutionSource = typeof ComputeExecutionSource.Type;

/** Whether a session's bulky data is still on disk. */
/** What a session belongs to: a file tab, or an agent's own session in a thread. */
export const ComputeSessionOwner = Schema.Union([
  Schema.TaggedStruct("file", { path: ShortText }),
  Schema.TaggedStruct("agent", { threadId: EntityId }),
]);
export type ComputeSessionOwner = typeof ComputeSessionOwner.Type;

/** Who submitted an execution. Absent means the user. */
export const ComputeExecutionActor = Schema.TaggedStruct("agent", { threadId: EntityId });
export type ComputeExecutionActor = typeof ComputeExecutionActor.Type;

export const ComputeSessionStorage = Schema.Struct({
  status: Schema.Literals(["retained", "metadata-only"]),
  outputBytes: ByteLength,
  imageBytes: ByteLength,
  totalBytes: ByteLength,
  removedAt: Schema.NullOr(ObservedAt),
});
export type ComputeSessionStorage = typeof ComputeSessionStorage.Type;

export const EMPTY_COMPUTE_SESSION_STORAGE: ComputeSessionStorage = {
  status: "retained",
  outputBytes: 0,
  imageBytes: 0,
  totalBytes: 0,
  removedAt: null,
};

/**
 * Persist activeExecutionId/pendingCount as recovery evidence rather than deriving them from all
 * execution files. A recorded active execution proves something must become lost after restart.
 */
export const ComputeSessionRecord = Schema.Struct({
  sessionId: ComputeSessionId,
  projectId: ComputeProjectId,
  label: Label,
  /** Absent on sessions from before ownership was recorded. */
  owner: Schema.optional(ComputeSessionOwner),
  /** Absent on historical and persistent sessions. Fresh is a lifetime, not a sandbox. */
  lifetime: Schema.optional(Schema.Literal("fresh")),
  languageId: ComputeLanguageId,
  transportKind: ComputeTransportKind,
  workingDirectory: ShortText,
  /** Host-local workspace ownership. Absent on legacy history, never inferred from projectId. */
  workspace: Schema.optional(WorkspaceScope),
  // Null until the runtime has been chosen, and again after a record is
  // recovered from a version that could not have chosen one.
  runtime: Schema.NullOr(ComputeRuntimeProfile),
  // Null until the runtime answers: this is what did reply, not what was asked
  // for, and before the handshake completes nothing has replied.
  identity: Schema.NullOr(ComputeRuntimeIdentity),
  environmentFingerprint: Schema.NullOr(ComputeEnvironmentFingerprint),
  generation: ComputeSessionGeneration,
  status: ComputeSessionStatus,
  activity: ComputeSessionActivity,
  activeExecutionId: Schema.NullOr(ComputeExecutionId),
  pendingCount: Count,
  storage: ComputeSessionStorage,
  createdAt: ObservedAt,
  lastActivityAt: ObservedAt,
  closedAt: Schema.NullOr(ObservedAt),
  lostReason: Schema.NullOr(ShortText),
});
export type ComputeSessionRecord = typeof ComputeSessionRecord.Type;

/**
 * Keep requests immutable and separate from mutable results so a crash cannot erase submitted work.
 * Request-without-result proves in-flight execution and must recover as lost.
 */
export const ComputeExecutionRequestRecord = Schema.Struct({
  executionId: ComputeExecutionId,
  sessionId: ComputeSessionId,
  generation: ComputeSessionGeneration,
  code: StreamText,
  codeHash: ContentHash,
  source: ComputeExecutionSource,
  actor: Schema.optional(ComputeExecutionActor),
  submittedAt: ObservedAt,
  environmentFingerprint: Schema.NullOr(ComputeEnvironmentFingerprint),
});
export type ComputeExecutionRequestRecord = typeof ComputeExecutionRequestRecord.Type;

/**
 * What became of a submitted execution.
 *
 * `queuePosition` is stored rather than computed on read. A client that was
 * told it is third in line has to keep being told the same thing, and a
 * position recomputed from a list that has since changed is a different number.
 */
export const ComputeExecutionResultRecord = Schema.Struct({
  executionId: ComputeExecutionId,
  status: ComputeExecutionStatus,
  outcome: Schema.NullOr(ComputeExecutionOutcome),
  queuePosition: Schema.NullOr(Count),
  startedAt: Schema.NullOr(ObservedAt),
  finishedAt: Schema.NullOr(ObservedAt),
  diagnostics: Schema.Array(ComputeDiagnostic).check(Schema.isMaxLength(64)),
  outputCount: Count,
  /** Retained image outputs, summarized so result selection never scans transcripts. */
  imageCount: Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  outputBytes: ByteLength,
  truncated: Schema.Boolean,
  failureReason: Schema.NullOr(ShortText),
});
export type ComputeExecutionResultRecord = typeof ComputeExecutionResultRecord.Type;

/**
 * Model a missing result explicitly so recovery, not silent reader defaults, decides how a
 * persisted-but-unsettled request ended.
 */
export const ComputeExecutionRecord = Schema.Struct({
  request: ComputeExecutionRequestRecord,
  result: Schema.NullOr(ComputeExecutionResultRecord),
});
export type ComputeExecutionRecord = typeof ComputeExecutionRecord.Type;

/**
 * What happened to a session, in the order it happened.
 *
 * The journal is append-only and is never read to answer a question the session
 * record already answers. It exists so an operator can reconstruct why a
 * session ended up in a state, which a snapshot by definition cannot say.
 */
export const ComputeSessionJournalEvent = Schema.Literals([
  "session-created",
  "session-ready",
  "session-restarted",
  "session-stopping",
  "session-stopped",
  "session-failed",
  "session-lost",
  "session-recovered",
  "session-unresponsive",
  "execution-submitted",
  "execution-started",
  "execution-finished",
  "execution-cancelled",
  "queue-rejected",
  "storage-trimmed",
]);
export type ComputeSessionJournalEvent = typeof ComputeSessionJournalEvent.Type;

export const ComputeSessionJournalEntry = Schema.Struct({
  sequence: Sequence,
  observedAt: ObservedAt,
  event: ComputeSessionJournalEvent,
  generation: ComputeSessionGeneration,
  executionId: Schema.NullOr(ComputeExecutionId),
  detail: Schema.NullOr(ShortText),
});
export type ComputeSessionJournalEntry = typeof ComputeSessionJournalEntry.Type;

/**
 * Names one stored compute representation without naming a file.
 *
 * The content hash is the identity, and the file name is derived from it. A
 * reference that carried a file name would let a corrupted record choose which
 * file the server opens.
 */
export const ComputeOutputResourceRef = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  // Null for a resource a session produced outside any execution. Rare -- a
  // background thread drawing a figure -- but the transport allows it, and a
  // reference that could not express it would make such an image permanently
  // unreachable rather than merely unusual.
  executionId: Schema.NullOr(ComputeExecutionId),
  contentHash: ContentHash,
});
export type ComputeOutputResourceRef = typeof ComputeOutputResourceRef.Type;

/**
 * eventSequence belongs only to one subscription, not durable/global identity. On gaps, reread
 * durable APIs before later deltas; discard snapshot-covered events. Notifications accelerate
 * reading but never authorize transcript truth.
 */
export const ComputeSessionStreamEvent = Schema.Union([
  Schema.TaggedStruct("session-snapshot", {
    eventSequence: Sequence,
    session: ComputeSessionRecord,
  }),
  Schema.TaggedStruct("session-updated", {
    eventSequence: Sequence,
    session: ComputeSessionRecord,
  }),
  Schema.TaggedStruct("execution-updated", {
    eventSequence: Sequence,
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    execution: ComputeExecutionRecord,
  }),
  Schema.TaggedStruct("execution-output", {
    eventSequence: Sequence,
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    // Null for output that belongs to the session rather than to a command.
    // Attributing a stray thread's print to whichever cell happens to be
    // running would put one execution's output inside another's transcript.
    executionId: Schema.NullOr(ComputeExecutionId),
    outputs: Schema.Array(ComputeOutput),
  }),
]);
export type ComputeSessionStreamEvent = typeof ComputeSessionStreamEvent.Type;
