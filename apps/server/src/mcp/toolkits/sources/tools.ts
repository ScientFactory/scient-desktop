import {
  MAX_SOURCE_IDENTIFIER_BATCH,
  ScientSourceIdentifierAddItem,
  ScientSourceCreator,
  ScientSourceEditorialStatus,
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
  ScientSourceZoteroRefreshField,
  ScientSourceZoteroRefreshItem,
  ScientSourceZoteroSendResult,
  ZoteroConnection,
  ZoteroConnectionState,
  ScientSourcesBulkRequestChange,
  ScientSourcesBulkResult,
  ScientSourcesOrganizeAction,
  ScientSourcesOrganizeResult,
  ScientSourceFilter,
  ScientReferenceFindingKind,
  ScientReferenceStatus,
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
    "True only after deciding a reported possible metadata match is a different source; never overrides an exact duplicate.",
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
  /** Present only when the registry reported a retraction, withdrawal, concern or correction. */
  editorialStatus: Schema.optionalKey(ScientSourceEditorialStatus.fields.state),
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
  editorialStatus: Schema.optionalKey(ScientSourceEditorialStatus),
  importedAt: NonEmptyString,
  updatedAt: Schema.optionalKey(NonEmptyString),
  updatedBy: Schema.optionalKey(ScientSourceActor),
  revisions: Schema.Array(ScientSourceRevisionSummary),
});

const ScientSourcesListTool = Tool.make("scient_sources_list", {
  description:
    "List a page of this project's Library (Sources); total is its size. Use it before literature or citation work and web search; never edit .scient/sources directly. query matches citation key, title, authors, year, journal, identifiers and tags. Filters: tags (all must match), collectionId, type, hasPdf, savedSearchId (see scient_sources_collections). inTrash lists removed sources.",
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
    "Read one Source: metadata, revision, provenance, attachments and kept revisions (newest first, with who saved each and what changed). Abstracts over 50,000 characters are cut (abstractTruncated).",
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
    "Add, replace or clear (null) one Source's project note. Pass its current revision; if stale, re-read and redo. Markdown bold and italic work.",
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
    "Replace one Source's metadata and tags after the user explicitly asks. metadata is the full record, not a patch: keep the fields you are not changing. Pass its current revision; if stale, re-read and redo. Never replace from a read with abstractTruncated; tell the user. Credited to the agent; attachments are kept; changed identifiers clear the identifier check. A new citationKey is renamed in project documents (citationKeyRenamedIn); tell the user about citationKeyRenameSkipped files.",
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
    citationKeyRenamedIn: Schema.optionalKey(Schema.Array(NonEmptyString)),
    citationKeyRenameSkipped: Schema.optionalKey(
      Schema.Array(Schema.Struct({ path: NonEmptyString, reason: NonEmptyString })),
    ),
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
    "Move one Source and its PDFs to the trash after the user explicitly asks (scient_sources_restore undoes it). Pass its current revision; if stale, re-read and redo. permanent deletes a trashed source with its revisions and unused PDFs, irreversibly: only when the user asks for that (revision from scient_sources_list inTrash).",
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
    "Put a removed Source back from the trash, with its PDFs, as a new revision credited to you. exists: the ID is already in the Library; duplicate: another source has its identifier (matchingSourceIds).",
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
    "Make a kept earlier revision of a Source (toRevision) current again, as a new revision credited to you; expectedRevision is its current revision (if stale, re-read). Metadata, note, tags, identifiers and attachments return; missingAttachmentCount counts PDFs deleted with the trash.",
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

const ScientSourceCheckTool = Tool.make("scient_sources_check", {
  description:
    "Recheck one Source's DOI or PMID at its registry, for example before citing. Records the result (credited to you, when changed); never changes metadata. registry: found, not-found, mismatch (now names another title), unavailable (earlier result kept) or none. editorialStatus reports retractions, withdrawals, concerns and corrections.",
  parameters: Schema.Struct({ sourceId: NonEmptyString }),
  success: Schema.Struct({
    outcome: Schema.Literals(["updated", "unchanged", "stale"]),
    sourceId: NonEmptyString,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    registry: Schema.Literals(["found", "not-found", "mismatch", "unavailable", "none"]),
    verification: Schema.optionalKey(ScientSourceVerification),
    editorialStatus: Schema.optionalKey(ScientSourceEditorialStatus),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check a source's identifier")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.check", true));

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
      description: "Fill a missing abstract from the DOI or PMID.",
    }),
  ),
  allowPossibleMetadataMatch: Schema.optionalKey(AllowPossibleMetadataMatch),
  identifierList: Schema.optionalKey(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000))))
      .pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SOURCE_IDENTIFIER_BATCH)))
      .annotate({
        description:
          "One DOI, PMID, arXiv ID or ISBN per entry (bare, prefixed or a link); give no citation fields or PDF with it.",
      }),
  ),
});
export type ScientSourceAddInput = typeof ScientSourceAddInput.Type;

export const ScientSourceAddResult = Schema.Struct({
  outcome: Schema.Literals([
    "imported",
    "duplicate",
    "invalid",
    "identifier-not-found",
    "identifier-mismatch",
    "batch",
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
  editorialStatus: Schema.optionalKey(ScientSourceEditorialStatus.fields.state),
  resolved: Schema.optionalKey(
    Schema.Struct({
      title: NullableText,
      creators: Schema.Array(Schema.String),
      issuedYear: Schema.NullOr(Schema.Int),
      containerTitle: NullableText,
    }),
  ),
  message: Schema.optionalKey(NonEmptyString),
  results: Schema.optionalKey(
    Schema.Array(ScientSourceIdentifierAddItem).annotate({
      description:
        "One per identifierList entry, in order: imported (added, verified), duplicate (already in the Library; sourceId names it), " +
        "identifier-not-found (does not exist; nothing added), unavailable (registry unreachable; nothing added, try again later), or unrecognized (not an identifier).",
    }),
  ),
});

const ScientSourceAddTool = Tool.make("scient_sources_add", {
  description:
    "Add sources to this project's Library after the user explicitly asks; list existing Sources first. Repeats add nothing. Several works by DOI, PMID, arXiv ID or ISBN: identifierList (outcome batch, see results). A project PDF: pdfRelativePath (citation fields optional). From PubMed, Semantic Scholar or OpenAlex pass only the identifier (scheme pmid, s2 for a paperId or CorpusId:N, openalex for a W ID). Identifiers are checked at their registry: identifier-not-found and identifier-mismatch (see resolved) add nothing; found metadata replaces your fields (verified); unreachable adds as given (unchecked); no identifier is unverified. editorialStatus flags retractions and corrections: tell the user.",
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
    "Attach a project PDF to a Source after the user explicitly asks. Pass its current revision; if stale, re-read and redo.",
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
    "Detach one PDF from a Source after the user explicitly asks. Pass its current revision; if stale, re-read and redo. The file stays until the trash is emptied (scient_sources_revert brings it back).",
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
    "Write references.bib and references.json from the Library and report their state; documents cite by citationKey (Markdown `bibliography: references.bib`, LaTeX `\\bibliography{references}`). A hand-edited file is kept (edited, with keys added, changed or removed); an unmanaged file is never overwritten; kept lists earlier text moved aside (tell the user). importEdited imports its new entries; replaceEdited restores the Library version, only when the user wants that.",
  parameters: Schema.Struct({
    replaceEdited: Schema.optionalKey(Schema.Array(ScientManagedBibliographyFileName)),
    importEdited: Schema.optionalKey(Schema.Array(ScientManagedBibliographyFileName)),
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
    'Search the full text of Source PDFs: ranked passages with source, PDF and page; quote a "phrase" to require it. status.pending above zero: text is still being read. Read around a hit with scient_sources_read_text; check quotes with scient_sources_quote_check.',
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
    "Read one Source PDF's text by page from fromPage; continue at nextPage until null. choose-pdf: pass one listed PDF as attachmentId. no-text: no text layer (often a scan).",
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
    "Check quotes against the stored text of Source PDFs before giving them. exact, or normalized (spacing, ligatures, quote marks, dashes, hyphenation evened out), returns the stored text and page: quote that. ambiguous: it occurs more than once; lengthen it. not-found returns the closest passages. No sourceId: the whole Library.",
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

const ZoteroConnectionInput = ZoteroConnection.annotate({
  description:
    "local: Zotero on this computer; web: zotero.org with the Accounts key. Omit for whichever is ready, local first.",
});
const ZoteroItemKey = Schema.String.check(Schema.isPattern(/^[23456789A-Z]{8}$/u));
const ZoteroRefreshFields = Schema.Array(ScientSourceZoteroRefreshField).pipe(
  Schema.check(Schema.isMaxLength(32)),
);

export const ScientSourcesZoteroBrowseResult = Schema.Struct({
  state: ZoteroConnectionState,
  connection: Schema.NullOr(ZoteroConnection),
  canWrite: Schema.Boolean,
  message: NonEmptyString,
  collections: Schema.Array(
    Schema.Struct({ key: NonEmptyString, name: NonEmptyString, parentKey: NullableText }),
  ),
  items: Schema.Array(
    Schema.Struct({
      itemKey: NonEmptyString,
      type: ScientSourceType,
      title: NullableText,
      creator: NullableText,
      issuedYear: Schema.NullOr(Schema.Int),
      doi: NullableText,
      pdfCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      sourceId: NullableText,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(50))),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextStart: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const ScientSourcesZoteroBrowseTool = Tool.make("scient_sources_zotero_browse", {
  description:
    "Browse the user's Zotero library: whether it is reachable, its collections and a page of references (by collection or query). sourceId marks ones already in this Library. If state is not ready, tell the user its message.",
  parameters: Schema.Struct({
    connection: Schema.optionalKey(ZoteroConnectionInput),
    collectionKey: Schema.optionalKey(ZoteroItemKey),
    includeSubcollections: Schema.optionalKey(Schema.Boolean),
    query: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
    start: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: ScientSourcesZoteroBrowseResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Browse the Zotero library")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.zotero.browse", false));

export const ScientSourcesZoteroImportResult = Schema.Struct({
  imported: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  items: Schema.Array(
    Schema.Struct({
      itemKey: NonEmptyString,
      outcome: Schema.Literals(["imported", "skipped", "failed", "pending"]),
      duplicate: Schema.optionalKey(
        Schema.Literals([
          "same-origin",
          "same-identifier",
          "same-pdf",
          "possible-metadata-match",
          "new",
        ]),
      ),
      sourceId: NullableText,
      message: NullableText,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(500))),
});

const ScientSourcesZoteroImportTool = Tool.make("scient_sources_zotero_import", {
  description:
    "Import from the user's Zotero library after the user asks: itemKeys, a collectionKey or all, with notes, tags, PDFs and citation keys. Already imported: skipped (same-origin); possible-metadata-match: skipped unless in possibleMetadataMatchOverrides. At most 500 per call.",
  parameters: Schema.Struct({
    connection: Schema.optionalKey(ZoteroConnectionInput),
    itemKeys: Schema.optionalKey(
      Schema.Array(ZoteroItemKey).pipe(
        Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
      ),
    ),
    collectionKey: Schema.optionalKey(ZoteroItemKey),
    includeSubcollections: Schema.optionalKey(Schema.Boolean),
    all: Schema.optionalKey(Schema.Boolean),
    possibleMetadataMatchOverrides: Schema.optionalKey(
      Schema.Array(ZoteroItemKey).pipe(Schema.check(Schema.isMaxLength(500))),
    ),
  }),
  success: ScientSourcesZoteroImportResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Import from Zotero")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.zotero.import", true));

const ScientSourcesZoteroRefreshTool = Tool.make("scient_sources_zotero_refresh", {
  description:
    "Bring Zotero's changes into Sources imported from it (all, or sourceIds); only changed or problem sources are listed. A field edited on both sides stays local and is reported in conflicts: ask the user, then pass it in useZotero or keepLocal.",
  parameters: Schema.Struct({
    sourceIds: Schema.optionalKey(
      Schema.Array(NonEmptyString).pipe(
        Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
      ),
    ),
    connection: Schema.optionalKey(ZoteroConnectionInput),
    useZotero: Schema.optionalKey(ZoteroRefreshFields),
    keepLocal: Schema.optionalKey(ZoteroRefreshFields),
  }),
  success: Schema.Struct({
    connection: ZoteroConnection,
    unchanged: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    items: Schema.Array(ScientSourceZoteroRefreshItem).pipe(Schema.check(Schema.isMaxLength(500))),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Refresh from Zotero")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.zotero.refresh", true));

const ScientSourcesZoteroSendTool = Tool.make("scient_sources_zotero_send", {
  description:
    "Send Sources to the user's zotero.org library after the user asks, creating (and linking) or updating each item; needs an Accounts Zotero key with write access. Items changed in Zotero since Scient read them are not overwritten (changed-in-zotero): refresh, then send again.",
  parameters: Schema.Struct({
    sourceIds: Schema.Array(NonEmptyString).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
  }),
  success: ScientSourceZoteroSendResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send to Zotero")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.zotero.send", true));
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
    "Read collections (with source counts), saved searches (with filters) and the most used tags.",
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
    "Change collections or saved searches after the user asks. A source can be in several collections; membership never changes source records. create-collection with an existing name reuses it (existing). delete-collection keeps its sources (restore-collection undoes it). save-search with an existing name replaces its filter. unknownSourceIds were not added.",
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
    "Apply one change to up to 500 Sources after the user asks: add or remove tags (case-insensitive), set type (customType required for other), add to or remove from collections. Tag and type changes make a revision per source, credited to the agent; each source reports its outcome; failures do not stop the rest. Undo: change {undoBatchId: undo.batchId}; later edits are kept and listed in conflicts; if some parts fail, repeat it (finished parts are skipped). Removal: scient_sources_remove per source.",
  parameters: Schema.Struct({ change: ScientSourcesBulkRequestChange }),
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

const FileFormat = Schema.Literals(["bibtex", "ris", "csl-json", "endnote-xml"]);
const FileReportEntry = Schema.Struct({
  line: Schema.NullOr(Schema.Int),
  citationKey: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
const FieldLoss = Schema.Struct({
  field: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  entryCount: Schema.Int,
  citationKeys: Schema.Array(Schema.String),
});

export const ScientSourcesImportFileResult = Schema.Struct({
  format: FileFormat,
  entryCount: Schema.Int,
  importedCount: Schema.Int,
  imported: Schema.Array(
    Schema.Struct({ sourceId: NonEmptyString, citationKey: Schema.NullOr(Schema.String) }),
  ).pipe(Schema.check(Schema.isMaxLength(100))),
  alreadyInLibrary: Schema.Int,
  failed: Schema.Array(FileReportEntry),
  remaining: Schema.Int,
  unreadable: Schema.Array(FileReportEntry),
  notKept: Schema.Array(FieldLoss),
  withoutCitationKey: Schema.Int,
  /** PDFs from the file's file, L1/L4 or pdf-urls fields attached to imported sources. */
  pdfsAttached: Schema.Int,
});

const ScientSourcesImportFileTool = Tool.make("scient_sources_import_file", {
  description:
    "Import a project reference file into the Library after the user asks: .bib (BibTeX, BibLaTeX), .ris, CSL-JSON .json or EndNote .xml. Keeps citation keys, identifiers, tags and notes; skips entries already present; identifiers stay unchecked. Up to 500 new entries per call: while remaining is above 0, call again. Tell the user about unreadable entries and notKept fields.",
  parameters: Schema.Struct({
    relativePath: Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096))),
    format: Schema.optionalKey(
      FileFormat.annotate({ description: "Only when the extension does not say." }),
    ),
  }),
  success: ScientSourcesImportFileResult,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Import a reference file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.import.file", true));

const ScientSourcesExportTool = Tool.make("scient_sources_export", {
  description:
    "Write the Library, or sourceIds, to a project file (.bib, .ris, CSL-JSON .json or EndNote .xml) under citation keys. Notes only with includeNotes; an existing file only with overwrite. Tell the user about notKept details.",
  parameters: Schema.Struct({
    relativePath: Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096))),
    format: FileFormat,
    sourceIds: Schema.optionalKey(
      Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(20_000))),
    ),
    includeNotes: Schema.optionalKey(Schema.Boolean),
    overwrite: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["written", "exists"]),
    relativePath: NonEmptyString,
    sourceCount: Schema.Int,
    missingSourceIds: Schema.Array(NonEmptyString),
    notKept: Schema.Array(FieldLoss),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Export the Library to a file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, sourceOperation("sources.export", true));

const ScientSourceSavePageTool = Tool.make("scient_sources_save_page", {
  description:
    "Save a web page to the Library after the user asks, keeping a passage in its note. Pass the page's meta tags (citation_*, dc.*, prism.*, og:*), for example via preview_evaluate. A stated DOI, PMID or arXiv ID is checked and its metadata used when the title agrees; otherwise it is saved as a web page. Saving again adds only the new passage. PDFs: scient_paper_get or scient_sources_add.",
  parameters: Schema.Struct({
    url: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
    title: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(2_000)))),
    passage: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(20_000)))),
    meta: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.pipe(Schema.check(Schema.isMaxLength(200))),
          content: Schema.String.pipe(Schema.check(Schema.isMaxLength(4_000))),
        }),
      ).pipe(Schema.check(Schema.isMaxLength(400))),
    ),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["added", "existing", "not-added"]),
    sourceId: Schema.NullOr(NonEmptyString),
    revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    passageSaved: Schema.Boolean,
    reason: Schema.optionalKey(
      Schema.Literals(["identifier-not-found", "identifier-mismatch", "possible-duplicate"]),
    ),
    message: Schema.optionalKey(Schema.String),
    matchingSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Save a web page to sources")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.page.save", true));

const ScientSourcesCiteTool = Tool.make("scient_sources_cite", {
  description:
    "Get the citation for Library sources (IDs or citation keys): [@a; @b] in Markdown, \\cite{a,b} in LaTeX. Each is checked first (identifier resolves to the same work, no retraction or notice); problems never block, but tell the user. Keys resolve from references.bib, kept current here; the document must name it.",
  parameters: Schema.Struct({
    sources: Schema.Array(NonEmptyString).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    ),
    format: Schema.optionalKey(Schema.Literals(["markdown", "latex"])),
  }),
  success: Schema.Struct({
    citation: Schema.String,
    sources: Schema.Array(
      Schema.Struct({
        sourceId: NonEmptyString,
        citationKey: NonEmptyString,
        title: NullableText,
        status: ScientReferenceStatus,
        problems: Schema.Array(
          Schema.Struct({
            kind: Schema.Union([
              ScientReferenceFindingKind,
              Schema.Literals(["not-checked", "no-identifier"]),
            ]),
            message: NonEmptyString,
          }),
        ),
      }),
    ),
    notFound: Schema.Array(Schema.String),
    bibliography: Schema.Literals(["current", "edited", "unmanaged", "absent"]),
  }),
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Cite Library sources")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, sourceOperation("sources.cite", true));

export const ScientSourcesToolkit = Toolkit.make(
  ScientSourcesListTool,
  ScientSourceGetTool,
  ScientSourceNoteUpdateTool,
  ScientSourceMetadataUpdateTool,
  ScientSourceRemoveTool,
  ScientSourceRestoreTool,
  ScientSourceRevertTool,
  ScientSourceCheckTool,
  ScientSourceAddTool,
  ScientSourceAttachPdfTool,
  ScientSourceDetachPdfTool,
  ScientSourcesBibliographyTool,
  ScientSourcesCiteTool,
  ScientSourcesSearchTool,
  ScientSourceReadTextTool,
  ScientSourceQuoteCheckTool,
  ScientSourceSavePageTool,
  ScientSourcesImportFileTool,
  ScientSourcesExportTool,
  ScientSourcesZoteroBrowseTool,
  ScientSourcesZoteroImportTool,
  ScientSourcesZoteroRefreshTool,
  ScientSourcesZoteroSendTool,
  ScientSourcesCollectionsTool,
  ScientSourcesOrganizeTool,
  ScientSourcesBulkUpdateTool,
);
