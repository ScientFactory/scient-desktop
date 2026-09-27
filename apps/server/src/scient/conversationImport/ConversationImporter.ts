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
 * One directory per import, `<stateDir>/conversation-imports/<importId>/`,
 * created only by `createUpload` (under a fresh ID) and removed only by
 * staging. Its layout is private to staging except `attemptDirectory`, which
 * belongs to the importer (its attempt journal) and which staging only ever
 * removes as part of the whole area. Each area counts against
 * `CONVERSATION_IMPORT_STAGING_QUOTA_BYTES` and `CONVERSATION_IMPORT_MAX_LIVE`
 * from admission until removal. An idle area expires
 * `CONVERSATION_IMPORT_STAGING_TTL_MS` after its last upload, preview, or
 * confirm; an area whose upload never arrives expires with its upload URL.
 *
 * Staging removes an area when the user cancels, after a successful import,
 * when it expires, and at server startup (every area left from an earlier run
 * is abandoned). Before removing an area whose `attemptDirectory` is not empty,
 * staging calls `settleAttempt`; if settling fails, the area stays and is
 * settled again on the next sweep. An empty `attemptDirectory` means nothing
 * was published.
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
 * - cancel first marks the import cancelled, then interrupts the running fiber,
 *   joins it, settles the attempt, and removes the area.
 *
 * A result is published only if the import is still live when its fiber ends,
 * under the lease: a cancelled import never returns a preview, and its joined
 * requests fail `cancelled`. A cancelled or unknown ID never gets an area
 * again: uploads and validation write only into an existing, live area.
 *
 * ## Attempts and commit receipts
 *
 * One import has at most one committed thread. An attempt is one command ID
 * and destination thread ID, recorded in the importer's journal. The command's
 * receipt decides everything, never whether a thread exists now:
 *
 * - **accepted** — the thread committed. Published files belong to it and are
 *   never deleted. `importConversation` returns the result (again, on a retry
 *   that finds the receipt); `settleAttempt` reports `committed`.
 * - **rejected** — the engine refused that command, permanently: resending
 *   the same command ID fails `OrchestrationCommandPreviouslyRejectedError`.
 *   The importer deletes exactly the journal-listed files, clears
 *   `attemptDirectory`, and reports `import-rejected` (or `rejected` when
 *   settling). The attempt is over; confirming again starts a new attempt with
 *   a new command ID and thread ID, typically with another destination.
 * - **absent** — nothing committed. After a failure the attempt is kept:
 *   `importConversation` fails `import-failed`, and the next confirm resumes it
 *   from the journal with the same IDs, so a dispatch that did commit is found
 *   rather than repeated. When the attempt will not continue (cancel, expiry,
 *   startup), `settleAttempt` deletes exactly the journal-listed files and
 *   reports `rolled-back`. Settling runs only when no import fiber is running,
 *   so no dispatch for the attempt can still be in flight.
 *
 * After a commit, staging stores a `ConversationImportCompletion` (the
 * confirm's package digest and destination with the result) outside the area,
 * keeps it for `CONVERSATION_IMPORT_COMPLETION_RETENTION_MS` across restarts,
 * and removes the rest of the area. A repeated confirm is answered from it:
 * same digest and destination return the result, another digest fails
 * `package-changed`, another destination `already-imported`.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
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
  SCIC_FORMAT_MAJOR_VERSION,
  SCIC_FORMAT_MINOR_VERSION,
  ScientConversationImportResult,
  Sha256Digest,
  TrimmedNonEmptyString,
  type ConversationAttachment,
  type ConversationProvenance,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

// ---------------------------------------------------------------------------
// Staging policy
// ---------------------------------------------------------------------------

/** Under the server's state directory. */
export const CONVERSATION_IMPORT_STAGING_DIRECTORY = "conversation-imports";
export const CONVERSATION_IMPORT_STAGING_TTL_MS = 60 * 60_000;
/** Bytes all staging areas may hold together: uploaded packages plus staged attachments. */
export const CONVERSATION_IMPORT_STAGING_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
/** Staging areas that may exist at once, whatever their size. */
export const CONVERSATION_IMPORT_MAX_LIVE = 8;
/** How long a committed import's confirm binding and result are kept. */
export const CONVERSATION_IMPORT_COMPLETION_RETENTION_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Validated import input
// ---------------------------------------------------------------------------

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
 * own warnings. Staging reports exactly these.
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
 * per kind, each turn's messages are contiguous, the omitted running turn
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

  const closedTurns = new Set<string>();
  let currentTurn: string | null = null;
  for (const message of snapshot.messages) {
    if (message.turnId === currentTurn) continue;
    if (currentTurn !== null) closedTurns.add(currentTurn);
    if (message.turnId !== null && closedTurns.has(message.turnId)) {
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
 * beyond the shape of its parts: the package describes this snapshot (digest,
 * source thread, a supported major version), the snapshot's structure is
 * unambiguous, the omissions and version warning are exactly what the snapshot
 * and package imply, and the staged attachments back exactly the available
 * snapshot attachments.
 */
export function checkValidatedConversationImport(input: {
  readonly package: ConversationImportPackageSummary;
  readonly snapshot: ConversationSnapshotV1;
  readonly attachments: ReadonlyArray<StagedConversationImportAttachment>;
  readonly omissions: ReadonlyArray<ConversationImportOmission>;
  readonly warnings: ReadonlyArray<ConversationImportWarning>;
}): true | string {
  const { formatVersion } = input.package;
  if (formatVersion.major !== SCIC_FORMAT_MAJOR_VERSION) {
    return `Format version ${formatVersion.major} is not supported.`;
  }
  if (input.package.contentDigest !== input.snapshot.contentDigest) {
    return "The package digest is not the snapshot's content digest.";
  }
  if (input.package.sourceThreadId !== input.snapshot.captured.threadId) {
    return "The package's source thread is not the snapshot's thread.";
  }
  const structure = checkSnapshotStructure(input.snapshot);
  if (structure !== true) return structure;
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
}).check(
  Schema.makeFilter(checkValidatedConversationImport, {
    identifier: "ValidatedConversationImport",
  }),
);
export type ValidatedConversationImport = typeof ValidatedConversationImport.Type;

export type ConversationImportProvenance = Extract<ConversationProvenance, { _tag: "import" }>;

/** The imported thread's provenance: the package's external identity, and when it was imported. */
export function conversationImportProvenance(
  summary: ConversationImportPackageSummary,
  importedAt: string,
): ConversationImportProvenance {
  return {
    _tag: "import",
    source: "scic",
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

/** A committed import's confirm binding and result, kept after its staging area is removed. */
export const ConversationImportCompletion = Schema.Struct({
  importId: ConversationImportId,
  packageSha256: Sha256Digest,
  destination: ConversationImportDestination,
  result: ScientConversationImportResult,
  completedAt: IsoDateTime,
});
export type ConversationImportCompletion = typeof ConversationImportCompletion.Type;

const encodeDestination = Schema.encodeSync(ConversationImportDestination);

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
  | { readonly _tag: "committed"; readonly result: ScientConversationImportResult }
  | { readonly _tag: "rejected"; readonly detail: string }
  | { readonly _tag: "rolled-back" };

export class ConversationImporter extends Context.Service<
  ConversationImporter,
  {
    /**
     * Imports once, under the lease. Succeeds only after the import command
     * committed. Cancel interrupts this effect: everything up to the dispatch of
     * `thread.conversation.import` must tolerate interruption (leaving only
     * journal-listed files), and the dispatch and everything after it must be
     * uninterruptible. A failure after commit (for example while reporting
     * back) is repaired by the next call, which finds the accepted receipt and
     * returns the same result.
     */
    readonly importConversation: (
      lease: ConversationImportLease,
      request: ConversationImportRequest,
    ) => Effect.Effect<ScientConversationImportResult, ConversationImporterError>;
    /**
     * Settles an attempt by its command receipt (see "Attempts and commit
     * receipts"). Called with exclusive access to the staging area and no
     * import running.
     */
    readonly settleAttempt: (
      attempt: AbandonedConversationImportAttempt,
    ) => Effect.Effect<SettledConversationImportAttempt, ConversationImportSettleError>;
  }
>()("t3/scient/conversationImport/ConversationImporter") {}
