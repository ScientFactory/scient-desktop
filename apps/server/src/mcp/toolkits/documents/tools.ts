import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import {
  ScientLatexPdfBuildDiagnostic,
  ScientLatexPdfBuildInput,
  ScientLatexPdfBuildResult,
  ScientLatexToolchainStatus,
  ScientPdfBuildInput,
  ScientPdfBuildResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import * as LatexBuildService from "../../../scient/latex/LatexBuildService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const NonEmptyMessage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
);

export class ScientPdfBuildToolError extends Schema.TaggedErrorClass<ScientPdfBuildToolError>()(
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
  },
) {}

export class ScientLatexBuildToolError extends Schema.TaggedErrorClass<ScientLatexBuildToolError>()(
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
  },
) {}

const sharedDocumentDependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  GeneratedDocumentStore.GeneratedDocumentStore,
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

export const ScientPdfBuildTool = Tool.make("scient_pdf_build", {
  description:
    "Build an existing project-relative HTML document into a real PDF at an explicit project-relative output path using Scient's isolated Chromium renderer. The result is structurally validated, published as an immutable generated document, written to the project, and opened in Scient. This does not visually review the pages.",
  parameters: ScientPdfBuildInput,
  success: ScientPdfBuildResult,
  failure: ScientPdfBuildToolError,
  dependencies: htmlDocumentDependencies,
})
  .annotate(Tool.Title, "Build a project HTML document as PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ScientLatexBuildTool = Tool.make("scient_latex_build", {
  description:
    "Build an existing project-relative LaTeX source into a real PDF at an explicit project-relative output path using Scient's LaTeX build service and an available qualified toolchain. The build resolves the document root, returns compiler diagnostics, publishes a structurally validated immutable revision, writes the PDF to the project, and opens the compiled root in Scient's LaTeX Source/Split/PDF surface in Split mode. Long builds return a paced in-progress result. This does not visually review the pages.",
  parameters: ScientLatexPdfBuildInput,
  success: ScientLatexPdfBuildResult,
  failure: ScientLatexBuildToolError,
  dependencies: latexDependencies,
})
  .annotate(Tool.Title, "Build a project LaTeX document as PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ScientDocumentsToolkit = Toolkit.make(ScientPdfBuildTool, ScientLatexBuildTool);
