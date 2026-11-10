import {
  ScientSourceCreator,
  ScientSourceExternalReference,
  ScientSourceEditableMetadata,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
  ScientSourceAbstractSection,
  ScientSourceMetadataValidationIssue,
  ScientSourceNote,
  ScientSourceActor,
  ScientSourceAttachmentRetrieval,
  ScientSourceOrigin,
  ScientSourceRevisionSummary,
  ScientSourceType,
  ScientSourceVerification,
  ScientSourcesBulkChange,
  ScientSourcesBulkResult,
  ScientSourcesOrganizeAction,
  ScientSourcesOrganizeResult,
  ScientSourceFilter,
} from "@scientfactory/scient-sources";
import {
  isTrimmedUnadvertised,
  ScientManagedBibliographyFileName,
  ScientManagedBibliographyStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { ScientOperation, type OperationDefinition } from "../../ScientOperationTool.ts";

import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";

const NonEmptyString = Schema.String.check(isTrimmedUnadvertised(), Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);
const dependencies = [AgentInvocationContext.AgentInvocationContext, WorkspaceBindingResolver];
const AllowPossibleMetadataMatch = Schema.Boolean.annotate({
  description:
    "Set true only after deciding that a reported possible metadata match is a different source. It cannot override an exact duplicate.",
});

const ScientSourceAgentAttachment = Schema.Struct({
  attachmentId: NonEmptyString,
  kind: Schema.Literal("pdf"),
  fileName: NonEmptyString,
  mediaType: Schema.Literal("application/pdf"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  importedAt: NonEmptyString,
  retrieval: Schema.optionalKey(ScientSourceAttachmentRetrieval),
});

export class ScientSourcesToolError extends Schema.TaggedError<ScientSourcesToolError>()(
  "ScientSourcesToolError",
  {
    code: Schema.Literals(["project-required", "project-changed", "not-found", "operation-failed"]),
    message: NonEmptyString,
  },
) {}

const sourceOperation = (id: string, write: boolean): OperationDefinition => ({
  id,
  scope: "workspace",
  requiredCapabilities: write ? ["sources:read", "sources:write"] : ["sources:read"],
});

const CitationKey = NonEmptyString.annotate({
  description: "The key documents cite this source by: [@key] in Markdown, \\cite{key} in LaTeX.",
});

export const ScientSourceAgentSummary = Schema.Struct({
  sourceId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  citationKey: Schema.optionalKey(CitationKey),
  type: ScientSourceType,
  title: NullableText,
  creator: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  containerTitle: NullableText,
  doi: NullableText,
  hasPdf: Schema.Boolean,
  addedBy: Schema.Literals(["user", "agent"]),
  verification: Schema.optionalKey(ScientSourceVerification.fields.state),
  removedAt: Schema.optionalKey(NonEmptyString),
  removedBy: Schema.optionalKey(ScientSourceActor),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ScientSourcesListResult = Schema.Struct({
  records: Schema.Array(ScientSourceAgentSummary).pipe(Schema.check(Schema.isMaxLength(50))),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const ScientSourceAgentDetail = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceId: NonEmptyString,
  projectId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  citationKey: Schema.optionalKey(CitationKey),
  type: ScientSourceType,
  customType: Schema.optionalKey(NullableText),
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  issuedRaw: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier),
  abstract: NullableText,
  abstractTruncated: Schema.Boolean,
  note: ScientSourceNote,
  containerTitle: NullableText,
  publisher: NullableText,
  volume: NullableText,
  issue: NullableText,
  pages: NullableText,
  language: NullableText,
  url: NullableText,
  tags: Schema.Array(Schema.String),
  externalReferences: Schema.Array(ScientSourceExternalReference),
  attachments: Schema.Array(ScientSourceAgentAttachment),
  fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  origin: Schema.optionalKey(ScientSourceOrigin),
  verification: Schema.optionalKey(ScientSourceVerification),
  importedAt: NonEmptyString,
  updatedAt: Schema.optionalKey(NonEmptyString),
  updatedBy: Schema.optionalKey(ScientSourceActor),
  revisions: Schema.Array(ScientSourceRevisionSummary),
});

const ScientSourcesListTool = Tool.make("scient_sources_list", {
  description:
    "List a page of this project's Sources. Use this before source-dependent work; do not scan or edit .scient/sources files directly. " +
    "query matches citation key, title, authors, year, journal, identifiers and tags. Narrow with tags (all must match), collectionId, type or hasPdf, " +
    "or run a saved search with savedSearchId (other filters then narrow it further); scient_sources_collections lists collections, saved searches and tags. " +
    "inTrash lists removed sources instead, newest removal first; restore one with scient_sources_restore.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
    tags: Schema.optionalKey(ScientSourceFilter.fields.tags),
    collectionId: Schema.optionalKey(NonEmptyString),
    type: Schema.optionalKey(ScientSourceType),
    hasPdf: Schema.optionalKey(Schema.Boolean),
    savedSearchId: Schema.optionalKey(NonEmptyString),
    inTrash: Schema.optionalKey(Schema.Boolean),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: ScientSourcesListResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "List project sources")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.list", false));

const ScientSourceGetTool = Tool.make("scient_sources_get", {
  description:
    "Read one of this project's Sources by source ID: its metadata, revision, provenance, attachments and kept revisions (newest first, with who saved each and which fields it changed). An abstract over 50,000 characters is cut, and abstractTruncated says so.",
  parameters: Schema.Struct({ sourceId: NonEmptyString }),
  success: ScientSourceAgentDetail,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a project source")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.get", false));

export const ScientSourceNoteUpdateResult = Schema.Struct({
  outcome: Schema.Literals(["updated", "unchanged", "stale"]),
  sourceId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  note: ScientSourceNote,
});

const ScientSourceNoteUpdateTool = Tool.make("scient_sources_note_update", {
  description:
    "Add, replace or clear (null) the project note on one Source. Read the source first and pass its current revision. If stale, read it again and redo the change on what you read. Bold and italic may use Markdown markers.",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
    note: ScientSourceNote,
  }),
  success: ScientSourceNoteUpdateResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update a source note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.note.update", true));

const ScientSourceMetadataUpdateTool = Tool.make("scient_sources_update", {
  description:
    "Replace one Source's metadata and tags after the user explicitly asks. metadata is the complete new record, not a patch: " +
    "read the source first, keep every field you are not changing, and pass its current revision. " +
    "If the read says abstractTruncated, do not replace from it; tell the user. If stale, read it again and redo the change on what you read. " +
    "Changed fields are recorded as set by the agent; attachments stay as they are. Changing identifiers clears the source's identifier check.",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
    metadata: ScientSourceEditableMetadata,
    allowPossibleMetadataMatch: Schema.optionalKey(AllowPossibleMetadataMatch),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["updated", "unchanged", "stale", "duplicate"]),
    sourceId: NonEmptyString,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    duplicate: Schema.Struct({
      kind: Schema.Literals([
        "same-origin",
        "same-identifier",
        "same-pdf",
        "possible-metadata-match",
        "new",
      ]),
      matchingSourceIds: Schema.Array(NonEmptyString),
      reason: NonEmptyString,
    }),
    validationIssues: Schema.Array(ScientSourceMetadataValidationIssue),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update source metadata")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.update", true));

const ScientSourceRemoveTool = Tool.make("scient_sources_remove", {
  description:
    "Remove one Source from this project after the user explicitly asks. It moves to the project trash with its PDFs (restorable: scient_sources_restore). " +
    "Read the source first and pass its current revision. If stale, read it again and redo the change on what you read. " +
    "permanent deletes a source that is already in the trash, with its saved revisions and any PDF nothing else uses; only when the user asks for that, since it cannot be undone. " +
    "Pass the revision shown by scient_sources_list with inTrash.",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
    permanent: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["removed", "not-found", "stale", "deleted"]),
    sourceId: NonEmptyString,
    revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    restorable: Schema.optionalKey(Schema.Boolean),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Remove a project source")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.remove", true));

const ScientSourceRestoreTool = Tool.make("scient_sources_restore", {
  description:
    "Put a removed Source back from the project trash, with its PDFs, as a new revision credited to you. " +
    "exists means a source with this ID is already in the Library; duplicate means another source now has its identifier (see matchingSourceIds).",
  parameters: Schema.Struct({ sourceId: NonEmptyString }),
  success: Schema.Struct({
    outcome: Schema.Literals(["restored", "not-found", "exists", "duplicate"]),
    sourceId: NonEmptyString,
    revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    matchingSourceIds: Schema.Array(NonEmptyString),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Restore a removed source")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.restore", true));

const ScientSourceRevertTool = Tool.make("scient_sources_revert", {
  description:
    "Make an earlier revision of a Source current again, as a new revision credited to you. Read the source first: pass its current revision as expectedRevision " +
    "and a kept revision from its revisions list as toRevision. Metadata, note, tags, identifiers and attachments return to that revision; " +
    "missingAttachmentCount counts PDFs whose files were deleted when the trash was emptied. If stale, read it again.",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
    toRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["reverted", "unchanged", "stale", "not-found", "duplicate"]),
    sourceId: NonEmptyString,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    missingAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    matchingSourceIds: Schema.Array(NonEmptyString),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Revert a source to an earlier revision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.revert", true));

export const ScientSourceAddInput = Schema.Struct({
  type: Schema.optionalKey(ScientSourceType),
  customType: Schema.optionalKey(NullableText),
  title: Schema.optionalKey(NullableText),
  creators: Schema.optionalKey(
    Schema.Array(ScientSourceCreator).pipe(Schema.check(Schema.isMaxLength(256))),
  ),
  issuedRaw: Schema.optionalKey(NullableText),
  issuedYear: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  identifiers: Schema.optionalKey(
    Schema.Array(ScientSourceIdentifier).pipe(Schema.check(Schema.isMaxLength(256))),
  ),
  abstract: Schema.optionalKey(NullableText),
  abstractSections: Schema.optionalKey(
    Schema.Array(ScientSourceAbstractSection).pipe(Schema.check(Schema.isMaxLength(256))),
  ),
  containerTitle: Schema.optionalKey(NullableText),
  publisher: Schema.optionalKey(NullableText),
  volume: Schema.optionalKey(NullableText),
  issue: Schema.optionalKey(NullableText),
  pages: Schema.optionalKey(NullableText),
  language: Schema.optionalKey(NullableText),
  url: Schema.optionalKey(NullableText),
  tags: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(1_000))),
  ),
  pdfRelativePath: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096)))),
  enrich: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Fill a missing abstract by looking up the source's DOI or PMID.",
    }),
  ),
  allowPossibleMetadataMatch: Schema.optionalKey(AllowPossibleMetadataMatch),
});
export type ScientSourceAddInput = typeof ScientSourceAddInput.Type;

export const ScientSourceAddResult = Schema.Struct({
  outcome: Schema.Literals([
    "imported",
    "duplicate",
    "invalid",
    "identifier-not-found",
    "identifier-mismatch",
  ]),
  sourceId: Schema.NullOr(NonEmptyString),
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  duplicate: Schema.Struct({
    kind: Schema.Literals([
      "same-origin",
      "same-identifier",
      "same-pdf",
      "possible-metadata-match",
      "new",
    ]),
    matchingSourceIds: Schema.Array(NonEmptyString),
    reason: NonEmptyString,
  }),
  validationIssues: Schema.Array(ScientSourceMetadataValidationIssue),
  verification: Schema.optionalKey(ScientSourceVerification.fields.state),
  resolved: Schema.optionalKey(
    Schema.Struct({
      title: NullableText,
      creators: Schema.Array(Schema.String),
      issuedYear: Schema.NullOr(Schema.Int),
      containerTitle: NullableText,
    }),
  ),
  message: Schema.optionalKey(NonEmptyString),
});

const ScientSourceAddTool = Tool.make("scient_sources_add", {
  description:
    "Add one source to this project after the user explicitly asks. List existing Sources first. " +
    "For a PDF in the project, pass its relative path as pdfRelativePath; Scient reads metadata from it, " +
    "so citation fields are optional. A DOI or PMID is checked against doi.org or PubMed first: " +
    "identifier-not-found means the identifier does not exist and identifier-mismatch means it names a different work (see resolved); nothing is added in either case. " +
    "A found identifier's registry metadata replaces the citation fields you gave (verification verified). " +
    "If the registry cannot be reached the source is added as given (unchecked); without a DOI or PMID it is unverified. " +
    "The user sees that you added it. Repeating the same request adds nothing.",
  parameters: ScientSourceAddInput,
  success: ScientSourceAddResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add a project source")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.add", true));

const ScientSourceAttachPdfTool = Tool.make("scient_sources_attach_pdf", {
  description:
    "Attach a project-relative PDF to a Source after the user explicitly asks. Read the source first " +
    "and pass its current revision. If stale, read it again and redo the change on what you read.",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
    pdfRelativePath: Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096))),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["attached", "unchanged", "stale"]),
    sourceId: NonEmptyString,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Attach a source PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.pdf.attach", true));

const ScientSourceDetachPdfTool = Tool.make("scient_sources_detach_pdf", {
  description:
    "Remove one PDF attachment from a Source, keeping its metadata, after the user explicitly asks. " +
    "Read the source first and pass its current revision. If stale, read it again and redo the change on what you read. " +
    "The file stays in the project until the trash is emptied, so scient_sources_revert can bring it back.",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    attachmentId: NonEmptyString,
    expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["removed", "unchanged", "stale", "not-found"]),
    sourceId: NonEmptyString,
    attachmentId: NonEmptyString,
    revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Detach a source PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.pdf.detach", true));

const ScientSourcesBibliographyTool = Tool.make("scient_sources_bibliography", {
  description:
    "Write this project's references.bib and references.json from the Library and report their state. " +
    "Documents cite sources by citationKey from these files (Markdown front matter `bibliography: references.bib`, LaTeX `\\bibliography{references}`). " +
    "A file edited by hand is kept and reported as edited, with the keys added, changed or removed; " +
    "unmanaged means a file Scient did not write is in the way, and Scient never writes over it. " +
    "Pass replaceEdited only when the user wants the Library version back.",
  parameters: Schema.Struct({
    replaceEdited: Schema.optionalKey(Schema.Array(ScientManagedBibliographyFileName)),
  }),
  success: ScientManagedBibliographyStatus,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Write the project bibliography")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.bibliography", true));

const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const TextOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SourceTextRange = Schema.Struct({ page: PageNumber, start: TextOffset, end: TextOffset });

export const ScientSourcesFullTextStatus = Schema.Struct({
  pdfs: TextOffset,
  searchable: TextOffset,
  pending: TextOffset,
  withoutText: TextOffset,
  unreadable: TextOffset,
});

const ScientSourcesSearchTool = Tool.make("scient_sources_search", {
  description:
    "Search the full text of this project's Source PDFs. Returns ranked passages with source, PDF and page; " +
    'quote a "phrase" to require it. If status.pending is above zero, text is still being read; search again shortly. ' +
    "Read around a hit with scient_sources_read_text, and check a quote with scient_sources_quote_check before giving it.",
  parameters: Schema.Struct({
    query: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
    sourceIds: Schema.optionalKey(
      Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(100))),
    ),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  }),
  success: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({
        sourceId: NonEmptyString,
        attachmentId: NonEmptyString,
        title: NullableText,
        page: PageNumber,
        start: TextOffset,
        end: TextOffset,
        passage: Schema.String,
        matchedTerms: Schema.Array(Schema.String),
      }),
    ),
    status: ScientSourcesFullTextStatus,
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search source full text")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.search", false));

const ScientSourceReadTextTool = Tool.make("scient_sources_read_text", {
  description:
    "Read the text of one Source's PDF, page by page, from fromPage. Continue at nextPage until it is null. " +
    "choose-pdf lists the PDFs when a source has several; pass one as attachmentId. no-text means the PDF has no text layer (often a scan).",
  parameters: Schema.Struct({
    sourceId: NonEmptyString,
    attachmentId: Schema.optionalKey(NonEmptyString),
    fromPage: Schema.optionalKey(PageNumber),
    maxCharacters: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60_000 })),
    ),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals([
      "read",
      "no-text",
      "unreadable",
      "no-pdf",
      "source-not-found",
      "choose-pdf",
    ]),
    attachmentId: Schema.optionalKey(NonEmptyString),
    pageCount: Schema.optionalKey(TextOffset),
    complete: Schema.optionalKey(Schema.Boolean),
    pages: Schema.optionalKey(
      Schema.Array(Schema.Struct({ page: PageNumber, text: Schema.String })),
    ),
    nextPage: Schema.optionalKey(Schema.NullOr(PageNumber)),
    attachments: Schema.optionalKey(
      Schema.Array(Schema.Struct({ attachmentId: NonEmptyString, fileName: NonEmptyString })),
    ),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read source text")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.text.read", false));

const ScientSourceQuoteCheckTool = Tool.make("scient_sources_quote_check", {
  description:
    "Check quotes against the stored text of this project's Source PDFs before you give them. " +
    "exact matched character for character; normalized matched once spacing, ligatures, quote marks, dashes and line-break hyphens are evened out; " +
    "both return the stored text and its page location, so quote that text. ambiguous means the quote appears more than once; lengthen it. " +
    "not-found returns the closest passages. Without sourceId the whole Library is checked.",
  parameters: Schema.Struct({
    quotes: Schema.Array(
      Schema.Struct({
        quote: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4_000))),
        sourceId: Schema.optionalKey(NonEmptyString),
      }),
    ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(25))),
  }),
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        outcome: Schema.Literals([
          "exact",
          "normalized",
          "ambiguous",
          "not-found",
          "not-indexed",
          "no-text",
          "source-not-found",
        ]),
        sourceId: Schema.optionalKey(NonEmptyString),
        attachmentId: Schema.optionalKey(NonEmptyString),
        ranges: Schema.optionalKey(Schema.Array(SourceTextRange)),
        text: Schema.optionalKey(Schema.String),
        prefix: Schema.optionalKey(Schema.String),
        suffix: Schema.optionalKey(Schema.String),
        sourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
        closest: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({ sourceId: NonEmptyString, page: PageNumber, passage: Schema.String }),
          ),
        ),
        pending: Schema.optionalKey(TextOffset),
      }),
    ),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check quotes against sources")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.quote.check", false));

export const ScientSourcesCollectionsResult = Schema.Struct({
  collections: Schema.Array(
    Schema.Struct({ collectionId: NonEmptyString, name: NonEmptyString, sourceCount: Schema.Int }),
  ),
  savedSearches: Schema.Array(
    Schema.Struct({ searchId: NonEmptyString, name: NonEmptyString, filter: ScientSourceFilter }),
  ),
  tags: Schema.Array(Schema.Struct({ tag: Schema.String, count: Schema.Int })).pipe(
    Schema.check(Schema.isMaxLength(200)),
  ),
  message: Schema.optionalKey(Schema.String),
});

const ScientSourcesCollectionsTool = Tool.make("scient_sources_collections", {
  description:
    "Read how this project's Sources are organized: collections with their source counts, saved searches with their filters, and the most used tags. " +
    "List a collection's sources with scient_sources_list collectionId.",
  parameters: Tool.EmptyParams,
  success: ScientSourcesCollectionsResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read source collections")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.collections", false));

const ScientSourcesOrganizeTool = Tool.make("scient_sources_organize", {
  description:
    "Change collections or saved searches after the user asks. A source can be in several collections; collections never change source records. " +
    "create-collection with an existing name returns that collection (existing) and adds the given sources. " +
    "delete-collection keeps its sources and can be undone with restore-collection. save-search with an existing name replaces its filter. " +
    "unknownSourceIds lists ids that are not in the Library and were not added.",
  parameters: Schema.Struct({ change: ScientSourcesOrganizeAction }),
  success: ScientSourcesOrganizeResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Organize sources")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.organize", true));

const ScientSourcesBulkUpdateTool = Tool.make("scient_sources_bulk_update", {
  description:
    "Apply one change to up to 500 Sources after the user asks: add or remove tags (case-insensitive, existing spelling kept), set the type " +
    "(customType is required for other), and add to or remove from collections. Tag and type changes make a new revision per source, recorded as set by the agent " +
    "and undoable with scient_sources_revert. Each source is reported (updated, unchanged, not-found, failed with a message); one failure does not stop the rest. " +
    "To remove many sources, call scient_sources_remove for each.",
  parameters: Schema.Struct({ change: ScientSourcesBulkChange }),
  success: ScientSourcesBulkResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Edit many sources")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.bulk_update", true));

export const ScientSourcesToolkit = Toolkit.make(
  ScientSourcesListTool,
  ScientSourceGetTool,
  ScientSourceNoteUpdateTool,
  ScientSourceMetadataUpdateTool,
  ScientSourceRemoveTool,
  ScientSourceRestoreTool,
  ScientSourceRevertTool,
  ScientSourceAddTool,
  ScientSourceAttachPdfTool,
  ScientSourceDetachPdfTool,
  ScientSourcesBibliographyTool,
  ScientSourcesSearchTool,
  ScientSourceReadTextTool,
  ScientSourceQuoteCheckTool,
  ScientSourcesCollectionsTool,
  ScientSourcesOrganizeTool,
  ScientSourcesBulkUpdateTool,
);
