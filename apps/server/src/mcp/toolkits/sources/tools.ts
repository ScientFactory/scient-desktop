import {
  ScientSourceCreator,
  ScientSourceExternalReference,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
  ScientSourceNote,
  ScientSourceType,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

const ScientSourceAgentAttachment = Schema.Struct({
  attachmentId: NonEmptyString,
  kind: Schema.Literal("pdf"),
  fileName: NonEmptyString,
  mediaType: Schema.Literal("application/pdf"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  importedAt: NonEmptyString,
});

export class ScientSourcesToolError extends Schema.TaggedErrorClass<ScientSourcesToolError>()(
  "ScientSourcesToolError",
  {
    code: Schema.Literals([
      "capability-unavailable",
      "project-required",
      "project-changed",
      "not-found",
      "operation-failed",
    ]),
    message: NonEmptyString,
  },
) {}

export const ScientSourceAgentSummary = Schema.Struct({
  sourceId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  type: ScientSourceType,
  title: NullableText,
  creator: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  containerTitle: NullableText,
  doi: NullableText,
  hasPdf: Schema.Boolean,
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
  importedAt: NonEmptyString,
  updatedAt: Schema.optionalKey(NonEmptyString),
});

export const ScientSourcesListTool = Tool.make("scient_sources_list", {
  description:
    "List a bounded page of canonical Sources from this thread's Scient project. Use this before source-dependent work; do not scan or edit .scient/sources files directly.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
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
  .annotate(Tool.OpenWorld, false);

export const ScientSourceGetTool = Tool.make("scient_sources_get", {
  description:
    "Read one canonical Source from this thread's Scient project by source ID. Returns metadata, provenance, and attachment identity but never an absolute filesystem path.",
  parameters: Schema.Struct({ sourceId: NonEmptyString }),
  success: ScientSourceAgentDetail,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a project source")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ScientSourceNoteUpdateResult = Schema.Struct({
  outcome: Schema.Literals(["updated", "unchanged", "stale"]),
  sourceId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  note: ScientSourceNote,
});

export const ScientSourceNoteUpdateTool = Tool.make("scient_sources_note_update", {
  description:
    "Add, replace, or clear the project-owned note for one canonical Source. Read the source first and pass its current revision. Use null to clear the note; bold and italic may use Markdown markers.",
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
  .annotate(Tool.OpenWorld, false);

export const ScientSourcesToolkit = Toolkit.make(
  ScientSourcesListTool,
  ScientSourceGetTool,
  ScientSourceNoteUpdateTool,
);
