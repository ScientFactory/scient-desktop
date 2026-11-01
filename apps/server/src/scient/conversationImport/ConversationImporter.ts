// @effect-diagnostics nodeBuiltinImport:off -- the content digest is checked inside a synchronous schema filter.
/**
 * Staging owns leased areas/quota until removal, even after failed cleanup; disconnect cannot
 * cancel its fibers. Reauthorize confirms and bind each durable journal to one destination.
 * Receipts alone settle ownership; join before rollback. Persist completion before removing the
 * journal so crash/cancel cannot erase an accepted import.
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
 * Import commits hold the orchestration engine in one transaction. Work-log-heavy commit cost grows
 * faster than linearly, so cap records rather than relying only on byte limits; qualify with
 * ConversationImportBenchmark.
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

/**
 * Hash the decoded snapshot, excluding captured/digest, to certify exactly what import writes.
 * Reject received canonical content that decoding would discard; newer minor manifest-only
 * additions can still import with a warning.
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
 * Require unambiguous external-to-local mapping: unique IDs, contiguous turn messages, ordered
 * numbering, no omitted/unselected records, and references to each message's own attachments.
 * Turnless steering may sit inside a turn's run.
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
 * Derive mandatory running-turn and unavailable-attachment warnings from snapshot facts so senders
 * cannot hide omissions by deleting warnings. Preserve skipped-record warnings whose omitted
 * contents are no longer observable.
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
 * Shape validation is insufficient: bind snapshot digest/source/version to the package, require
 * unambiguous structure and factual omission warnings, and match staged bytes exactly to available
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
 * Every snapshot ID is external. Mint fresh local IDs with a one-to-one mapping; record sender
 * identity only as import provenance. The sender's snapshot.provenance is history, never the
 * imported thread's own origin.
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
 * Reuse the caller's digest only for this decoded snapshot or byte-identical validated staged
 * bytes; avoid a second snapshot encode/decode pass.
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
   * Copy rather than consume staging. Verify size/SHA-256 through temporary write and rename; an
   * existing destination succeeds only when its bytes match.
   */
  readonly copyAttachment: (input: {
    readonly resourceId: ConversationImportResourceId;
    readonly destinationPath: string;
  }) => Effect.Effect<void, ConversationImportStagingError>;
}

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
     * Check kept receipts before binding/authority so accepted retries report the original
     * destination. Before dispatch, tolerate interruption with only journal-listed files; dispatch
     * onward is uninterruptible. Repair post-commit failure from the receipt rather than
     * redispatching history.
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
    importConversation: Effect.fn("ConversationImporter.importConversation")(function () {
      return Effect.fail(
        new ConversationImporterError({
          reason: "importer-unavailable",
          detail: "This Scient cannot import conversations yet.",
        }),
      );
    }),
    settleAttempt: Effect.fn("ConversationImporter.settleAttempt")(function (attempt) {
      return Effect.fail(
        new ConversationImportSettleError({
          detail: `Import ${attempt.importId} has an attempt this Scient cannot settle.`,
          cause: null,
        }),
      );
    }),
  });
}
