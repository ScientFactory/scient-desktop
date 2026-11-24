import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { ProjectFilePublicationOutcome, ScientPdfBuildInput } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as DocumentHostBroker from "../../../scient/documents/DocumentHostBroker.ts";
import { DocxJobCheck } from "../../../scient/documents/docxJob/DocxTrackedReplacementJob.ts";
import { OfficeRenderer } from "../../../scient/documents/docxJob/OfficeRenderer.ts";
import * as DocumentOfficeToolchain from "../../../scient/documents/docxJob/DocumentOfficeToolchain.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import * as WorkspaceBindingResolver from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";

const ProjectPath = ScientPdfBuildInput.fields.sourcePath;
// No control characters, unpaired surrogates or noncharacters: they cannot be stored in Word XML.
const WordText = (maxLength: number) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maxLength),
    Schema.isPattern(/^[^\p{Cc}\p{Cs}￾￿]+$/u),
  );

export const ScientDocxTrackedReplaceInput = Schema.Struct({
  sourcePath: ProjectPath.annotate({
    description: "The existing .docx in the project. It is not changed.",
  }),
  sourceRevision: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)).annotate({
    description: "sha256: and the lowercase SHA-256 of the source file's bytes as you read them.",
  }),
  outputPath: ProjectPath.annotate({
    description: "A new .docx path in the project for the edited copy.",
  }),
  pdfOutputPath: ProjectPath.annotate({
    description: "A .pdf path in the project for the copy's PDF.",
  }),
  find: WordText(256).annotate({
    description: "Exact text that occurs once in the document, inside one run of one paragraph.",
  }),
  replace: WordText(256).annotate({
    description: "Text that replaces it, as a tracked insertion.",
  }),
  author: WordText(64).annotate({ description: "Revision author shown by Word." }),
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u)).annotate({
    description: "Revision time in UTC, YYYY-MM-DDTHH:MM:SSZ.",
  }),
});
export type ScientDocxTrackedReplaceInput = typeof ScientDocxTrackedReplaceInput.Type;

export const ScientDocxTrackedReplaceResult = Schema.Struct({
  sourcePath: Schema.String,
  sourceRevision: Schema.String,
  outputPath: Schema.String,
  outputRevision: Schema.String,
  pdfOutputPath: Schema.String,
  pdf: PdfSourceDescriptor,
  revision: Schema.Struct({
    deletionId: Schema.String,
    insertionId: Schema.String,
    author: Schema.String,
    date: Schema.String,
  }),
  checks: Schema.Array(DocxJobCheck),
  pageCount: Schema.Number,
  editPage: Schema.Number,
  engine: Schema.Struct({
    name: Schema.Literal("LibreOffice"),
    version: Schema.String,
    provisioning: Schema.Literals(["pinned-archive", "host-install"]),
    producer: Schema.NullOr(Schema.String),
    fonts: Schema.Array(Schema.String),
  }),
  support: Schema.Struct({
    inputPolicy: Schema.Literal("trusted-fixtures"),
    isolation: Schema.Literal("process-boundary"),
    osSandbox: Schema.Literal(false),
  }),
  warnings: Schema.Array(Schema.String),
});
export type ScientDocxTrackedReplaceResult = typeof ScientDocxTrackedReplaceResult.Type;

export class ScientDocxTrackedReplaceToolError extends Schema.TaggedError<ScientDocxTrackedReplaceToolError>()(
  "ScientDocxTrackedReplaceToolError",
  {
    code: Schema.Literals([
      "project-required",
      "project-changed",
      "invalid-source-path",
      "invalid-output-path",
      "source-not-found",
      "source-changed",
      "unsupported-input",
      "unsupported-edit",
      "toolchain-unavailable",
      "render-failed",
      "integrity-failed",
      "publication-failed",
      "output-write-failed",
      "partial-publication",
    ]),
    message: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
    reason: Schema.optional(Schema.String),
    checks: Schema.optional(Schema.Array(DocxJobCheck)),
    publishedSource: Schema.optional(PdfSourceDescriptor),
    publishedPaths: Schema.optional(Schema.Array(Schema.String)),
    publicationOutcome: Schema.optional(ProjectFilePublicationOutcome),
    recoveryId: Schema.optional(Schema.String),
    retainedPaths: Schema.optional(Schema.Array(Schema.String)),
    mutationId: Schema.optional(Schema.String),
  },
) {}

const ScientDocxTrackedReplaceTool = Tool.make("scient_docx_tracked_replace", {
  description:
    "Make one tracked text replacement in a new copy of a project Word file and save the copy and its PDF. Pass the source's sha256 revision. The text must occur once, inside one run. Scient checks the copy against the source and the PDF against the source's own render, and saves nothing if a check fails. Development preview for trusted files.",
  parameters: ScientDocxTrackedReplaceInput,
  success: ScientDocxTrackedReplaceResult,
  failure: ScientDocxTrackedReplaceToolError,
  dependencies: [
    OrchestratorV2,
    AgentInvocationContext.AgentInvocationContext,
    DocumentHostBroker.DocumentHostBroker,
    GeneratedDocumentStore.GeneratedDocumentStore,
    WorkspaceBindingResolver.WorkspaceBindingResolver,
    WorkspaceFileSystem.WorkspaceFileSystem,
    DocumentOfficeToolchain.DocumentOfficeToolchain,
    OfficeRenderer,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Make a tracked replacement in a Word copy")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, {
    id: "documents.docx.trackedReplace",
    scope: "workspace",
    requiredCapabilities: ["documents:build"],
  });

export const ScientDocumentJobsToolkit = Toolkit.make(ScientDocxTrackedReplaceTool);
