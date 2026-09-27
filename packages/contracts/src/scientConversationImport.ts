import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import {
  ConversationSnapshotWarning,
  ConversationThreadInfo,
  DocumentWarning,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  Sha256Digest,
} from "./scientConversationExport.ts";

/**
 * Portable conversation import contracts: the `.scic` file identity, the
 * staged-import lifecycle a client drives, the preview it shows, and the
 * confirm call that turns a validated package into a new thread.
 *
 * Lifecycle, all keyed by one server-issued `ConversationImportId`:
 *
 * 1. `createUpload` admits the declared size against the per-import limit and
 *    the server's staging quota, creates the import's staging area, and
 *    returns a signed, single-use upload URL.
 * 2. The client streams the file bytes to that URL.
 * 3. `preview` validates the package once (later calls reuse the result),
 *    stages its attachments, and describes it. Preview makes no durable change.
 * 4. `import` (confirm) creates a new independent thread from the staged
 *    package; `cancel` discards it. Unconfirmed imports expire on the server.
 *
 * Nothing in a package is authority: every ID it carries is external and is
 * replaced on import, and the thread is labelled "Imported — unverified".
 * See docs/internals/scient-conversation-export-import-proposal.md.
 */

const ShortText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

// ---------------------------------------------------------------------------
// File identity
// ---------------------------------------------------------------------------

export const SCIC_FILE_EXTENSION = ".scic";
/** Media type, and the exact content of the uncompressed first `mimetype` entry. */
export const SCIC_MEDIA_TYPE = "application/vnd.scient.conversation+zip";
export const SCIC_FORMAT = "scient.conversation-file";
/** A newer minor version is read with a warning; any other major version is rejected. */
export const SCIC_FORMAT_MAJOR_VERSION = 1;
export const SCIC_FORMAT_MINOR_VERSION = 0;

/**
 * Largest `.scic` one import may upload: the export's attachment ceiling plus
 * room for the conversation documents, manifest, and ZIP overhead. Separate
 * from, and larger than, the chat attachment limit.
 */
export const SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES =
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES + 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** One staged import on one server. Issued by `createUpload`; never reused. */
export const ConversationImportId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^cimp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
).pipe(Schema.brand("ConversationImportId"));
export type ConversationImportId = typeof ConversationImportId.Type;

/**
 * An identifier minted by another installation (export ID, source thread ID).
 * Recorded as provenance only; never used as, or converted to, a local ID.
 */
export const ConversationExternalId = ShortText(256);
export type ConversationExternalId = typeof ConversationExternalId.Type;

/**
 * A package-scoped attachment identity. In a `.scic`, every
 * `ConversationAttachment.localId` in `conversation.json` is one of these, and
 * the manifest lists it as included (with its entry path, size, and SHA-256)
 * or unavailable.
 */
export const ConversationImportResourceId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^attachment-[1-9][0-9]{0,8}$/),
);
export type ConversationImportResourceId = typeof ConversationImportResourceId.Type;

// ---------------------------------------------------------------------------
// What a validated package says about itself
// ---------------------------------------------------------------------------

export const ConversationImportFormatVersion = Schema.Struct({
  major: PositiveInt,
  minor: NonNegativeInt,
});
export type ConversationImportFormatVersion = typeof ConversationImportFormatVersion.Type;

/**
 * The manifest facts an import records, plus the digest of the file as the
 * server received it. `contentDigest` has been checked against the snapshot.
 * Hashes establish internal integrity, not who sent the file.
 */
export const ConversationImportPackageSummary = Schema.Struct({
  format: Schema.Literal(SCIC_FORMAT),
  formatVersion: ConversationImportFormatVersion,
  exporter: Schema.Struct({ name: ShortText(64), version: ShortText(64) }),
  exportId: ConversationExternalId,
  exportedAt: IsoDateTime,
  /** The sender's thread ID, external. */
  sourceThreadId: ConversationExternalId,
  contentDigest: Sha256Digest,
  packageSha256: Sha256Digest,
  packageBytes: PositiveInt,
});
export type ConversationImportPackageSummary = typeof ConversationImportPackageSummary.Type;

/**
 * Content the sender's file does not carry. Beyond these, a package never
 * carries the sender's provider session, pending approvals or questions, or
 * workspace files; the preview states that as fixed text.
 */
export const ConversationImportOmission = Schema.Union([
  Schema.TaggedStruct("work-log-excluded", {}),
  Schema.TaggedStruct("reasoning-excluded", {}),
  /** The sender exported only up to a message; `throughMessageN` is the last one included. */
  Schema.TaggedStruct("range-truncated", { throughMessageN: PositiveInt }),
  /** A running turn, unavailable attachments, or skipped records, as the sender's snapshot recorded them. */
  Schema.TaggedStruct("snapshot-warning", { warning: ConversationSnapshotWarning }),
]);
export type ConversationImportOmission = typeof ConversationImportOmission.Type;

export const ConversationImportWarning = Schema.Union([
  /** A line the sender's export reported. Untrusted text; shown as plain text. */
  Schema.TaggedStruct("export-warning", { warning: DocumentWarning }),
  /** Written by a newer minor format version; fields this build does not know were ignored. */
  Schema.TaggedStruct("newer-minor-version", { formatVersion: ConversationImportFormatVersion }),
]);
export type ConversationImportWarning = typeof ConversationImportWarning.Type;

/** Why validation refused a package. Validation fails closed on the first violation. */
export const ConversationImportRejectionReason = Schema.Literals([
  /** Not a readable ZIP, or a damaged one (bad headers, CRC mismatch, truncated). */
  "corrupt-archive",
  /** No `mimetype` first entry, compressed, or not exactly `SCIC_MEDIA_TYPE`. */
  "mimetype-invalid",
  /** Absolute, drive-qualified, backslashed, or parent-traversing path. */
  "unsafe-path",
  /** Symlink, device, or other non-regular entry. */
  "special-entry",
  /** Two entries with the same path, or paths equal after case folding. */
  "duplicate-path",
  "encrypted-entry",
  "too-many-entries",
  "entry-too-large",
  "package-too-large",
  "compression-ratio",
  "manifest-invalid",
  "unsupported-version",
  /** An entry's size or SHA-256 differs from the manifest, or a declared entry is missing. */
  "manifest-mismatch",
  "undeclared-entry",
  /** `conversation.json` is not a valid snapshot, disagrees with the manifest, or fails its content digest. */
  "snapshot-invalid",
  /** Attachment bytes contradict their declared type. */
  "attachment-type-mismatch",
  /** Attachment type or size outside what Scient accepts as a chat attachment. */
  "attachment-policy",
]);
export type ConversationImportRejectionReason = typeof ConversationImportRejectionReason.Type;

export const ConversationImportRejection = Schema.Struct({
  reason: ConversationImportRejectionReason,
  /** The offending entry path, when one entry is at fault; bounded, shown as plain text. */
  entry: Schema.NullOr(ShortText(512)),
});
export type ConversationImportRejection = typeof ConversationImportRejection.Type;

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------

export const ScientConversationImportCreateUploadRequest = Schema.Struct({
  /** Display name only; the server never uses it as a path. */
  fileName: ShortText(255),
  sizeBytes: PositiveInt.check(
    Schema.isLessThanOrEqualTo(SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES),
  ),
});
export type ScientConversationImportCreateUploadRequest =
  typeof ScientConversationImportCreateUploadRequest.Type;

export const ScientConversationImportUpload = Schema.Struct({
  importId: ConversationImportId,
  /** Signed upload path accepting exactly `sizeBytes`, once, resolved against the environment's HTTP base URL. */
  relativeUrl: ShortText(4_096),
  expiresAt: Schema.Number,
});
export type ScientConversationImportUpload = typeof ScientConversationImportUpload.Type;

export const ScientConversationImportPreviewRequest = Schema.Struct({
  importId: ConversationImportId,
});
export type ScientConversationImportPreviewRequest =
  typeof ScientConversationImportPreviewRequest.Type;

/** Everything the preview dialog shows. Carries no message content. */
export const ScientConversationImportPreview = Schema.Struct({
  importId: ConversationImportId,
  kind: Schema.Literal("scic"),
  fileName: ShortText(255),
  package: ConversationImportPackageSummary,
  /** Title, dates, and source provider/model (informational) from the sender's snapshot. */
  conversation: ConversationThreadInfo,
  counts: Schema.Struct({
    messages: NonNegativeInt,
    /** Attachments whose bytes are in the package. */
    attachments: NonNegativeInt,
    reasoning: NonNegativeInt,
    workLogEntries: NonNegativeInt,
    proposedPlans: NonNegativeInt,
    questionAnswers: NonNegativeInt,
  }),
  omissions: Schema.Array(ConversationImportOmission),
  warnings: Schema.Array(ConversationImportWarning),
  /** When the staged import expires unless previewed or confirmed again. */
  expiresAt: Schema.Number,
});
export type ScientConversationImportPreview = typeof ScientConversationImportPreview.Type;

/** Where the imported thread goes and what continues it. Chosen in the preview. */
export const ConversationImportDestination = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type ConversationImportDestination = typeof ConversationImportDestination.Type;

export const ScientConversationImportConfirmRequest = Schema.Struct({
  importId: ConversationImportId,
  /** The package the user previewed; the import is refused if the staged package differs. */
  packageSha256: Sha256Digest,
  destination: ConversationImportDestination,
});
export type ScientConversationImportConfirmRequest =
  typeof ScientConversationImportConfirmRequest.Type;

/** A committed import. Repeating the confirm for the same import returns the same result. */
export const ScientConversationImportResult = Schema.Struct({
  importId: ConversationImportId,
  threadId: ThreadId,
  messageCount: NonNegativeInt,
  attachmentCount: NonNegativeInt,
});
export type ScientConversationImportResult = typeof ScientConversationImportResult.Type;

export const ScientConversationImportCancelRequest = Schema.Struct({
  importId: ConversationImportId,
});
export type ScientConversationImportCancelRequest =
  typeof ScientConversationImportCancelRequest.Type;

/**
 * `cancelled`: the staged import is gone (or never existed); nothing was
 * imported. `already-imported`: the cancel arrived after the import committed;
 * the thread exists and is kept.
 */
export const ScientConversationImportCancelResult = Schema.Union([
  Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("already-imported", { result: ScientConversationImportResult }),
]);
export type ScientConversationImportCancelResult = typeof ScientConversationImportCancelResult.Type;

export const ScientConversationImportErrorReason = Schema.Literals([
  /** Unknown, expired, cancelled, or cleaned-up import. */
  "import-not-found",
  "package-too-large",
  /** The server's staging quota or live-import limit is reached. */
  "staging-full",
  /** Preview or confirm before the upload finished. */
  "upload-incomplete",
  /** Validation refused the package; `rejection` says why. */
  "package-rejected",
  /** Another confirm or cancel is using this import. */
  "import-busy",
  /** The confirm's `packageSha256` is not the staged package's. */
  "package-changed",
  "project-not-found",
  "provider-unavailable",
  /** The import did not commit; the staged import is kept and the same confirm may be retried. */
  "import-failed",
  /** This server cannot import conversations. */
  "importer-unavailable",
  /** A cancel interrupted this confirm before it committed. */
  "cancelled",
]);
export type ScientConversationImportErrorReason = typeof ScientConversationImportErrorReason.Type;

export class ScientConversationImportError extends Schema.TaggedError<ScientConversationImportError>()(
  "ScientConversationImportError",
  {
    reason: ScientConversationImportErrorReason,
    /** Set only when `reason` is `package-rejected`. */
    rejection: Schema.NullOr(ConversationImportRejection),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientConversationImportError)(this, { status: 409 });
  }
}
