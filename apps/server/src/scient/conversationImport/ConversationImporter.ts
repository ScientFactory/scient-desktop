// @effect-diagnostics nodeBuiltinImport:off -- the content digest is checked inside a synchronous schema filter.
/**
 * The seam between staging a portable conversation file and importing it.
 *
 * Two owners meet here:
 *
 * - **Staging** receives the upload, validates the package, stages its
 *   attachments, serves previews, runs confirm and cancel, and is the only code
 *   that creates or removes a staging area.
 * - **The importer** (`ConversationImporter`) turns one validated, leased import
 *   into a new independent thread with a single `thread.conversation.import`
 *   command, and settles attempts that will not continue. It never starts a
 *   provider session.
 *
 * ## Authorization
 *
 * Every import endpoint (create-upload, preview, import, cancel) first calls
 * `requireEnvironmentScope(SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE)`, as the
 * other mutating Scient endpoints do; the signed upload URL is issued only
 * after that check and accepts exactly the admitted bytes, once. The confirm
 * passes the authenticated principal to `importConversation`, which checks it
 * again and checks authority over the destination as a thread-creating
 * dispatch would: the project exists, is not deleted, and is not being cloned.
 * A retried confirm is checked with its own principal.
 *
 * ## Staging areas
 *
 * One directory per import, `<stateDir>/scient/conversation-imports/<importId>/`,
 * created only by `createUpload` (under a fresh ID) and removed only by
 * staging. Its layout is private to staging except `attemptDirectory`, which
 * belongs to the importer (its attempt journal) and which staging only ever
 * removes as part of the whole area. Each area counts against
 * `CONVERSATION_IMPORT_STAGING_QUOTA_BYTES` and `CONVERSATION_IMPORT_MAX_LIVE`
 * from admission until it is gone: its declared upload size until it is
 * validated, then its staged snapshot and attachments. Validation and imports
 * run one at a time, so the only bytes beyond the quota are the expansion of
 * the one package being validated, at most `SCIC_MAX_UNCOMPRESSED_BYTES`. A
 * receive ends after a minute without bytes or at a deadline scaled to its
 * size. An idle area expires `CONVERSATION_IMPORT_STAGING_TTL_MS` after its
 * last upload, preview, or confirm; an area whose upload never arrives expires
 * with its upload URL.
 *
 * Staging removes an area when the user cancels, after a successful import,
 * when it expires, when its file is refused, and at server startup (every
 * area left from an earlier run is abandoned). A validation that fails for a
 * reason a retry may clear (no room yet, a read error) keeps the upload for
 * the next preview instead. Before removing an area whose `attemptDirectory`
 * is not empty, staging calls `settleAttempt`; if settling fails, the area
 * stays and is settled again on the next sweep. An area that cannot be
 * removed yet stays, still counted, until a sweep removes it. An empty
 * `attemptDirectory` means nothing was published.
 *
 * ## The per-import lease
 *
 * Every operation on one import runs under its exclusive, in-process lease:
 * receiving the upload, validation (the first preview), the import (confirm),
 * and removal (cancel, expiry, startup). Validation and the import run in
 * fibers owned by staging, not by the HTTP request, so a client disconnect
 * interrupts neither. While one runs:
 *
 * - a second preview joins the running validation; a confirm waits for it and
 *   then imports; a second confirm joins the running import if its package
 *   digest and destination match, and fails `import-busy` otherwise;
 * - expiry skips the area (both operations refresh its expiry);
 * - cancel marks the import cancel-requested, stops a receive in progress or
 *   interrupts the running fiber, and joins it before deciding anything, so
 *   an upload's reservation is held until its stream has stopped.
 *
 * A preview is returned only if the import is still live when validation
 * ends; a cancelled validation fails its joined previews `cancelled`. A
 * cancelled or unknown ID never gets an area again: uploads and validation
 * write only into an existing, live area.
 *
 * An import's outcome is decided by its commit receipt, never by the cancel.
 * Once the fiber has ended, staging settles the attempt (the fiber's own
 * success already proves an accepted receipt). If the command committed —
 * including when the interrupt arrived after the uninterruptible dispatch —
 * the import is finished: staging persists its completion, joined confirms
 * get the result (or `already-imported` when their destination differs), and
 * cancel answers `already-imported`. Only an attempt proven uncommitted
 * (receipt rejected or absent) ends `cancelled`: its files are rolled back,
 * the area is removed, and joined confirms fail `cancelled`.
 *
 * ## Attempts and commit receipts
 *
 * One import has at most one committed thread. An attempt is one command ID,
 * destination thread ID, and confirm binding (package digest and
 * destination), recorded in the importer's journal. The journal is written and
 * flushed before any file is published or any command is dispatched, so every
 * attempt that can have committed has a durable binding. The binding is fixed
 * for the attempt: a confirm whose destination differs from a kept,
 * uncommitted attempt's fails `destination-changed` and never resumes or
 * re-targets the journaled command (cancel ends the attempt instead).
 *
 * The command's receipt decides everything, never whether a thread exists now:
 *
 * - **accepted** — the thread committed. Published files belong to it and are
 *   never deleted. `importConversation` and `settleAttempt` return the
 *   attempt's `ConversationImportCompletion`, rebuilt from the journal's
 *   binding, so the original destination is reported whatever destination the
 *   current confirm asked for.
 * - **rejected** — the engine refused that command, permanently: resending
 *   the same command ID fails `OrchestrationCommandPreviouslyRejectedError`.
 *   The importer deletes exactly the journal-listed files, clears
 *   `attemptDirectory`, and reports `import-rejected` (or `rejected` when
 *   settling). The attempt is over; confirming again starts a new attempt with
 *   a new command ID, thread ID, and binding, typically with another
 *   destination.
 * - **absent** — nothing committed. After a failure the attempt is kept:
 *   `importConversation` fails `import-failed`, and the next confirm with the
 *   same binding resumes it from the journal with the same IDs, so a dispatch
 *   that did commit is found rather than repeated. When the attempt will not
 *   continue (cancel, expiry, startup), `settleAttempt` deletes exactly the
 *   journal-listed files and reports `rolled-back`. Settling runs only when no
 *   import fiber is running, so no dispatch for the attempt can still be in
 *   flight.
 *
 * ## Completions
 *
 * A committed import's `ConversationImportCompletion` (package digest and
 * result, which carries the destination) outlives its staging area. Write
 * order, for a commit reported by `importConversation` or by `settleAttempt`
 * (including at startup): (1) staging writes the completion record durably
 * (temporary file, flush, rename) under
 * `<stateDir>/scient/conversation-imports/completions/`; (2) only then removes the
 * area, journal included. If step 1 fails, the area and journal stay and the
 * next sweep settles again, so a crash anywhere between commit and cleanup
 * still ends with the completion recorded. Records are kept for
 * `CONVERSATION_IMPORT_COMPLETION_RETENTION_MS` across restarts. While it is
 * retained it answers first, whatever the staging area is doing (still being
 * removed, or gone): a repeated confirm with the same digest and destination
 * returns the result, another digest fails `package-changed`, another
 * destination `already-imported`; a cancel answers `already-imported`, and a
 * preview fails `already-imported`. Only an import with no retained
 * completion and no live area is `import-not-found`.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  ConversationImportDestination,
  ConversationImportId,
  ConversationImportOmission,
  ConversationImportPackageSummary,
  ConversationImportResourceId,
  ConversationImportWarning,
  ConversationSnapshotV1,
  IsoDateTime,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  PositiveInt,
  SCIC_FORMAT,
  SCIC_FORMAT_MAJOR_VERSION,
  SCIC_FORMAT_MINOR_VERSION,
  ScientConversationImportResult,
  Sha256Digest,
  TrimmedNonEmptyString,
  type ConversationAttachment,
  type ConversationProvenance,
  type EnvironmentSessionPrincipalShape,
  type RuntimeMode,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

// ---------------------------------------------------------------------------
// Staging policy
// ---------------------------------------------------------------------------

/** Under `<stateDir>/scient/`, beside the export files. */
export const CONVERSATION_IMPORT_STAGING_DIRECTORY = "conversation-imports";
export const CONVERSATION_IMPORT_STAGING_TTL_MS = 60 * 60_000;
/** Bytes all staging areas may hold together: uploaded packages plus staged attachments. */
export const CONVERSATION_IMPORT_STAGING_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
/** Staging areas that may exist at once, whatever their size. */
export const CONVERSATION_IMPORT_MAX_LIVE = 8;
/** How long a committed import's confirm binding and result are kept. */
export const CONVERSATION_IMPORT_COMPLETION_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Records one import may write: messages, reasoning, work-log entries, plans,
 * and answers. One `thread.conversation.import` command writes them all in one
 * transaction, which holds the orchestration engine. Measured with the opt-in
 * `ConversationImportBenchmark` on an on-disk database, a work-log-heavy import
 * (eight tool entries of 8,000 output characters per turn) commits 5,000
 * records in about 3.5 s; the cost then grows faster than linearly (about 14 s
 * at 10,000 and 65 s at 20,000).
 */
export const CONVERSATION_IMPORT_MAX_RECORDS = 5_000;

/** The records an import of this snapshot writes, as `CONVERSATION_IMPORT_MAX_RECORDS` counts them. */
export function conversationImportRecordCount(snapshot: ConversationSnapshotV1): number {
  return (
    snapshot.messages.length +
    snapshot.reasoning.length +
    snapshot.workLog.length +
    snapshot.proposedPlans.length +
    snapshot.questionAnswers.length
  );
}

// ---------------------------------------------------------------------------
// Validated import input
// ---------------------------------------------------------------------------

/**
 * Recomputes a snapshot's content digest the way the exporter computed it:
 * SHA-256 of `canonicalSnapshotContent`, which leaves out `captured` and the
 * digest itself.
 *
 * It is computed over the decoded snapshot, so it certifies exactly what an
 * import writes. A package from a newer minor version whose snapshot carries
 * fields this build does not know is therefore rejected by the reader rather
 * than verified over content the import would silently drop: the reader
 * requires the canonical form of `conversation.json` as received to equal the
 * canonical form of its decoded snapshot, and reports a difference as
 * `unsupported-version` for a newer minor version and `snapshot-invalid`
 * otherwise. Newer minor versions that add only manifest data still import,
 * with a warning.
 */
export function conversationContentDigest(snapshot: ConversationSnapshotV1): Sha256Digest {
  const { contentDigest: _contentDigest, captured: _captured, ...content } = snapshot;
  // Hashed as it is written, so a large snapshot is never copied into one string.
  const hash = NodeCrypto.createHash("sha256");
  let pending = "";
  writeCanonicalJson(content, (text) => {
    pending += text;
    if (pending.length >= CANONICAL_HASH_CHUNK_CHARS) {
      hash.update(pending);
      pending = "";
    }
  });
  hash.update(pending);
  return `sha256:${hash.digest("hex")}`;
}

const CANONICAL_HASH_CHUNK_CHARS = 64 * 1024;

/** A value as `canonicalSnapshotContent` sees it before `JSON.stringify`: bytes become numbers. */
const canonicalInput = (value: unknown) =>
  value instanceof Uint8Array && !Array.isArray(value) ? Array.from(value) : value;

/** `JSON.stringify` leaves these out of objects and writes them as `null` in arrays. */
const isOmittedJson = (value: unknown) => value === undefined || typeof value === "symbol";

/**
 * Writes `canonicalSnapshotContent`'s text for `value` (sorted keys at every
 * level, then `JSON.stringify`) in pieces. Every piece is a whole JSON token,
 * so no surrogate pair is split between pieces.
 */
function writeCanonicalJson(value: unknown, write: (text: string) => void): void {
  const input = canonicalInput(value);
  if (Array.isArray(input)) {
    write("[");
    for (const [index, item] of input.entries()) {
      if (index > 0) write(",");
      if (isOmittedJson(item)) write("null");
      else writeCanonicalJson(item, write);
    }
    write("]");
    return;
  }
  if (Predicate.isObject(input)) {
    const record = input as Record<string, unknown>;
    write("{");
    let first = true;
    for (const key of Object.keys(record).toSorted()) {
      const item = record[key];
      if (isOmittedJson(item)) continue;
      write(`${first ? "" : ","}${JSON.stringify(key)}:`);
      first = false;
      writeCanonicalJson(item, write);
    }
    write("}");
    return;
  }
  write(JSON.stringify(input));
}

/**
 * Whether two values have the same `canonicalSnapshotContent` text, compared
 * structurally, so a decoded snapshot can be checked against the JSON it was
 * decoded from without writing either out.
 */
export function sameCanonicalJson(left: unknown, right: unknown): boolean {
  const a = canonicalInput(left);
  const b = canonicalInput(right);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) =>
      sameCanonicalJson(
        isOmittedJson(item) ? null : item,
        isOmittedJson(b[index]) ? null : b[index],
      ),
    );
  }
  if (Predicate.isObject(a) || Predicate.isObject(b)) {
    if (!Predicate.isObject(a) || !Predicate.isObject(b)) return false;
    const leftRecord = a as Record<string, unknown>;
    const rightRecord = b as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => !isOmittedJson(leftRecord[key]));
    const rightKeys = Object.keys(rightRecord).filter((key) => !isOmittedJson(rightRecord[key]));
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(rightRecord, key) &&
          !isOmittedJson(rightRecord[key]) &&
          sameCanonicalJson(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const stagedAttachmentFields = {
  /** Equals the `localId` of every snapshot attachment it backs. */
  resourceId: ConversationImportResourceId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  sha256: Sha256Digest,
  /** Clipboard text a client folded into a file attachment. */
  pastedText: Schema.Boolean,
} as const;

/**
 * An included attachment whose bytes are staged and verified against the
 * manifest's size and SHA-256 and against the chat attachment media policy,
 * so the importer can publish it as a `ChatAttachment` without re-checking.
 */
export const StagedConversationImportAttachment = Schema.Union([
  Schema.Struct({
    ...stagedAttachmentFields,
    kind: Schema.Literal("image"),
    mediaType: Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES),
    byteLength: PositiveInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  }),
  Schema.Struct({
    ...stagedAttachmentFields,
    kind: Schema.Literal("file"),
    mediaType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
    byteLength: PositiveInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  }),
]);
export type StagedConversationImportAttachment = typeof StagedConversationImportAttachment.Type;

/**
 * The omissions a snapshot implies, in the order the preview lists them:
 * excluded work log, excluded reasoning, a truncated range, then the snapshot's
 * own warnings, which validation holds to the snapshot's facts (see
 * `checkSnapshotWarnings`). Staging reports exactly these.
 */
export function conversationImportOmissions(
  snapshot: ConversationSnapshotV1,
): ReadonlyArray<ConversationImportOmission> {
  const omissions: Array<ConversationImportOmission> = [];
  if (!snapshot.selection.workLog) omissions.push({ _tag: "work-log-excluded" });
  if (!snapshot.selection.reasoning) omissions.push({ _tag: "reasoning-excluded" });
  const lastMessage = snapshot.messages.at(-1);
  if (snapshot.selection.throughMessageId !== null && lastMessage) {
    omissions.push({ _tag: "range-truncated", throughMessageN: lastMessage.n });
  }
  for (const warning of snapshot.warnings) omissions.push({ _tag: "snapshot-warning", warning });
  return omissions;
}

function snapshotAttachments(
  snapshot: ConversationSnapshotV1,
): ReadonlyArray<ConversationAttachment> {
  return [
    ...snapshot.messages.flatMap((message) => message.attachments),
    ...snapshot.questionAnswers.flatMap((answer) =>
      answer.items.flatMap((item) => item.attachments),
    ),
  ];
}

function firstDuplicate(values: Iterable<string>): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/**
 * The snapshot's own structure is unambiguous enough to map every external
 * record to exactly one new local record: message numbers run 1..N in order,
 * message and reasoning IDs are unique together, other record IDs are unique
 * per kind, each named turn's messages form one run (messages without a turn
 * may sit inside it, as steering prompts do), the omitted running turn
 * appears nowhere, unselected content is absent, a range ends at its last
 * message, and inline references are unique per message and point at that
 * message's own attachments.
 */
function checkSnapshotStructure(snapshot: ConversationSnapshotV1): true | string {
  for (const [index, message] of snapshot.messages.entries()) {
    if (message.n !== index + 1) return `Message ${message.id} is numbered ${message.n}.`;
  }
  const messageIds = [
    ...snapshot.messages.map((message) => message.id),
    ...snapshot.reasoning.map((reasoning) => reasoning.id),
  ];
  const duplicateMessage = firstDuplicate(messageIds);
  if (duplicateMessage !== null) return `Message ${duplicateMessage} appears twice.`;
  for (const [kind, ids] of [
    ["work-log entry", snapshot.workLog.map((entry) => entry.id)],
    ["plan", snapshot.proposedPlans.map((plan) => plan.id)],
    ["question", snapshot.questionAnswers.map((answer) => answer.id)],
  ] as const) {
    const duplicate = firstDuplicate(ids);
    if (duplicate !== null) return `The ${kind} ${duplicate} appears twice.`;
  }

  // Messages without a turn (turn-start and steering prompts) sit inside a
  // turn's run without ending it; only another named turn does.
  const closedTurns = new Set<string>();
  let currentTurn: string | null = null;
  for (const message of snapshot.messages) {
    if (message.turnId === null || message.turnId === currentTurn) continue;
    if (currentTurn !== null) closedTurns.add(currentTurn);
    if (closedTurns.has(message.turnId)) {
      return `Turn ${message.turnId} is split across the transcript.`;
    }
    currentTurn = message.turnId;
  }

  const runningTurn = snapshot.omittedRunningTurn?.turnId;
  if (runningTurn !== undefined) {
    const turnIds = [
      ...snapshot.messages,
      ...snapshot.reasoning,
      ...snapshot.workLog,
      ...snapshot.proposedPlans,
      ...snapshot.questionAnswers,
    ].map((record) => record.turnId);
    if (turnIds.includes(runningTurn)) return `Omitted turn ${runningTurn} has records.`;
  }

  if (!snapshot.selection.workLog && snapshot.workLog.length > 0) {
    return "The work log is present but was not selected.";
  }
  if (!snapshot.selection.reasoning && snapshot.reasoning.length > 0) {
    return "Reasoning is present but was not selected.";
  }
  const through = snapshot.selection.throughMessageId;
  if (through !== null && snapshot.messages.at(-1)?.id !== through) {
    return "The selected range does not end at the last message.";
  }

  for (const message of snapshot.messages) {
    const duplicateReference = firstDuplicate(message.references.map((reference) => reference.id));
    if (duplicateReference !== null) {
      return `Reference ${duplicateReference} appears twice in message ${message.n}.`;
    }
    const attachmentIds = new Set(message.attachments.map((attachment) => attachment.localId));
    for (const reference of message.references) {
      if (reference._tag === "attachment" && !attachmentIds.has(reference.attachmentLocalId)) {
        return `Reference ${reference.id} in message ${message.n} names no attachment of that message.`;
      }
    }
  }
  return true;
}

/**
 * Omissions the snapshot's own facts prove must be reported, so a sender cannot
 * hide them by dropping warnings: exactly one running-turn warning, for the
 * omitted turn, when there is one; and an unavailable or unsupported
 * attachment warning for each (name, message) with an unavailable attachment
 * (message `null` for attachments on a submitted answer), and no other.
 * Skipped-records warnings describe what the snapshot left out and pass
 * through.
 */
function checkSnapshotWarnings(snapshot: ConversationSnapshotV1): true | string {
  const runningWarnings = snapshot.warnings.filter(
    (warning) => warning._tag === "running-turn-omitted",
  );
  const runningTurn = snapshot.omittedRunningTurn?.turnId;
  if (
    runningTurn === undefined
      ? runningWarnings.length > 0
      : runningWarnings.length !== 1 || runningWarnings[0]!.turnId !== runningTurn
  ) {
    return "The running-turn warning does not match the omitted turn.";
  }

  const attachmentKey = (name: string, messageN: number | null) =>
    stableStringify([name, messageN]);
  const unavailable = new Set<string>();
  for (const message of snapshot.messages) {
    for (const attachment of message.attachments) {
      if (!attachment.available) unavailable.add(attachmentKey(attachment.name, message.n));
    }
  }
  for (const answer of snapshot.questionAnswers) {
    for (const item of answer.items) {
      for (const attachment of item.attachments) {
        if (!attachment.available) unavailable.add(attachmentKey(attachment.name, null));
      }
    }
  }
  const warned = new Set<string>();
  for (const warning of snapshot.warnings) {
    if (warning._tag === "attachment-unavailable" || warning._tag === "attachment-unsupported") {
      warned.add(attachmentKey(warning.name, warning.messageN));
    }
  }
  if (
    unavailable.size !== warned.size ||
    [...unavailable].some((attachment) => !warned.has(attachment))
  ) {
    return "The attachment warnings do not match the unavailable attachments.";
  }
  return true;
}

const isResourceId = Schema.is(ConversationImportResourceId);

function checkAttachments(input: {
  readonly snapshot: ConversationSnapshotV1;
  readonly attachments: ReadonlyArray<StagedConversationImportAttachment>;
}): true | string {
  const staged = new Map<string, StagedConversationImportAttachment>();
  for (const attachment of input.attachments) {
    if (staged.has(attachment.resourceId)) {
      return `Attachment ${attachment.resourceId} is staged twice.`;
    }
    staged.set(attachment.resourceId, attachment);
  }
  const used = new Set<string>();
  for (const attachment of snapshotAttachments(input.snapshot)) {
    if (!isResourceId(attachment.localId)) {
      return `Attachment ${attachment.localId} is not a package resource.`;
    }
    const backing = staged.get(attachment.localId);
    if (!attachment.available) {
      if (backing) return `Unavailable attachment ${attachment.localId} has staged bytes.`;
      continue;
    }
    if (!backing) return `Attachment ${attachment.localId} has no staged bytes.`;
    if (
      backing.kind !== attachment.kind ||
      backing.name !== attachment.name ||
      backing.mediaType !== attachment.mimeType ||
      backing.byteLength !== attachment.sizeBytes ||
      backing.pastedText !== attachment.pastedText
    ) {
      return `Attachment ${attachment.localId} disagrees with its staged bytes.`;
    }
    used.add(attachment.localId);
  }
  for (const resourceId of staged.keys()) {
    if (!used.has(resourceId)) return `Staged attachment ${resourceId} is not referenced.`;
  }
  return true;
}

/**
 * Everything validation guarantees about a `ValidatedConversationImport`
 * beyond the shape of its parts: the snapshot's content hashes to its content
 * digest, the package describes this snapshot (digest, source thread, a
 * supported major version), the snapshot's structure is
 * unambiguous, its warnings report every omission its facts prove, the
 * omissions and version warning are exactly what the snapshot and package
 * imply, and the staged attachments back exactly the available snapshot
 * attachments.
 */
function checkValidatedConversationImport(
  input: {
    readonly package: ConversationImportPackageSummary;
    readonly snapshot: ConversationSnapshotV1;
    readonly attachments: ReadonlyArray<StagedConversationImportAttachment>;
    readonly omissions: ReadonlyArray<ConversationImportOmission>;
    readonly warnings: ReadonlyArray<ConversationImportWarning>;
  },
  computedContentDigest?: Sha256Digest,
): true | string {
  const { formatVersion } = input.package;
  if (formatVersion.major !== SCIC_FORMAT_MAJOR_VERSION) {
    return `Format version ${formatVersion.major} is not supported.`;
  }
  if (input.package.contentDigest !== input.snapshot.contentDigest) {
    return "The package digest is not the snapshot's content digest.";
  }
  if (
    (computedContentDigest ?? conversationContentDigest(input.snapshot)) !==
    input.snapshot.contentDigest
  ) {
    return "The snapshot's content does not match its content digest.";
  }
  if (
    input.package.format === SCIC_FORMAT &&
    input.package.sourceThreadId !== input.snapshot.captured.threadId
  ) {
    return "The package's source thread is not the snapshot's thread.";
  }
  const structure = checkSnapshotStructure(input.snapshot);
  if (structure !== true) return structure;
  const snapshotWarnings = checkSnapshotWarnings(input.snapshot);
  if (snapshotWarnings !== true) return snapshotWarnings;
  if (
    stableStringify(input.omissions) !==
    stableStringify(conversationImportOmissions(input.snapshot))
  ) {
    return "The omissions do not match the snapshot.";
  }
  const versionWarnings = input.warnings.filter(
    (warning) => warning._tag === "newer-minor-version",
  );
  const expectsVersionWarning = formatVersion.minor > SCIC_FORMAT_MINOR_VERSION;
  if (
    versionWarnings.length !== (expectsVersionWarning ? 1 : 0) ||
    versionWarnings.some(
      (warning) => stableStringify(warning.formatVersion) !== stableStringify(formatVersion),
    )
  ) {
    return "The version warning does not match the package version.";
  }
  return checkAttachments(input);
}

/**
 * What staging hands the importer: a package that passed every validation
 * check, described by its manifest summary, with its attachments staged.
 *
 * Every identifier inside `snapshot` — `captured.threadId`, message, turn, plan,
 * question, activity, and reference IDs, and any origin in
 * `snapshot.provenance` — was minted by another installation. The importer
 * mints new local IDs for everything it writes, maps each external ID to
 * exactly one of them, and records external identity only as the imported
 * thread's provenance (`conversationImportProvenance`). `snapshot.provenance`
 * is the sender's history, never the imported thread's provenance.
 */
export const ValidatedConversationImport = Schema.Struct({
  importId: ConversationImportId,
  package: ConversationImportPackageSummary,
  snapshot: ConversationSnapshotV1,
  attachments: Schema.Array(StagedConversationImportAttachment),
  omissions: Schema.Array(ConversationImportOmission),
  warnings: Schema.Array(ConversationImportWarning),
  /**
   * Parts of the file itself that could not be read and are left out: each
   * damaged Markdown range the user chose to skip counts as one. The import
   * reports them with its other skipped records, so the gap stays visible.
   */
  skippedSourceRecords: Schema.optionalKey(PositiveInt),
}).check(
  Schema.makeFilter((input) => checkValidatedConversationImport(input), {
    identifier: "ValidatedConversationImport",
  }),
);
export type ValidatedConversationImport = typeof ValidatedConversationImport.Type;

/** Everything in a `ValidatedConversationImport` but the snapshot: small, whatever the conversation. */
export const ValidatedConversationImportParts = ValidatedConversationImport.mapFields(
  ({ snapshot: _snapshot, ...parts }) => parts,
);
export type ValidatedConversationImportParts = typeof ValidatedConversationImportParts.Type;

/**
 * Joins a decoded snapshot and the rest of its import with every guarantee of
 * `ValidatedConversationImport`, without encoding and decoding the snapshot
 * again. `computedContentDigest` is `conversationContentDigest` of this
 * snapshot, computed by the caller (the reader computes it once), or the
 * digest of a snapshot the caller staged byte for byte after validating it.
 */
export function joinValidatedConversationImport(
  parts: ValidatedConversationImportParts,
  snapshot: ConversationSnapshotV1,
  computedContentDigest: Sha256Digest,
):
  | { readonly _tag: "valid"; readonly validated: ValidatedConversationImport }
  | { readonly _tag: "invalid"; readonly detail: string } {
  const validated = { ...parts, snapshot };
  const checked = checkValidatedConversationImport(validated, computedContentDigest);
  return checked === true ? { _tag: "valid", validated } : { _tag: "invalid", detail: checked };
}

export type ConversationImportProvenance = Extract<ConversationProvenance, { _tag: "import" }>;

/** The imported thread's provenance: the package's external identity, and when it was imported. */
export function conversationImportProvenance(
  summary: ConversationImportPackageSummary,
  importedAt: string,
): ConversationImportProvenance {
  return {
    _tag: "import",
    source: summary.format === SCIC_FORMAT ? "scic" : "markdown",
    exportId: summary.exportId,
    sourceThreadId: summary.sourceThreadId,
    packageDigest: summary.packageSha256,
    sourceFormat: summary.format,
    sourceFormatVersion: summary.formatVersion.major,
    importedAt,
  };
}

// ---------------------------------------------------------------------------
// Committed imports
// ---------------------------------------------------------------------------

/**
 * The confirm an attempt is bound to. The importer's journal records it, and
 * flushes it, before publishing any file or dispatching the command.
 */
export const ConversationImportAttemptBinding = Schema.Struct({
  packageSha256: Sha256Digest,
  destination: ConversationImportDestination,
});
export type ConversationImportAttemptBinding = typeof ConversationImportAttemptBinding.Type;

/**
 * A committed import's binding and result, kept after its staging area is
 * removed. `result.destination` is the committed attempt's destination.
 */
export const ConversationImportCompletion = Schema.Struct({
  packageSha256: Sha256Digest,
  result: ScientConversationImportResult,
  completedAt: IsoDateTime,
});
export type ConversationImportCompletion = typeof ConversationImportCompletion.Type;

const encodeDestination = Schema.encodeSync(ConversationImportDestination);

/**
 * Every imported thread starts supervised, asking before commands and file
 * changes: its history came from elsewhere and is unverified.
 */
export const CONVERSATION_IMPORT_RUNTIME_MODE = "approval-required" satisfies RuntimeMode;

/**
 * The destination an import is made to: the one requested, starting
 * supervised. Another requested runtime mode is ignored, not refused; the
 * committed destination reports the mode the thread really has.
 */
export function conversationImportDestination(
  destination: ConversationImportDestination,
): ConversationImportDestination {
  return destination.runtimeMode === CONVERSATION_IMPORT_RUNTIME_MODE
    ? destination
    : { ...destination, runtimeMode: CONVERSATION_IMPORT_RUNTIME_MODE };
}

export function sameConversationImportDestination(
  left: ConversationImportDestination,
  right: ConversationImportDestination,
): boolean {
  return stableStringify(encodeDestination(left)) === stableStringify(encodeDestination(right));
}

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

export class ConversationImportStagingError extends Schema.TaggedError<ConversationImportStagingError>()(
  "ConversationImportStagingError",
  {
    reason: Schema.Literals([
      /** The resource ID is not one of this import's staged attachments. */
      "attachment-not-staged",
      /** The staged bytes no longer match their verified size or SHA-256. */
      "attachment-corrupt",
      /** The destination already holds different bytes. */
      "destination-conflict",
      "io-failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Exclusive access to one validated import for the duration of one
 * `importConversation` call. Valid only inside that call.
 */
export interface ConversationImportLease {
  readonly importId: ConversationImportId;
  readonly input: ValidatedConversationImport;
  /**
   * Server-owned directory inside the staging area that belongs to the
   * importer. Exists; empty on a new attempt, and holds the current attempt's
   * journal when resuming. The importer writes and flushes its journal here
   * before publishing anything, and empties it when an attempt ends rejected.
   */
  readonly attemptDirectory: string;
  /**
   * Publishes a staged attachment at `destinationPath`, a server path the
   * importer chose inside its own storage. Copies (the staged file stays),
   * verifies size and SHA-256 while copying, writes through a temporary file
   * and rename, and succeeds without copying when the destination already
   * holds the same bytes.
   */
  readonly copyAttachment: (input: {
    readonly resourceId: ConversationImportResourceId;
    readonly destinationPath: string;
  }) => Effect.Effect<void, ConversationImportStagingError>;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export class ConversationImporterError extends Schema.TaggedError<ConversationImporterError>()(
  "ConversationImporterError",
  {
    reason: Schema.Literals([
      "project-not-found",
      "provider-unavailable",
      /** Not committed; the attempt is kept and the next confirm resumes it. */
      "import-failed",
      /** The command was rejected; the attempt is settled and `attemptDirectory` is empty. */
      "import-rejected",
      /** A kept, uncommitted attempt is bound to another destination; nothing was changed. */
      "destination-changed",
      /** This build has no importer. Never reachable in a release: the import command replaces it. */
      "importer-unavailable",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ConversationImportSettleError extends Schema.TaggedError<ConversationImportSettleError>()(
  "ConversationImportSettleError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** One confirm, as the importer receives it. */
export interface ConversationImportRequest {
  readonly destination: ConversationImportDestination;
  /** The authenticated caller of this confirm; the importer checks its scope and destination authority. */
  readonly principal: EnvironmentSessionPrincipalShape;
}

/** An attempt that will not continue, handed to the importer before its staging area is removed. */
export interface AbandonedConversationImportAttempt {
  readonly importId: ConversationImportId;
  /** Not empty. */
  readonly attemptDirectory: string;
  readonly reason: "cancelled" | "expired" | "startup";
}

/** The attempt's command receipt: accepted, rejected, or absent. */
export type SettledConversationImportAttempt =
  | { readonly _tag: "committed"; readonly completion: ConversationImportCompletion }
  | { readonly _tag: "rejected"; readonly detail: string }
  | { readonly _tag: "rolled-back" };

export class ConversationImporter extends Context.Service<
  ConversationImporter,
  {
    /**
     * Imports once, under the lease. Checks, in order: a kept attempt's receipt
     * (accepted returns its completion, whatever `request.destination` is;
     * rejected clears it), then a kept attempt's binding (another destination
     * fails `destination-changed`), then authority. Succeeds only after the
     * import command committed. Cancel interrupts this effect: everything up to
     * the dispatch of `thread.conversation.import` must tolerate interruption
     * (leaving only journal-listed files), and the dispatch and everything
     * after it must be uninterruptible. A failure after commit (for example
     * while reporting back) is repaired by the next call, which finds the
     * accepted receipt and returns the same completion.
     */
    readonly importConversation: (
      lease: ConversationImportLease,
      request: ConversationImportRequest,
    ) => Effect.Effect<ConversationImportCompletion, ConversationImporterError>;
    /**
     * Settles an attempt by its command receipt (see "Attempts and commit
     * receipts"). Called with exclusive access to the staging area and no
     * import running.
     */
    readonly settleAttempt: (
      attempt: AbandonedConversationImportAttempt,
    ) => Effect.Effect<SettledConversationImportAttempt, ConversationImportSettleError>;
  }
>()("t3/scient/conversationImport/ConversationImporter") {
  /**
   * Stands in until the import command lands, so staging and preview build and
   * run: every confirm fails `importer-unavailable`, honestly. It never
   * publishes anything, so there is never an attempt to settle.
   */
  static readonly layerUnavailable = Layer.succeed(this, {
    importConversation: () =>
      Effect.fail(
        new ConversationImporterError({
          reason: "importer-unavailable",
          detail: "This Scient cannot import conversations yet.",
        }),
      ),
    settleAttempt: (attempt) =>
      Effect.fail(
        new ConversationImportSettleError({
          detail: `Import ${attempt.importId} has an attempt this Scient cannot settle.`,
          cause: null,
        }),
      ),
  });
}
