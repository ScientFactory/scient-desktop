import {
  isTrimmedUnadvertised,
  ScientAnnotationActor,
  ScientAnnotationNote,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientAnnotations } from "../../../scient/annotations/ScientAnnotations.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ScientOperation, type OperationDefinition } from "../../ScientOperationTool.ts";

const NonEmptyString = Schema.String.check(isTrimmedUnadvertised(), Schema.isNonEmpty());
const Revision = Schema.Int.check(Schema.isGreaterThan(0));
const PageNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const RelativePdfPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const dependencies = [
  AgentInvocationContext.AgentInvocationContext,
  WorkspaceBindingResolver,
  ScientAnnotations,
];

export class ScientAnnotationsToolError extends Schema.TaggedError<ScientAnnotationsToolError>()(
  "ScientAnnotationsToolError",
  {
    code: Schema.Literals([
      "project-required",
      "project-changed",
      "invalid-input",
      "operation-failed",
    ]),
    message: NonEmptyString,
  },
) {}

const annotationOperation = (id: string, write: boolean): OperationDefinition => ({
  id,
  scope: "workspace",
  requiredCapabilities: write ? ["sources:read", "sources:write"] : ["sources:read"],
});

export const ScientAnnotationAgentView = Schema.Struct({
  annotationId: NonEmptyString,
  revision: Revision,
  pages: Schema.Array(PageNumber),
  quote: Schema.String,
  quoteTruncated: Schema.Boolean,
  note: Schema.String,
  highlighted: Schema.Boolean,
  createdBy: ScientAnnotationActor,
  updatedBy: ScientAnnotationActor,
  updatedAt: NonEmptyString,
  removed: Schema.Boolean,
});
export type ScientAnnotationAgentView = typeof ScientAnnotationAgentView.Type;

export const ScientAnnotatedPdfView = Schema.Struct({
  sha256: NonEmptyString,
  paths: Schema.Array(Schema.String),
  sources: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      attachmentId: NonEmptyString,
      title: Schema.NullOr(Schema.String),
      citationKey: Schema.optionalKey(NonEmptyString),
    }),
  ),
});

const PdfChoice = {
  sourceId: Schema.optionalKey(NonEmptyString),
  attachmentId: Schema.optionalKey(
    NonEmptyString.annotate({ description: "When the Source has several PDFs." }),
  ),
  pdfRelativePath: Schema.optionalKey(RelativePdfPath),
};

const MutationOutcome = Schema.Literals([
  "created",
  "updated",
  "removed",
  "restored",
  "unchanged",
  "stale",
  "not-found",
  "empty",
  "limit-reached",
]);

export const ScientAnnotationMutationAgentResult = Schema.Struct({
  outcome: MutationOutcome,
  annotation: Schema.NullOr(ScientAnnotationAgentView),
  earlierRevisions: Schema.Array(
    Schema.Struct({
      revision: Revision,
      note: Schema.String,
      highlighted: Schema.Boolean,
      updatedBy: ScientAnnotationActor,
      updatedAt: NonEmptyString,
    }),
  ),
});

const ScientAnnotationsReadTool = Tool.make("scient_annotations_read", {
  description:
    "Read highlights and notes on this project's PDFs, grouped by PDF, with quotes, pages and owning Source (and citation key). One PDF by sourceId or pdfRelativePath, or the whole project; query searches quotes and notes. Use it before quoting or summarising what the user marked; cite as [@key, p. N] or \\cite[p.~N]{key}.",
  parameters: Schema.Struct({
    ...PdfChoice,
    query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
    includeRemoved: Schema.optionalKey(Schema.Boolean),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["listed", "pdf-not-found"]),
    pdfs: Schema.Array(
      Schema.Struct({
        ...ScientAnnotatedPdfView.fields,
        annotations: Schema.Array(ScientAnnotationAgentView),
      }),
    ),
    total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    unreadableFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  failure: ScientAnnotationsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read PDF highlights and notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, annotationOperation("annotations.read", false));

const ScientAnnotationsAddTool = Tool.make("scient_annotations_add", {
  description:
    "Highlight a PDF passage, optionally with a note, when the user asks. Pass sourceId or pdfRelativePath and its exact words as quote (spacing, case, line-end hyphens may differ). quote-ambiguous lists pages: call again with page. quote-not-found: not in the PDF's text (scans have none). Credited to you; repeating changes nothing.",
  parameters: Schema.Struct({
    ...PdfChoice,
    quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
    page: Schema.optionalKey(PageNumber),
    note: Schema.optionalKey(ScientAnnotationNote),
    highlight: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Default true; false keeps only the note.",
      }),
    ),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals([
      "created",
      "updated",
      "unchanged",
      "empty",
      "limit-reached",
      "pdf-not-found",
      "quote-not-found",
      "quote-ambiguous",
      "quote-too-long",
    ]),
    annotation: Schema.NullOr(ScientAnnotationAgentView),
    pdf: Schema.NullOr(ScientAnnotatedPdfView),
    pages: Schema.optionalKey(Schema.Array(PageNumber)),
  }),
  failure: ScientAnnotationsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Highlight a PDF passage")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, annotationOperation("annotations.add", true));

const ScientAnnotationsUpdateTool = Tool.make("scient_annotations_update", {
  description:
    "Change one annotation's note or highlight when the user asks. Pass its current revision; if stale, re-read and redo. It keeps a highlight or a note; to drop both, remove it. Earlier versions stay restorable.",
  parameters: Schema.Struct({
    annotationId: NonEmptyString,
    expectedRevision: Revision,
    note: Schema.optionalKey(ScientAnnotationNote),
    highlighted: Schema.optionalKey(Schema.Boolean),
  }),
  success: ScientAnnotationMutationAgentResult,
  failure: ScientAnnotationsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Edit a PDF annotation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, annotationOperation("annotations.update", true));

const ScientAnnotationsRemoveTool = Tool.make("scient_annotations_remove", {
  description:
    "Remove one highlight or note when the user asks; pass its current revision. scient_annotations_restore brings it back.",
  parameters: Schema.Struct({ annotationId: NonEmptyString, expectedRevision: Revision }),
  success: ScientAnnotationMutationAgentResult,
  failure: ScientAnnotationsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Remove a PDF annotation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, annotationOperation("annotations.remove", true));

const ScientAnnotationsRestoreTool = Tool.make("scient_annotations_restore", {
  description:
    "Bring back a removed annotation, or with toRevision return its note and highlight to an earlier revision (earlierRevisions). Pass its current revision.",
  parameters: Schema.Struct({
    annotationId: NonEmptyString,
    expectedRevision: Revision,
    toRevision: Schema.optionalKey(Revision),
  }),
  success: ScientAnnotationMutationAgentResult,
  failure: ScientAnnotationsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Restore a PDF annotation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, annotationOperation("annotations.restore", true));

export const ScientAnnotationsToolkit = Toolkit.make(
  ScientAnnotationsReadTool,
  ScientAnnotationsAddTool,
  ScientAnnotationsUpdateTool,
  ScientAnnotationsRemoveTool,
  ScientAnnotationsRestoreTool,
);
