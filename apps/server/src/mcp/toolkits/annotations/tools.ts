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
  sourceId: Schema.optionalKey(
    NonEmptyString.annotate({ description: "A Source whose PDF to use; see scient_sources_list." }),
  ),
  attachmentId: Schema.optionalKey(
    NonEmptyString.annotate({
      description: "Which of the Source's PDFs, when it has more than one.",
    }),
  ),
  pdfRelativePath: Schema.optionalKey(
    RelativePdfPath.annotate({ description: "A project-relative path to any PDF." }),
  ),
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
    "Read the highlights and notes people and agents made on PDFs in this project, grouped by PDF, with the quoted text, pages and any Source the PDF belongs to (with its citation key). " +
    "Give a sourceId or pdfRelativePath for one PDF, or neither for the whole project; query searches quotes and notes. Use this before quoting or summarising what the user marked.",
  parameters: Schema.Struct({
    ...PdfChoice,
    query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
    includeRemoved: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Also list removed annotations, which can be restored.",
      }),
    ),
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
    "Highlight a passage of a PDF, optionally with a note, when the user asks. Give a sourceId or pdfRelativePath and the passage's exact words as quote; spacing, case and line-end hyphens may differ. " +
    "quote-ambiguous lists the pages where it occurs: call again with page. quote-not-found means those words are not in the PDF's text (a scanned PDF has none). " +
    "The user sees the highlight in the PDF, credited to you; adding the same passage again changes nothing.",
  parameters: Schema.Struct({
    ...PdfChoice,
    quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
    page: Schema.optionalKey(PageNumber),
    note: Schema.optionalKey(ScientAnnotationNote),
    highlight: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Defaults to true. False keeps only the note on the passage.",
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
    "Change the note or highlight of one annotation when the user asks. Read it first and pass its current revision; if stale, read again and redo the change. " +
    "An annotation needs a highlight or a note; to drop both, remove it. Earlier versions stay restorable.",
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
    "Remove one highlight or note when the user asks. Pass its current revision. It can be brought back with scient_annotations_restore.",
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
    "Bring back a removed annotation, or with toRevision return its note and highlight to an earlier revision (listed in earlierRevisions). Pass its current revision.",
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
