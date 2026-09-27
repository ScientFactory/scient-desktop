import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ToolLifecycleItemType } from "./providerRuntime.ts";
import { OrchestrationConversationImportOmission } from "./orchestration.ts";

/**
 * Conversation export contracts: the versioned conversation snapshot, the
 * source-neutral document bundle every readable-output writer consumes, and
 * the HTTP surface a client uses to request an export.
 *
 * The snapshot is captured on the server from durable projections at a known
 * sequence; readable formats (Markdown, PDF, Word) are functions of a document
 * bundle built from it, and a transfer file is the snapshot serialized with its
 * attachments. See docs/internals/scient-conversation-export.md.
 */

const ShortText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
export type Sha256Digest = typeof Sha256Digest.Type;

/**
 * Text kept to a head and tail by the export projection. `omittedLines` and
 * `omittedChars` describe what was cut from the middle; both are zero when the
 * text is complete.
 */
export const ConversationBoundedText = Schema.Struct({
  text: Schema.String,
  omittedLines: NonNegativeInt,
  omittedChars: NonNegativeInt,
});
export type ConversationBoundedText = typeof ConversationBoundedText.Type;

// ---------------------------------------------------------------------------
// Conversation snapshot
// ---------------------------------------------------------------------------

export const CONVERSATION_SNAPSHOT_FORMAT = "scient.conversation-snapshot";

export const ConversationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type ConversationMessageRole = typeof ConversationMessageRole.Type;

export const ConversationAttachmentKind = Schema.Literals(["image", "file", "other"]);
export type ConversationAttachmentKind = typeof ConversationAttachmentKind.Type;

/**
 * One attachment as recorded on a message or a submitted answer.
 * `localId` is the installation-local attachment identity the server resolves
 * bytes with; readable outputs never print it and transfer files replace it.
 */
export const ConversationAttachment = Schema.Struct({
  localId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  kind: ConversationAttachmentKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
  /** Clipboard text a client folded into a file attachment. */
  pastedText: Schema.Boolean,
  /** Whether the bytes were present when the snapshot was captured. */
  available: Schema.Boolean,
});
export type ConversationAttachment = typeof ConversationAttachment.Type;

/**
 * Link destinations in snapshot message text that point at one of the
 * message's typed inline references: `[label](scient-ref:r1)`.
 */
export const CONVERSATION_REFERENCE_URL_PREFIX = "scient-ref:";

export const ConversationReferenceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^r[0-9]+$/),
);
export type ConversationReferenceId = typeof ConversationReferenceId.Type;

const referenceBase = {
  id: ConversationReferenceId,
  label: ShortText(512),
} as const;

/**
 * The export projection of Scient's inline message references: composer
 * context chips and captured quotes. Each supported kind keeps an explicit set
 * of display fields; installation-local identities (environment, thread, and
 * message ids, absolute workspace roots, document revisions, editor positions)
 * and open payloads are never carried. Unsupported kinds are dropped, their
 * label kept as plain text, and counted in a `records-skipped` warning.
 */
export const ConversationInlineReference = Schema.Union([
  /** An image or file chip bound to one of the message's attachments. */
  Schema.TaggedStruct("attachment", {
    ...referenceBase,
    attachmentLocalId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    image: Schema.Boolean,
  }),
  /** "Cite selected text" from a project file. `path` is relative to the project. */
  Schema.TaggedStruct("file-excerpt", {
    ...referenceBase,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    startLine: PositiveInt,
    endLine: PositiveInt,
    unsaved: Schema.Boolean,
    text: Schema.String,
    comment: Schema.NullOr(Schema.String),
  }),
  /** A quote of an earlier assistant message. */
  Schema.TaggedStruct("message-excerpt", {
    ...referenceBase,
    text: Schema.String,
    comment: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("terminal", {
    ...referenceBase,
    terminal: ShortText(255),
    lineStart: NonNegativeInt,
    lineEnd: NonNegativeInt,
    text: ConversationBoundedText,
  }),
  /** An @-mentioned workspace path, relative to the project. */
  Schema.TaggedStruct("mention", {
    ...referenceBase,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  }),
  Schema.TaggedStruct("skill", {
    ...referenceBase,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  }),
  Schema.TaggedStruct("review-comment", {
    ...referenceBase,
    filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    rangeLabel: ShortText(2_048),
    comment: ConversationBoundedText,
    diff: ConversationBoundedText,
  }),
  Schema.TaggedStruct("page-element", {
    ...referenceBase,
    pageUrl: ShortText(2_048),
    pageTitle: Schema.NullOr(ShortText(2_048)),
    tagName: ShortText(255),
    selector: Schema.NullOr(ShortText(2_048)),
  }),
  Schema.TaggedStruct("preview-annotation", {
    ...referenceBase,
    pageUrl: ShortText(2_048),
    pageTitle: Schema.NullOr(ShortText(2_048)),
    comment: ConversationBoundedText,
    targetSummary: ShortText(2_048),
  }),
]);
export type ConversationInlineReference = typeof ConversationInlineReference.Type;

/**
 * A completed transcript message. `n` is the 1-based position among the
 * snapshot's messages; it is stable for one snapshot and is what Markdown
 * markers and range selection refer to.
 */
export const ConversationMessage = Schema.Struct({
  n: PositiveInt,
  id: MessageId,
  role: ConversationMessageRole,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /**
   * Message Markdown as stored, except that Scient inline references point at
   * `references` through `scient-ref:` destinations.
   */
  text: Schema.String,
  attachments: Schema.Array(ConversationAttachment),
  references: Schema.Array(ConversationInlineReference),
});
export type ConversationMessage = typeof ConversationMessage.Type;

/** The provider reasoning text chat shows in a collapsed block. Nothing is reconstructed. */
export const ConversationReasoning = Schema.Struct({
  id: MessageId,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  text: Schema.String,
});
export type ConversationReasoning = typeof ConversationReasoning.Type;

export const ConversationProposedPlan = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  markdown: Schema.String,
  implemented: Schema.Boolean,
});
export type ConversationProposedPlan = typeof ConversationProposedPlan.Type;

/** A question the agent asked and the answer the user submitted. Unanswered questions never appear. */
export const ConversationQuestionAnswer = Schema.Struct({
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  items: Schema.Array(
    Schema.Struct({
      question: Schema.NullOr(Schema.String),
      answer: Schema.String,
      attachments: Schema.Array(ConversationAttachment),
    }),
  ),
});
export type ConversationQuestionAnswer = typeof ConversationQuestionAnswer.Type;

export const ConversationWorkLogStatus = Schema.Literals([
  "in-progress",
  "completed",
  "failed",
  "declined",
  "stopped",
]);
export type ConversationWorkLogStatus = typeof ConversationWorkLogStatus.Type;

const workLogBase = {
  id: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
} as const;

/**
 * The work log's export projection: an explicit set of display fields per
 * supported activity kind. Provider payload objects are never carried, and
 * nothing executable (approval requests, unanswered questions) is included.
 */
export const ConversationWorkLogEntry = Schema.Union([
  Schema.TaggedStruct("tool", {
    ...workLogBase,
    title: ShortText(512),
    itemType: Schema.NullOr(ToolLifecycleItemType),
    toolName: Schema.NullOr(ShortText(256)),
    status: Schema.NullOr(ConversationWorkLogStatus),
    command: Schema.NullOr(ConversationBoundedText),
    detail: Schema.NullOr(ConversationBoundedText),
    output: Schema.NullOr(ConversationBoundedText),
    changedFiles: Schema.Array(ShortText(1_024)),
    omittedChangedFiles: NonNegativeInt,
  }),
  Schema.TaggedStruct("task", {
    ...workLogBase,
    title: ShortText(512),
    status: Schema.NullOr(ConversationWorkLogStatus),
    agentRole: Schema.NullOr(ShortText(256)),
    detail: Schema.NullOr(ConversationBoundedText),
  }),
  Schema.TaggedStruct("notice", {
    ...workLogBase,
    level: Schema.Literals(["info", "warning", "error"]),
    title: ShortText(512),
    detail: Schema.NullOr(ConversationBoundedText),
  }),
  Schema.TaggedStruct("compaction", {
    ...workLogBase,
    title: ShortText(512),
  }),
  Schema.TaggedStruct("plan-steps", {
    ...workLogBase,
    explanation: Schema.NullOr(ConversationBoundedText),
    steps: Schema.Array(
      Schema.Struct({
        step: ShortText(2_048),
        status: Schema.Literals(["pending", "in-progress", "completed"]),
      }),
    ),
    omittedSteps: NonNegativeInt,
  }),
]);
export type ConversationWorkLogEntry = typeof ConversationWorkLogEntry.Type;

export const ConversationThreadInfo = Schema.Struct({
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Informational only: the provider driver and model the conversation ran on. */
  provider: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
});
export type ConversationThreadInfo = typeof ConversationThreadInfo.Type;

export const ConversationProvenance = Schema.Union([
  Schema.TaggedStruct("original", {}),
  Schema.TaggedStruct("fork", { originThreadId: ThreadId }),
  /**
   * Imported from a transfer file or from Scient-exported Markdown. Carries
   * external provenance only: the source ids are opaque strings from another
   * installation and never local thread ids. Both sources are unverified;
   * Markdown imports are text only.
   */
  Schema.TaggedStruct("import", {
    source: Schema.Literals(["scic", "markdown"]),
    exportId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    sourceThreadId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
    packageDigest: Sha256Digest,
    sourceFormat: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    sourceFormatVersion: PositiveInt,
    importedAt: IsoDateTime,
    /** Known gaps in the source history survive re-export to another installation. */
    omissions: Schema.optionalKey(
      Schema.Array(OrchestrationConversationImportOmission).check(Schema.isMaxLength(16)),
    ),
  }),
]);
export type ConversationProvenance = typeof ConversationProvenance.Type;

/** What the capture policy selected. Unselected content is never read into the snapshot. */
export const ConversationSnapshotSelection = Schema.Struct({
  workLog: Schema.Boolean,
  reasoning: Schema.Boolean,
  /** Last included message when the range stops early; null for the whole conversation. */
  throughMessageId: Schema.NullOr(MessageId),
});
export type ConversationSnapshotSelection = typeof ConversationSnapshotSelection.Type;

export const ConversationSnapshotWarning = Schema.Union([
  Schema.TaggedStruct("running-turn-omitted", { turnId: TurnId }),
  Schema.TaggedStruct("attachment-unavailable", {
    name: TrimmedNonEmptyString,
    messageN: Schema.NullOr(PositiveInt),
  }),
  Schema.TaggedStruct("attachment-unsupported", {
    name: TrimmedNonEmptyString,
    messageN: Schema.NullOr(PositiveInt),
  }),
  Schema.TaggedStruct("records-skipped", {
    kind: Schema.Literals(["activity", "question-answer", "context"]),
    count: PositiveInt,
  }),
]);
export type ConversationSnapshotWarning = typeof ConversationSnapshotWarning.Type;

export const ConversationSnapshotV1 = Schema.Struct({
  format: Schema.Literal(CONVERSATION_SNAPSHOT_FORMAT),
  version: Schema.Literal(1),
  thread: ConversationThreadInfo,
  provenance: ConversationProvenance,
  /** Where and when the snapshot was read. Excluded from the content digest. */
  captured: Schema.Struct({
    threadId: ThreadId,
    snapshotSequence: NonNegativeInt,
    threadSequence: NonNegativeInt,
    capturedAt: IsoDateTime,
  }),
  selection: ConversationSnapshotSelection,
  messages: Schema.Array(ConversationMessage),
  reasoning: Schema.Array(ConversationReasoning),
  workLog: Schema.Array(ConversationWorkLogEntry),
  proposedPlans: Schema.Array(ConversationProposedPlan),
  questionAnswers: Schema.Array(ConversationQuestionAnswer),
  /** The in-progress turn left out of this snapshot, if any. */
  omittedRunningTurn: Schema.NullOr(Schema.Struct({ turnId: TurnId })),
  warnings: Schema.Array(ConversationSnapshotWarning),
  /** SHA-256 of the canonical content (everything except `captured` and this field). */
  contentDigest: Sha256Digest,
});
export type ConversationSnapshotV1 = typeof ConversationSnapshotV1.Type;

// ---------------------------------------------------------------------------
// Document bundle
// ---------------------------------------------------------------------------

/**
 * `chat` bundles come from a conversation; their line breaks are already
 * written explicitly, so a document renderer needs no chat plugins. `document`
 * bundles follow Scient's document profile (CommonMark, GFM, alerts, math,
 * fenced code, Mermaid).
 */
export const DocumentMarkdownProfile = Schema.Literals(["chat", "document"]);
export type DocumentMarkdownProfile = typeof DocumentMarkdownProfile.Type;

export const DocumentDirection = Schema.Literals(["ltr", "rtl", "auto"]);
export type DocumentDirection = typeof DocumentDirection.Type;

export const DocumentSourceRef = Schema.Union([
  Schema.TaggedStruct("conversation", {
    threadId: ThreadId,
    contentDigest: Sha256Digest,
    snapshotSequence: NonNegativeInt,
  }),
  Schema.TaggedStruct("workspace-file", {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    revision: TrimmedNonEmptyString,
  }),
]);
export type DocumentSourceRef = typeof DocumentSourceRef.Type;

/**
 * Bundle Markdown refers to its assets as `scient-asset:<id>` link or image
 * destinations. Each writer resolves them: a packaged Markdown export rewrites
 * them to relative paths, a text-only export to names, a PDF page to asset URLs.
 */
export const DOCUMENT_ASSET_URL_PREFIX = "scient-asset:";

export const DocumentAssetId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);
export type DocumentAssetId = typeof DocumentAssetId.Type;

export const DocumentAssetUnavailableReason = Schema.Literals([
  "missing",
  "unreadable",
  "unsupported",
  "too-large",
]);
export type DocumentAssetUnavailableReason = typeof DocumentAssetUnavailableReason.Type;

export const DocumentAsset = Schema.Struct({
  id: DocumentAssetId,
  role: Schema.Literals(["attachment", "image", "rendered-diagram"]),
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mediaType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  byteLength: NonNegativeInt,
  /** Relative POSIX path a packaging writer stores the file under. */
  packagePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  content: Schema.Union([
    Schema.TaggedStruct("bytes", { bytes: Schema.Uint8Array, sha256: Sha256Digest }),
    Schema.TaggedStruct("unavailable", { reason: DocumentAssetUnavailableReason }),
  ]),
});
export type DocumentAsset = typeof DocumentAsset.Type;

// CSL-JSON (CSL 1.0.2), the reference data Pandoc's `--citeproc` consumes. The
// field names and name/date shapes match `scientSourceToCslJson` in
// `@scientfactory/scient-citations`; unknown fields are not carried.

const CSL_ITEM_TYPES = [
  "article",
  "article-journal",
  "article-magazine",
  "article-newspaper",
  "bill",
  "book",
  "broadcast",
  "chapter",
  "classic",
  "collection",
  "dataset",
  "document",
  "entry",
  "entry-dictionary",
  "entry-encyclopedia",
  "event",
  "figure",
  "graphic",
  "hearing",
  "interview",
  "legal_case",
  "legislation",
  "manuscript",
  "map",
  "motion_picture",
  "musical_score",
  "pamphlet",
  "paper-conference",
  "patent",
  "performance",
  "periodical",
  "personal_communication",
  "post",
  "post-weblog",
  "regulation",
  "report",
  "review",
  "review-book",
  "software",
  "song",
  "speech",
  "standard",
  "thesis",
  "treaty",
  "webpage",
] as const;
export const CslItemType = Schema.Literals(CSL_ITEM_TYPES);
export type CslItemType = typeof CslItemType.Type;

const CslText = Schema.String.check(Schema.isMaxLength(8_192));

/** A person or organization: structured parts, or a `literal` for corporate and single-field names. */
export const CslName = Schema.Struct({
  family: Schema.optionalKey(CslText),
  given: Schema.optionalKey(CslText),
  literal: Schema.optionalKey(CslText),
  suffix: Schema.optionalKey(CslText),
  "non-dropping-particle": Schema.optionalKey(CslText),
  "dropping-particle": Schema.optionalKey(CslText),
}).check(
  Schema.makeFilter(
    (name) => name.family !== undefined || name.given !== undefined || name.literal !== undefined,
    { identifier: "CslName" },
  ),
);
export type CslName = typeof CslName.Type;

const CslDatePart = Schema.Array(Schema.Int).check(Schema.isMinLength(1), Schema.isMaxLength(3));

/** One date or a range of two: `date-parts` of year, month, day; or free `literal` text. */
export const CslDate = Schema.Struct({
  "date-parts": Schema.optionalKey(
    Schema.Array(CslDatePart).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  ),
  literal: Schema.optionalKey(CslText),
  circa: Schema.optionalKey(Schema.Boolean),
  season: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
}).check(
  Schema.makeFilter((date) => date["date-parts"] !== undefined || date.literal !== undefined, {
    identifier: "CslDate",
  }),
);
export type CslDate = typeof CslDate.Type;

const CslNames = Schema.optionalKey(Schema.Array(CslName).check(Schema.isMaxLength(500)));
const CslString = Schema.optionalKey(CslText);

export const CslItem = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  type: CslItemType,
  title: CslString,
  "title-short": CslString,
  author: CslNames,
  editor: CslNames,
  translator: CslNames,
  "container-author": CslNames,
  "collection-editor": CslNames,
  "editorial-director": CslNames,
  director: CslNames,
  composer: CslNames,
  illustrator: CslNames,
  interviewer: CslNames,
  recipient: CslNames,
  "reviewed-author": CslNames,
  issued: Schema.optionalKey(CslDate),
  accessed: Schema.optionalKey(CslDate),
  "original-date": Schema.optionalKey(CslDate),
  "event-date": Schema.optionalKey(CslDate),
  abstract: CslString,
  "container-title": CslString,
  "container-title-short": CslString,
  "collection-title": CslString,
  "collection-number": CslString,
  "event-title": CslString,
  "event-place": CslString,
  publisher: CslString,
  "publisher-place": CslString,
  volume: CslString,
  "number-of-volumes": CslString,
  issue: CslString,
  number: CslString,
  "chapter-number": CslString,
  page: CslString,
  "page-first": CslString,
  "number-of-pages": CslString,
  edition: CslString,
  version: CslString,
  medium: CslString,
  genre: CslString,
  status: CslString,
  language: CslString,
  note: CslString,
  URL: CslString,
  DOI: CslString,
  ISBN: CslString,
  ISSN: CslString,
  PMID: CslString,
  PMCID: CslString,
});
export type CslItem = typeof CslItem.Type;

export const DocumentCitation = Schema.Union([
  /** "Cite selected text" from a project file: a quotation plus the file it came from. */
  Schema.TaggedStruct("file-excerpt", {
    id: TrimmedNonEmptyString,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    startLine: PositiveInt,
    endLine: PositiveInt,
    /** The quote came from an unsaved editor draft. */
    unsaved: Schema.Boolean,
    text: Schema.String,
    comment: Schema.NullOr(Schema.String),
  }),
  /** A quote of an earlier assistant message. */
  Schema.TaggedStruct("message-excerpt", {
    id: TrimmedNonEmptyString,
    text: Schema.String,
    comment: Schema.NullOr(Schema.String),
  }),
  /**
   * A bibliographic citation, kept as a key and a CSL-JSON reference so a
   * converter can format it; `reference` is null when only the key is known.
   */
  Schema.TaggedStruct("bibliographic", {
    id: TrimmedNonEmptyString,
    key: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
    reference: Schema.NullOr(CslItem),
  }),
]);
export type DocumentCitation = typeof DocumentCitation.Type;

export const DocumentWarningCode = Schema.Literals([
  "running-turn-omitted",
  /** The export includes work log or reasoning, which can hold paths, output, and secrets. */
  "sensitive-content-included",
  "attachment-unavailable",
  "attachment-unsupported",
  "records-skipped",
  "source-history-incomplete",
  "context-reference-unresolved",
  "unsupported-construct",
  "resource-unresolved",
  "converter-reported",
]);
export type DocumentWarningCode = typeof DocumentWarningCode.Type;

/** One human-readable line, shown in the export dialog and written into the output. */
export const DocumentWarning = Schema.Struct({
  code: DocumentWarningCode,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type DocumentWarning = typeof DocumentWarning.Type;

export const DocumentBundle = Schema.Struct({
  /** Scient-dialect Markdown; asset destinations use `DOCUMENT_ASSET_URL_PREFIX`. */
  markdown: Schema.String,
  profile: DocumentMarkdownProfile,
  metadata: Schema.Struct({
    title: TrimmedNonEmptyString,
    language: Schema.NullOr(TrimmedNonEmptyString),
    direction: DocumentDirection,
    createdAt: Schema.NullOr(IsoDateTime),
    source: DocumentSourceRef,
  }),
  assets: Schema.Array(DocumentAsset),
  citations: Schema.Array(DocumentCitation),
  warnings: Schema.Array(DocumentWarning),
});
export type DocumentBundle = typeof DocumentBundle.Type;

// ---------------------------------------------------------------------------
// Export options, format capabilities, and the HTTP contract
// ---------------------------------------------------------------------------

export const ConversationExportFormat = Schema.Literals(["markdown", "pdf", "docx", "scic"]);
export type ConversationExportFormat = typeof ConversationExportFormat.Type;

export const ConversationExportRange = Schema.Union([
  Schema.TaggedStruct("whole", {}),
  Schema.TaggedStruct("through-message", { messageId: MessageId }),
]);
export type ConversationExportRange = typeof ConversationExportRange.Type;

/** `text`: one `.md`, attachments listed by name. `with-attachments`: a `.zip` with `attachments/`. */
export const ConversationMarkdownPackaging = Schema.Literals(["text", "with-attachments"]);
export type ConversationMarkdownPackaging = typeof ConversationMarkdownPackaging.Type;

/** Work log and reasoning default to off on every format and are chosen again for each export. */
export const ConversationExportOptions = Schema.Struct({
  includeWorkLog: Schema.Boolean,
  includeReasoning: Schema.Boolean,
  range: ConversationExportRange,
  markdownPackaging: Schema.optionalKey(ConversationMarkdownPackaging),
});
export type ConversationExportOptions = typeof ConversationExportOptions.Type;

/** Whether this host can produce a format now, and why not when it cannot. */
export const ConversationExportFormatCapability = Schema.Struct({
  format: ConversationExportFormat,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ConversationExportFormatCapability = typeof ConversationExportFormatCapability.Type;

export const SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS = 160;
/** Clipboard delivery returns the text inline; larger conversations must be saved as a file. */
export const SCIENT_CONVERSATION_EXPORT_CLIPBOARD_MAX_CHARS = 8 * 1024 * 1024;
/** Attachment bytes one packaged export may carry. */
export const SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES = 512 * 1024 * 1024;

export const ScientConversationExportPrepareRequest = Schema.Struct({
  threadId: ThreadId,
});
export type ScientConversationExportPrepareRequest =
  typeof ScientConversationExportPrepareRequest.Type;

/** A message the dialog offers as the end of an "up to selected message" range. */
export const ScientConversationExportMessageChoice = Schema.Struct({
  messageId: MessageId,
  n: PositiveInt,
  role: ConversationMessageRole,
  createdAt: IsoDateTime,
  excerpt: ShortText(SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS),
});
export type ScientConversationExportMessageChoice =
  typeof ScientConversationExportMessageChoice.Type;

/** Everything the export dialog needs before the user chooses; carries no exported content. */
export const ScientConversationExportPreparation = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  formats: Schema.Array(ConversationExportFormatCapability),
  messageCount: NonNegativeInt,
  attachmentCount: NonNegativeInt,
  workLogEntryCount: NonNegativeInt,
  reasoningCount: NonNegativeInt,
  runningTurnOmitted: Schema.Boolean,
  messages: Schema.Array(ScientConversationExportMessageChoice),
});
export type ScientConversationExportPreparation = typeof ScientConversationExportPreparation.Type;

/** `file` writes a temporary export read through a signed asset; `clipboard` returns text inline. */
export const ScientConversationExportDelivery = Schema.Literals(["file", "clipboard"]);
export type ScientConversationExportDelivery = typeof ScientConversationExportDelivery.Type;

export const ScientConversationExportRequest = Schema.Struct({
  threadId: ThreadId,
  format: ConversationExportFormat,
  options: ConversationExportOptions,
  delivery: ScientConversationExportDelivery,
  /** IANA time zone for human-readable times in the output; UTC when absent or unknown. */
  timeZone: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type ScientConversationExportRequest = typeof ScientConversationExportRequest.Type;

export const ScientConversationExportFile = Schema.Struct({
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mediaType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  byteLength: NonNegativeInt,
  /** Signed asset path, resolved against the environment's HTTP base URL. */
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(32_768)),
  expiresAt: Schema.Number,
});
export type ScientConversationExportFile = typeof ScientConversationExportFile.Type;

export const ScientConversationExportResult = Schema.Struct({
  exportId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  format: ConversationExportFormat,
  contentDigest: Sha256Digest,
  messageCount: NonNegativeInt,
  file: Schema.NullOr(ScientConversationExportFile),
  text: Schema.NullOr(Schema.String),
  warnings: Schema.Array(DocumentWarning),
});
export type ScientConversationExportResult = typeof ScientConversationExportResult.Type;

export const ScientConversationExportErrorReason = Schema.Literals([
  "thread-not-found",
  "format-unavailable",
  "message-not-found",
  "nothing-to-export",
  "too-large",
  "delivery-unsupported",
  /** A converter (Pandoc, for Word) failed after the export was prepared. */
  "conversion-failed",
]);
export type ScientConversationExportErrorReason = typeof ScientConversationExportErrorReason.Type;

export class ScientConversationExportError extends Schema.TaggedError<ScientConversationExportError>()(
  "ScientConversationExportError",
  {
    reason: ScientConversationExportErrorReason,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientConversationExportError)(this, { status: 409 });
  }
}
