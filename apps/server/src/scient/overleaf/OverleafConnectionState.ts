/**
 * Durable state of one manual Overleaf connection, and the rules every
 * replacement of it must keep. The coordinator owns transitions; this module
 * owns the record's shape and the evidence-preservation invariants that a
 * transition can never break, whatever caused it.
 *
 * Ephemeral reviews are deliberately absent: they never survive a restart.
 */
import * as Schema from "effect/Schema";

import { manuscriptPathProblem } from "./manuscriptPaths.ts";

export const OVERLEAF_CONNECTION_SCHEMA_VERSION = 1;
/** Prior bases kept reachable for recovery classification. */
export const PRIOR_BASE_LIMIT = 20;
export const LOCAL_SNAPSHOT_LIMIT = 10;
/** Unresolved publication attempts kept before new work is refused. */
export const UNRESOLVED_ATTEMPT_LIMIT = 16;
const MANAGED_PATH_LIMIT = 2_000;

const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u));
/** Server-generated identifiers. Never accepted from a client as a storage name. */
export const OverleafServerId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const IsoTime = Schema.String.check(Schema.isMaxLength(40));
const PhysicalIdentity = Schema.Struct({
  dev: Schema.String.check(Schema.isPattern(/^\d{1,40}$/u)),
  ino: Schema.String.check(Schema.isPattern(/^\d{1,40}$/u)),
});
const ManuscriptPath = Schema.String.check(
  Schema.makeFilter((path: string) => manuscriptPathProblem(path) === null),
);
/** The manuscript folder relative to the checkout root; "" is the root itself. */
const FolderPath = Schema.String.check(
  Schema.makeFilter((path: string) => path === "" || manuscriptPathProblem(path) === null),
);

const Snapshot = Schema.Struct({ commit: Schema.NullOr(Oid), tree: Oid, generation: Count });

export const OverleafApplyKind = Schema.Literals(["sync-apply", "retained-restore"]);

/** The connection's pointer to an applier intent that may still need recovery. */
const ApplyLink = Schema.Struct({
  applyId: OverleafServerId,
  kind: OverleafApplyKind,
  operationId: OverleafServerId,
  planDigest: Digest,
  /** Base generation the intent was planned against. */
  baseGeneration: Count,
  /** Pinned private ref holding the immutable target tree. */
  intentTree: Oid,
});

export const OverleafAttemptOutcome = Schema.Literals([
  /** Recorded before the send boundary; acceptance not established. */
  "unknown",
  /** Positive evidence: explicit acceptance, or the candidate found remotely. */
  "accepted",
  /** Overleaf said plainly that its branch had moved. Nothing was applied. */
  "out-of-date",
  /** Scient refused to start sending (checkout changed); certain, never inferred. */
  "not-sent",
  /** A later reviewed operation advanced the base; acceptance still unestablished. */
  "superseded-unresolved",
]);
export type OverleafAttemptOutcome = typeof OverleafAttemptOutcome.Type;

const PublicationAttempt = Schema.Struct({
  attemptNumber: Positive,
  operationId: OverleafServerId,
  requestId: OverleafServerId,
  planDigest: Digest,
  branch: Schema.Literals(["main", "master"]),
  parentCommit: Oid,
  candidateCommit: Oid,
  candidateTree: Oid,
  baseGeneration: Count,
  outcome: OverleafAttemptOutcome,
  /** How a definite outcome was established; null while unknown. */
  evidence: Schema.NullOr(
    Schema.Literals([
      "push-accepted",
      "push-out-of-date",
      "remote-head-tree",
      "remote-history",
      "send-refused",
      "superseded",
    ]),
  ),
  recordedAt: IsoTime,
});
export type OverleafPublicationAttempt = typeof PublicationAttempt.Type;

const RetainedCopy = Schema.Struct({
  applyId: OverleafServerId,
  relativePath: ManuscriptPath,
  /** Content revision when retained; a later different revision means a late writer. */
  revision: Schema.String.check(Schema.isMaxLength(128)),
  state: Schema.Literals(["releasable", "changed", "ambiguous", "interrupted", "kept"]),
  retainedAt: IsoTime,
  /** Release needs both seven days and a later completed sync. */
  laterSyncCompleted: Schema.Boolean,
});

export const OverleafConnectionDocument = Schema.Struct({
  schemaVersion: Schema.Literal(OVERLEAF_CONNECTION_SCHEMA_VERSION),
  connectionId: OverleafServerId,
  revision: Positive,
  environmentId: Schema.String.check(Schema.isMaxLength(200)),
  binding: Schema.Struct({
    bindingId: Schema.String.check(Schema.isMaxLength(200)),
    authorityGeneration: Count,
    scopeRevision: Count,
  }),
  checkout: Schema.Struct({
    canonicalRoot: Schema.String.check(Schema.isMaxLength(4_096)),
    identity: PhysicalIdentity,
  }),
  folder: Schema.Struct({ relativePath: FolderPath, identity: PhysicalIdentity }),
  remote: Schema.Struct({
    host: Schema.Literal("www.overleaf.com"),
    projectId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{24}$/u)),
    branch: Schema.Literals(["main", "master"]),
  }),
  mode: Schema.Literal("manual"),
  state: Schema.Literals(["active", "archived"]),
  /** Null tree until the first completed sync; generation advances on every base change. */
  base: Schema.Struct({
    commit: Schema.NullOr(Oid),
    tree: Schema.NullOr(Oid),
    generation: Count,
  }),
  priorBases: Schema.Array(Snapshot).check(Schema.isMaxLength(PRIOR_BASE_LIMIT)),
  localSnapshots: Schema.Array(Snapshot).check(Schema.isMaxLength(LOCAL_SNAPSHOT_LIMIT)),
  managedPaths: Schema.Array(ManuscriptPath).check(Schema.isMaxLength(MANAGED_PATH_LIMIT)),
  localOnlyPaths: Schema.Array(ManuscriptPath).check(Schema.isMaxLength(MANAGED_PATH_LIMIT)),
  attentionPaths: Schema.Array(ManuscriptPath).check(Schema.isMaxLength(MANAGED_PATH_LIMIT)),
  retention: Schema.Struct({
    vaultIdentity: PhysicalIdentity,
    copies: Schema.Array(RetainedCopy),
  }),
  activeApply: Schema.NullOr(ApplyLink),
  /** Monotonic; never reused, even after an attempt is resolved and pruned. */
  lastAttemptNumber: Count,
  attempts: Schema.Array(PublicationAttempt),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type OverleafConnectionDocument = typeof OverleafConnectionDocument.Type;

/** A duplicate request returns this record; it never starts another worker. */
export const OverleafOperationReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  connectionId: OverleafServerId,
  requestId: OverleafServerId,
  kind: Schema.Literals([
    "connect",
    "confirm",
    "recover",
    "relink",
    "disconnect",
    "restore",
    "token",
    "history-reset",
  ]),
  /** Digest of the canonical request payload; reuse with different input fails. */
  payloadDigest: Digest,
  operationId: OverleafServerId,
  status: Schema.Literals(["running", "completed", "failed", "unknown"]),
  /** A fixed category for the terminal status; never raw Git output. */
  resultCategory: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u))),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type OverleafOperationReceipt = typeof OverleafOperationReceipt.Type;

/** Why a proposed replacement would destroy evidence or rewind state. */
export const OverleafTransitionViolation = Schema.Literals([
  "identity-changed",
  "revision-not-next",
  "base-generation-decreased",
  "base-changed-without-generation",
  "attempt-number-decreased",
  "attempt-number-reused",
  "attempt-number-ahead",
  "attempt-not-recorded-unknown",
  "resolved-attempt-reopened",
  "unresolved-attempt-dropped",
  "unresolved-attempt-rewritten",
  "unresolved-attempt-limit",
  "apply-link-replaced",
  "retained-copy-dropped",
]);
export type OverleafTransitionViolation = typeof OverleafTransitionViolation.Type;

const isUnresolved = (outcome: OverleafAttemptOutcome) =>
  outcome === "unknown" || outcome === "superseded-unresolved";

/**
 * Checks one replacement against the evidence rules of the coordinator
 * contract. A violation is a coordinator bug; the store refuses to persist it.
 */
export function overleafTransitionViolation(
  previous: OverleafConnectionDocument,
  next: OverleafConnectionDocument,
  nowMillis: number,
): OverleafTransitionViolation | null {
  if (
    next.connectionId !== previous.connectionId ||
    next.environmentId !== previous.environmentId ||
    next.remote.host !== previous.remote.host ||
    next.remote.projectId !== previous.remote.projectId ||
    next.createdAt !== previous.createdAt
  )
    return "identity-changed";
  if (next.revision !== previous.revision + 1) return "revision-not-next";
  if (next.base.generation < previous.base.generation) return "base-generation-decreased";
  if (
    next.base.generation === previous.base.generation &&
    (next.base.commit !== previous.base.commit || next.base.tree !== previous.base.tree)
  )
    return "base-changed-without-generation";

  if (next.lastAttemptNumber < previous.lastAttemptNumber) return "attempt-number-decreased";
  const nextAttempts = new Map(next.attempts.map((attempt) => [attempt.attemptNumber, attempt]));
  if (nextAttempts.size !== next.attempts.length) return "attempt-number-reused";
  const previousNumbers = new Set(previous.attempts.map((attempt) => attempt.attemptNumber));
  for (const attempt of next.attempts) {
    if (attempt.attemptNumber > next.lastAttemptNumber) return "attempt-number-ahead";
    if (previousNumbers.has(attempt.attemptNumber)) continue;
    // A new attempt takes a fresh number and is recorded unknown before any send.
    if (attempt.attemptNumber <= previous.lastAttemptNumber) return "attempt-number-reused";
    if (attempt.outcome !== "unknown") return "attempt-not-recorded-unknown";
  }
  for (const attempt of previous.attempts) {
    const kept = nextAttempts.get(attempt.attemptNumber);
    if (!isUnresolved(attempt.outcome)) {
      // Resolved history may be pruned, never reopened or reclassified.
      if (kept !== undefined && kept.outcome !== attempt.outcome)
        return "resolved-attempt-reopened";
      continue;
    }
    if (kept === undefined) return "unresolved-attempt-dropped";
    if (
      kept.candidateCommit !== attempt.candidateCommit ||
      kept.candidateTree !== attempt.candidateTree ||
      kept.parentCommit !== attempt.parentCommit ||
      kept.planDigest !== attempt.planDigest ||
      kept.baseGeneration !== attempt.baseGeneration ||
      // Superseded evidence stays superseded unless positive evidence resolves it.
      (attempt.outcome === "superseded-unresolved" && kept.outcome === "unknown")
    )
      return "unresolved-attempt-rewritten";
  }
  if (
    next.attempts.filter((attempt) => isUnresolved(attempt.outcome)).length >
    UNRESOLVED_ATTEMPT_LIMIT
  )
    return "unresolved-attempt-limit";

  const link = previous.activeApply;
  if (link !== null && next.activeApply !== null && next.activeApply.applyId !== link.applyId)
    return "apply-link-replaced";
  const nextCopies = new Set(
    next.retention.copies.map((copy) => `${copy.applyId}\0${copy.relativePath}`),
  );
  for (const copy of previous.retention.copies)
    if (
      !nextCopies.has(`${copy.applyId}\0${copy.relativePath}`) &&
      !retainedCopyReleasable(copy, nowMillis)
    )
      return "retained-copy-dropped";
  return null;
}

/** A retained copy may be released only after seven days and a later completed sync. */
export function retainedCopyReleasable(
  copy: OverleafConnectionDocument["retention"]["copies"][number],
  nowMillis: number,
): boolean {
  const retainedAt = Date.parse(copy.retainedAt);
  return (
    copy.state === "releasable" &&
    copy.laterSyncCompleted &&
    Number.isFinite(retainedAt) &&
    nowMillis - retainedAt >= 7 * 24 * 60 * 60 * 1_000
  );
}

/** Private refs that must exist for the document's recovery evidence to be usable. */
export function overleafRequiredPins(
  document: OverleafConnectionDocument,
): ReadonlyArray<{ readonly name: string; readonly oid: string }> {
  const pins: Array<{ name: string; oid: string }> = [];
  if (document.base.tree !== null)
    pins.push({ name: `base/${document.base.generation}/tree`, oid: document.base.tree });
  if (document.base.commit !== null)
    pins.push({ name: `base/${document.base.generation}/commit`, oid: document.base.commit });
  for (const snapshot of document.priorBases) {
    pins.push({ name: `base/${snapshot.generation}/tree`, oid: snapshot.tree });
    if (snapshot.commit !== null)
      pins.push({ name: `base/${snapshot.generation}/commit`, oid: snapshot.commit });
  }
  if (document.activeApply !== null)
    pins.push({
      name: `apply/${document.activeApply.applyId}/target`,
      oid: document.activeApply.intentTree,
    });
  for (const attempt of document.attempts) {
    if (!isUnresolved(attempt.outcome)) continue;
    pins.push(
      { name: `attempt/${attempt.attemptNumber}/candidate`, oid: attempt.candidateCommit },
      { name: `attempt/${attempt.attemptNumber}/parent`, oid: attempt.parentCommit },
    );
  }
  return pins;
}
