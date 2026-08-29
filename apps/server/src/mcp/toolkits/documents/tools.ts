import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { ScientPdfBuildInput, ScientPdfBuildResult } from "@t3tools/contracts";
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
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const NonEmptyMessage = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

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

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  GeneratedDocumentStore.GeneratedDocumentStore,
  Crypto.Crypto,
  FileSystem.FileSystem,
  Path.Path,
  ProjectFaviconResolver.ProjectFaviconResolver,
  ServerConfig.ServerConfig,
  ServerSecretStore.ServerSecretStore,
  WorkspacePaths.WorkspacePaths,
];

export const ScientPdfBuildTool = Tool.make("scient_pdf_build", {
  description:
    "Build an existing project-relative HTML document into a real PDF at an explicit project-relative output path using Scient's isolated Chromium renderer. The result is structurally validated, published as an immutable generated document, written to the project, and opened in Scient. This does not visually review the pages.",
  parameters: ScientPdfBuildInput,
  success: ScientPdfBuildResult,
  failure: ScientPdfBuildToolError,
  dependencies,
})
  .annotate(Tool.Title, "Build a project HTML document as PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ScientDocumentsToolkit = Toolkit.make(ScientPdfBuildTool);
