import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import {
  ScientLatexPdfBuildDiagnostic,
  ScientLatexPdfBuildInput,
  ScientLatexPdfBuildResult,
  ScientLatexToolchainStatus,
  ScientDocumentExportInput,
  ScientDocumentExportResult,
  ScientPdfBuildInput,
  ScientPdfBuildResult,
  ProjectFilePublicationOutcome,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";
import { ScientOperation, type OperationMetadata } from "../../ScientOperationTool.ts";

import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as LatexBuildService from "../../../scient/latex/LatexBuildService.ts";
import * as WorkspaceBindingResolver from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import * as DocumentHostBroker from "../../../scient/documents/DocumentHostBroker.ts";

const NonEmptyMessage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
);

export class ScientPdfBuildToolError extends Schema.TaggedError<ScientPdfBuildToolError>()(
  "ScientPdfBuildToolError",
  {
    code: Schema.Literals([
      "capability-unavailable",
      "project-required",
      "project-changed",
      "invalid-source-path",
      "invalid-output-path",
      "source-not-found",
      "source-changed",
      "renderer-unavailable",
      "render-failed",
      "publication-failed",
      "output-write-failed",
      "partial-publication",
    ]),
    message: NonEmptyMessage,
    publishedSource: Schema.optional(PdfSourceDescriptor),
    outputPath: Schema.optional(ScientPdfBuildInput.fields.outputPath),
    publicationOutcome: Schema.optional(ProjectFilePublicationOutcome),
    recoveryId: Schema.optional(Schema.String),
    retainedPaths: Schema.optional(Schema.Array(Schema.String)),
    mutationId: Schema.optional(Schema.String),
  },
) {}

export class ScientDocumentExportToolError extends Schema.TaggedError<ScientDocumentExportToolError>()(
  "ScientDocumentExportToolError",
  {
    code: Schema.Literals([
      "capability-unavailable",
      "project-required",
      "project-changed",
      "invalid-source-path",
      "invalid-output-path",
      "unsupported-format",
      "source-not-found",
      "source-changed",
      "renderer-unavailable",
      "render-failed",
      "too-large",
      "publication-failed",
      "output-write-failed",
      "partial-publication",
    ]),
    message: NonEmptyMessage,
    publishedSource: Schema.optional(PdfSourceDescriptor),
    outputPath: Schema.optional(ScientDocumentExportInput.fields.outputPath),
    publicationOutcome: Schema.optional(ProjectFilePublicationOutcome),
    recoveryId: Schema.optional(Schema.String),
    retainedPaths: Schema.optional(Schema.Array(Schema.String)),
    mutationId: Schema.optional(Schema.String),
  },
) {}

export class ScientLatexBuildToolError extends Schema.TaggedError<ScientLatexBuildToolError>()(
  "ScientLatexBuildToolError",
  {
    code: Schema.Literals([
      "capability-unavailable",
      "project-required",
      "project-changed",
      "invalid-source-path",
      "invalid-output-path",
      "source-not-found",
      "toolchain-unavailable",
      "build-failed",
      "build-cancelled",
      "revision-unavailable",
      "output-write-failed",
      "partial-publication",
    ]),
    message: NonEmptyMessage,
    sourcePath: Schema.optional(ScientLatexPdfBuildInput.fields.sourcePath),
    rootSourcePath: Schema.optional(ScientLatexPdfBuildInput.fields.sourcePath),
    outputPath: Schema.optional(ScientLatexPdfBuildInput.fields.outputPath),
    diagnostics: Schema.optional(
      Schema.Array(ScientLatexPdfBuildDiagnostic).check(Schema.isMaxLength(64)),
    ),
    toolchain: Schema.optional(Schema.NullOr(ScientLatexToolchainStatus)),
    publishedSource: Schema.optional(PdfSourceDescriptor),
    publicationOutcome: Schema.optional(ProjectFilePublicationOutcome),
    recoveryId: Schema.optional(Schema.String),
    retainedPaths: Schema.optional(Schema.Array(Schema.String)),
    mutationId: Schema.optional(Schema.String),
  },
) {}

const sharedDocumentDependencies = [
  OrchestratorV2,
  AgentInvocationContext.AgentInvocationContext,
  DocumentHostBroker.DocumentHostBroker,
  GeneratedDocumentStore.GeneratedDocumentStore,
  WorkspaceBindingResolver.WorkspaceBindingResolver,
  WorkspaceFileSystem.WorkspaceFileSystem,
  FileSystem.FileSystem,
  Path.Path,
];

const htmlDocumentDependencies = [
  ...sharedDocumentDependencies,
  Crypto.Crypto,
  ProjectFaviconResolver.ProjectFaviconResolver,
  ServerConfig.ServerConfig,
  ServerSecretStore.ServerSecretStore,
  WorkspacePaths.WorkspacePaths,
];

const latexDependencies = [...sharedDocumentDependencies, LatexBuildService.LatexBuildService];

const documentOperation = (id: string): OperationMetadata => ({
  id,
  family: "documents",
  scope: "workspace",
  requiredCapabilities: ["documents:build"],
  approval: "explicit-user-request-guidance",
  documentation:
    id === "documents.latex.build"
      ? "docs/internals/scient-latex.md"
      : id === "documents.export"
        ? "docs/internals/scient-document-pdf-export.md"
        : "docs/internals/scient-browser-pdf-export.md",
});

export const ScientPdfBuildTool = Tool.make("scient_pdf_build", {
  description:
    "Build a project HTML file into a PDF at the project path you give, and open it in Scient. Needs a connected Scient desktop. It does not check how the pages look.",
  parameters: ScientPdfBuildInput,
  success: ScientPdfBuildResult,
  failure: ScientPdfBuildToolError,
  dependencies: htmlDocumentDependencies,
})
  .annotate(Tool.Title, "Build a project HTML document as PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, documentOperation("documents.html.build"));

export const ScientLatexBuildTool = Tool.make("scient_latex_build", {
  description:
    "Build a project LaTeX file into a PDF at the project path you give, and open it in Scient's Split view. Scient finds the main document; if the file belongs to several, pass rootSourcePath. Returns compiler diagnostics. Scient may download missing TeX packages. If the result is in-progress, wait retryAfterMs, then call again with the same paths. It does not check how the pages look.",
  parameters: ScientLatexPdfBuildInput,
  success: ScientLatexPdfBuildResult,
  failure: ScientLatexBuildToolError,
  dependencies: latexDependencies,
})
  .annotate(Tool.Title, "Build a project LaTeX document as PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, documentOperation("documents.latex.build"));

const ScientDocumentExportTool = Tool.make("scient_document_export", {
  description:
    "Export a project Markdown file to the project path you give, and open it in Scient. The output extension picks the format; PDF is available. Missing images become placeholders listed in warnings. Needs a connected Scient desktop. It does not check how the pages look.",
  parameters: ScientDocumentExportInput,
  success: ScientDocumentExportResult,
  failure: ScientDocumentExportToolError,
  dependencies: htmlDocumentDependencies,
})
  .annotate(Tool.Title, "Export a project Markdown document")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, documentOperation("documents.export"));

export const ScientDocumentsToolkit = Toolkit.make(
  ScientPdfBuildTool,
  ScientLatexBuildTool,
  ScientDocumentExportTool,
);
