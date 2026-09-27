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
 * ## Staging areas
 *
 * One directory per import, `<stateDir>/conversation-imports/<importId>/`,
 * created when `createUpload` admits the declared size and removed only by
 * staging. Its layout is private to staging except `attemptDirectory`, which
 * belongs to the importer (its attempt journal) and which staging only ever
 * removes as part of the whole area. Each area counts against
 * `CONVERSATION_IMPORT_STAGING_QUOTA_BYTES` and `CONVERSATION_IMPORT_MAX_LIVE`
 * from admission until removal. An area expires
 * `CONVERSATION_IMPORT_STAGING_TTL_MS` after its last upload, preview, or
 * confirm; an area whose upload never arrives expires with its upload URL.
 *
 * Staging removes an area when the user cancels, after a successful import,
 * when it expires, and at server startup (every area left from an earlier run
 * is abandoned). It never removes an area while a lease is held. Before
 * removing an area whose `attemptDirectory` is not empty, staging calls
 * `settleAttempt`; if settling fails, the area stays and is settled again on
 * the next sweep. An empty `attemptDirectory` means nothing was published.
 *
 * ## Leases
 *
 * Confirm runs the importer under an exclusive, in-process lease on the import.
 * While it is held, expiry and startup-style sweeps skip the area, a second
 * confirm joins the running attempt (or fails `import-busy` if its destination
 * differs), and cancel interrupts it. The import runs in a fiber owned by
 * staging, not by the HTTP request, so a client disconnect does not interrupt
 * it; repeating the confirm returns its result.
 *
 * ## Attempts, retry, and cleanup
 *
 * One import has one attempt and at most one committed thread. When
 * `importConversation` fails, the area and its `attemptDirectory` are kept, and
 * a later confirm for the same import calls `importConversation` again with the
 * same directory; the importer resumes from its journal (reusing its command
 * and thread IDs) and must never commit a second thread. When it succeeds,
 * staging keeps only the result, so a repeated confirm returns it, and removes
 * the rest of the area — never the files the importer published.
 *
 * Cleanup follows commit receipts and journal ownership, never whether a
 * thread exists now: `settleAttempt` keeps published files when the command
 * committed and deletes exactly the journal-listed files when it did not.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ConversationImportId,
  ConversationImportOmission,
  ConversationImportPackageSummary,
  ConversationImportResourceId,
  ConversationImportWarning,
  ConversationSnapshotV1,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  PositiveInt,
  Sha256Digest,
  TrimmedNonEmptyString,
  type ConversationAttachment,
  type ConversationImportDestination,
  type ScientConversationImportResult,
} from "@t3tools/contracts";

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

const isResourceId = Schema.is(ConversationImportResourceId);

/**
 * The cross-references validation guarantees: the package digest is the
 * snapshot's, every snapshot attachment names a package resource, available
 * ones are backed by exactly one staged attachment that agrees on kind, name,
 * type, and size, unavailable ones by none, and nothing is staged that no
 * snapshot attachment uses.
 */
export function checkValidatedConversationImport(input: {
  readonly package: ConversationImportPackageSummary;
  readonly snapshot: ConversationSnapshotV1;
  readonly attachments: ReadonlyArray<StagedConversationImportAttachment>;
}): true | string {
  if (input.package.contentDigest !== input.snapshot.contentDigest) {
    return "The package digest is not the snapshot's content digest.";
  }
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
 * What staging hands the importer: a package that passed every validation
 * check, described by its manifest summary, with its attachments staged.
 *
 * Every identifier inside `snapshot` — `captured.threadId`, message, turn, plan,
 * and activity IDs, and any fork origin in `snapshot.provenance` — was minted by
 * another installation. The importer mints new local IDs for everything it
 * writes and records external identity only as import provenance, built from
 * `package` (export ID, source thread ID, digests, format version).
 * `snapshot.provenance` is the sender's history and is never the imported
 * thread's provenance.
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
   * importer. Exists; empty on the first attempt, and holds whatever the
   * importer left there on a retry. The importer writes and flushes its attempt
   * journal here before publishing anything.
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
    reason: Schema.Literals(["project-not-found", "provider-unavailable", "import-failed"]),
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

/** An attempt that will not continue, handed to the importer before its staging area is removed. */
export interface AbandonedConversationImportAttempt {
  readonly importId: ConversationImportId;
  /** Not empty. */
  readonly attemptDirectory: string;
  readonly reason: "cancelled" | "expired" | "startup";
}

export type SettledConversationImportAttempt =
  | { readonly _tag: "committed"; readonly result: ScientConversationImportResult }
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
     * back) is repaired by the next call, which finds the commit receipt and
     * returns the same result.
     */
    readonly importConversation: (
      lease: ConversationImportLease,
      destination: ConversationImportDestination,
    ) => Effect.Effect<ScientConversationImportResult, ConversationImporterError>;
    /**
     * Settles an attempt by its commit receipt: committed keeps the published
     * files and reports the result; not committed deletes exactly the files its
     * journal lists. Called with exclusive access to the staging area.
     */
    readonly settleAttempt: (
      attempt: AbandonedConversationImportAttempt,
    ) => Effect.Effect<SettledConversationImportAttempt, ConversationImportSettleError>;
  }
>()("t3/scient/conversationImport/ConversationImporter") {}
