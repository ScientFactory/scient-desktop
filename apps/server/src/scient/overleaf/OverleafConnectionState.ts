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
const PRIOR_BASE_LIMIT = 20;
const LOCAL_SNAPSHOT_LIMIT = 10;
/** Unresolved publication attempts kept before new work is refused. */
const UNRESOLVED_ATTEMPT_LIMIT = 16;
/** All attempts kept, resolved history included; resolved ones may be pruned. */
const ATTEMPT_LIMIT = 64;
const RETAINED_COPY_LIMIT = 4_096;
const MANAGED_PATH_LIMIT = 2_000;
const RETENTION_PERIOD_MILLIS = 7 * 24 * 60 * 60 * 1_000;

const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u));
/** Server-generated identifiers. Never accepted from a client as a storage name. */
export const OverleafServerId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const IsoTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
);
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
/** The workspace authority an operation ran under. */
const Authority = Schema.Struct({
  bindingId: Schema.String.check(Schema.isMaxLength(200)),
  authorityGeneration: Count,
  scopeRevision: Count,
});

const PriorBase = Schema.Struct({ commit: Schema.NullOr(Oid), tree: Oid, generation: Count });
/** A captured local folder state kept as a recovery point. */
const LocalSnapshot = Schema.Struct({
  sequence: Positive,
  commit: Schema.NullOr(Oid),
  tree: Oid,
});

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

const AttemptEvidence = Schema.Literals([
  "push-accepted",
  "push-out-of-date",
  "remote-head-tree",
  "remote-history",
  "send-refused",
  "superseded",
]);
/** Each outcome is established only by these kinds of evidence. */
const EVIDENCE_FOR_OUTCOME: Record<
  OverleafAttemptOutcome,
  ReadonlyArray<typeof AttemptEvidence.Type | null>
> = {
  unknown: [null],
  accepted: ["push-accepted", "remote-head-tree", "remote-history"],
  "out-of-date": ["push-out-of-date"],
  "not-sent": ["send-refused"],
  "superseded-unresolved": ["superseded"],
};

const PublicationAttempt = Schema.Struct({
  attemptNumber: Positive,
  operationId: OverleafServerId,
  requestId: OverleafServerId,
  planDigest: Digest,
  authority: Authority,
  branch: Schema.Literals(["main", "master"]),
  parentCommit: Oid,
  candidateCommit: Oid,
  candidateTree: Oid,
  /** The post-apply base generation this attempt was built on. */
  baseGeneration: Count,
  outcome: OverleafAttemptOutcome,
  /** How a definite outcome was established; null exactly while unknown. */
  evidence: Schema.NullOr(AttemptEvidence),
  recordedAt: IsoTime,
}).check(
  Schema.makeFilter((attempt) => EVIDENCE_FOR_OUTCOME[attempt.outcome].includes(attempt.evidence)),
);
export type OverleafPublicationAttempt = typeof PublicationAttempt.Type;

const RetainedCopy = Schema.Struct({
  applyId: OverleafServerId,
  relativePath: ManuscriptPath,
  /** Content revision when retained; a later different revision means a late writer. */
  revision: Schema.String.check(Schema.isMaxLength(128)),
  state: Schema.Literals(["releasable", "changed", "ambiguous", "interrupted", "kept"]),
  retainedAt: IsoTime,
  /** The connection's completed-sync count when retained; release needs a later one. */
  retainedAtSyncCount: Count,
});
type RetainedCopy = typeof RetainedCopy.Type;

const isUnresolved = (outcome: OverleafAttemptOutcome) =>
  outcome === "unknown" || outcome === "superseded-unresolved";

const retainedKey = (copy: RetainedCopy) => `${copy.applyId}\0${copy.relativePath}`;

/** Structural equality of decoded JSON values, independent of key order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) =>
      sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

export const OverleafConnectionDocument = Schema.Struct({
  schemaVersion: Schema.Literal(OVERLEAF_CONNECTION_SCHEMA_VERSION),
  connectionId: OverleafServerId,
  revision: Positive,
  environmentId: Schema.String.check(Schema.isMaxLength(200)),
  binding: Authority,
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
  /** Monotonic count of completed syncs; retained copies are released only after a later one. */
  completedSyncCount: Count,
  priorBases: Schema.Array(PriorBase).check(Schema.isMaxLength(PRIOR_BASE_LIMIT)),
  localSnapshots: Schema.Array(LocalSnapshot).check(Schema.isMaxLength(LOCAL_SNAPSHOT_LIMIT)),
  managedPaths: Schema.Array(ManuscriptPath).check(Schema.isMaxLength(MANAGED_PATH_LIMIT)),
  localOnlyPaths: Schema.Array(ManuscriptPath).check(Schema.isMaxLength(MANAGED_PATH_LIMIT)),
  attentionPaths: Schema.Array(ManuscriptPath).check(Schema.isMaxLength(MANAGED_PATH_LIMIT)),
  retention: Schema.Struct({
    vaultIdentity: PhysicalIdentity,
    copies: Schema.Array(RetainedCopy).check(Schema.isMaxLength(RETAINED_COPY_LIMIT)),
  }),
  activeApply: Schema.NullOr(ApplyLink),
  /** Monotonic; never reused, even after an attempt is resolved and pruned. */
  lastAttemptNumber: Count,
  attempts: Schema.Array(PublicationAttempt).check(Schema.isMaxLength(ATTEMPT_LIMIT)),
  createdAt: IsoTime,
  updatedAt: IsoTime,
}).check(
  // Relations within one document; a document violating them is never written or trusted.
  Schema.makeFilter((document) => {
    const numbers = new Set(document.attempts.map((attempt) => attempt.attemptNumber));
    const sequences = new Set(document.localSnapshots.map((snapshot) => snapshot.sequence));
    const copies = new Set(document.retention.copies.map(retainedKey));
    return (
      numbers.size === document.attempts.length &&
      document.attempts.every((attempt) => attempt.attemptNumber <= document.lastAttemptNumber) &&
      document.attempts.filter((attempt) => isUnresolved(attempt.outcome)).length <=
        UNRESOLVED_ATTEMPT_LIMIT &&
      sequences.size === document.localSnapshots.length &&
      copies.size === document.retention.copies.length &&
      document.retention.copies.every(
        (copy) => copy.retainedAtSyncCount <= document.completedSyncCount,
      )
    );
  }),
);
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
  "sync-count-decreased",
  "attempt-number-decreased",
  "attempt-number-reused",
  "attempt-not-recorded-unknown",
  "attempt-base-generation-mismatch",
  "attempt-rewritten",
  "attempt-outcome-not-allowed",
  "unresolved-attempt-dropped",
  "unknown-attempt-not-superseded",
  "superseded-without-base-change",
  "accepted-base-mismatch",
  "late-evidence-moved-base",
  "rejection-moved-base",
  "apply-link-changed",
  "retained-copy-rewritten",
  "retained-copy-dropped",
]);
export type OverleafTransitionViolation = typeof OverleafTransitionViolation.Type;

/** Outcome changes a kept attempt may make; anything else rewrites history. */
const ALLOWED_OUTCOMES: Record<OverleafAttemptOutcome, ReadonlyArray<OverleafAttemptOutcome>> = {
  unknown: ["unknown", "accepted", "out-of-date", "not-sent", "superseded-unresolved"],
  // Late positive evidence may still arrive; nothing else can be established later.
  "superseded-unresolved": ["superseded-unresolved", "accepted"],
  accepted: ["accepted"],
  "out-of-date": ["out-of-date"],
  "not-sent": ["not-sent"],
};

/**
 * Checks one replacement against the evidence rules of the coordinator
 * contract (sections 6 and 8). Both documents must already be valid. A
 * violation is a coordinator bug; the store refuses to persist it.
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
  const baseChanged = next.base.generation !== previous.base.generation;
  if (
    !baseChanged &&
    (next.base.commit !== previous.base.commit || next.base.tree !== previous.base.tree)
  )
    return "base-changed-without-generation";
  if (next.completedSyncCount < previous.completedSyncCount) return "sync-count-decreased";

  if (next.lastAttemptNumber < previous.lastAttemptNumber) return "attempt-number-decreased";
  const nextAttempts = new Map(next.attempts.map((attempt) => [attempt.attemptNumber, attempt]));
  const previousNumbers = new Set(previous.attempts.map((attempt) => attempt.attemptNumber));
  for (const attempt of next.attempts) {
    if (previousNumbers.has(attempt.attemptNumber)) continue;
    // A new attempt takes a fresh number and is recorded unknown, on the current base, before any send.
    if (attempt.attemptNumber <= previous.lastAttemptNumber) return "attempt-number-reused";
    if (attempt.outcome !== "unknown") return "attempt-not-recorded-unknown";
    if (attempt.baseGeneration !== next.base.generation) return "attempt-base-generation-mismatch";
  }
  for (const attempt of previous.attempts) {
    const kept = nextAttempts.get(attempt.attemptNumber);
    if (kept === undefined) {
      // Resolved history may be pruned; unresolved evidence never is.
      if (isUnresolved(attempt.outcome)) return "unresolved-attempt-dropped";
      continue;
    }
    // Only the classification may change; who sent what, from where, is fixed.
    const { outcome: _a, evidence: _b, ...identity } = attempt;
    const { outcome: _c, evidence: _d, ...keptIdentity } = kept;
    if (!sameJson(identity, keptIdentity)) return "attempt-rewritten";
    if (!ALLOWED_OUTCOMES[attempt.outcome].includes(kept.outcome))
      return "attempt-outcome-not-allowed";
    if (kept.outcome === attempt.outcome) {
      if (kept.evidence !== attempt.evidence) return "attempt-rewritten";
      continue;
    }
    if (kept.outcome === "superseded-unresolved" && !baseChanged)
      return "superseded-without-base-change";
    if ((kept.outcome === "out-of-date" || kept.outcome === "not-sent") && baseChanged)
      return "rejection-moved-base";
    if (kept.outcome === "accepted") {
      // Evidence about an attempt overtaken by a later base is informational only.
      if (attempt.outcome === "superseded-unresolved") {
        if (baseChanged) return "late-evidence-moved-base";
        continue;
      }
      // Acceptance adopts exactly the candidate, on the base it was built for.
      if (
        next.base.commit !== attempt.candidateCommit ||
        next.base.tree !== attempt.candidateTree ||
        (baseChanged && attempt.baseGeneration !== previous.base.generation)
      )
        return "accepted-base-mismatch";
    }
  }
  // A new base overtakes every attempt still unknown; it must be superseded or resolved with it.
  if (baseChanged)
    for (const attempt of previous.attempts)
      if (
        attempt.outcome === "unknown" &&
        nextAttempts.get(attempt.attemptNumber)?.outcome === "unknown"
      )
        return "unknown-attempt-not-superseded";

  if (
    previous.activeApply !== null &&
    next.activeApply !== null &&
    !sameJson(previous.activeApply, next.activeApply)
  )
    return "apply-link-changed";

  const nextCopies = new Map(next.retention.copies.map((copy) => [retainedKey(copy), copy]));
  for (const copy of previous.retention.copies) {
    const kept = nextCopies.get(retainedKey(copy));
    if (kept === undefined) {
      if (!overleafRetainedCopyReleasable(copy, previous.completedSyncCount, nowMillis))
        return "retained-copy-dropped";
      continue;
    }
    if (
      kept.revision !== copy.revision ||
      kept.retainedAt !== copy.retainedAt ||
      kept.retainedAtSyncCount !== copy.retainedAtSyncCount ||
      // A changed, ambiguous, interrupted or kept copy never becomes releasable again.
      (kept.state === "releasable" && copy.state !== "releasable")
    )
      return "retained-copy-rewritten";
  }
  return null;
}

/** A retained copy may be released only after seven days and a later completed sync. */
export function overleafRetainedCopyReleasable(
  copy: RetainedCopy,
  completedSyncCount: number,
  nowMillis: number,
): boolean {
  return (
    copy.state === "releasable" &&
    completedSyncCount > copy.retainedAtSyncCount &&
    nowMillis - Date.parse(copy.retainedAt) >= RETENTION_PERIOD_MILLIS
  );
}

/** Private refs that must exist for the document's recovery evidence to be usable. */
export function overleafRequiredPins(
  document: OverleafConnectionDocument,
): ReadonlyArray<{ readonly name: string; readonly oid: string }> {
  const pins: Array<{ name: string; oid: string }> = [];
  for (const base of [document.base, ...document.priorBases]) {
    if (base.tree !== null) pins.push({ name: `base/${base.generation}/tree`, oid: base.tree });
    if (base.commit !== null)
      pins.push({ name: `base/${base.generation}/commit`, oid: base.commit });
  }
  for (const snapshot of document.localSnapshots) {
    pins.push({ name: `local/${snapshot.sequence}/tree`, oid: snapshot.tree });
    if (snapshot.commit !== null)
      pins.push({ name: `local/${snapshot.sequence}/commit`, oid: snapshot.commit });
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
