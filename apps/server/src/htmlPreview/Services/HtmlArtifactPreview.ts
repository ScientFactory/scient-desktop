// FILE: HtmlArtifactPreview.ts
// Purpose: Service contract for inspecting and preparing isolated HTML artifact previews.
// Layer: Server HTML-preview service boundary

import type {
  ProjectInspectHtmlArtifactInput,
  ProjectInspectHtmlArtifactResult,
  ProjectPrepareHtmlArtifactPreviewInput,
  ProjectPrepareHtmlArtifactPreviewResult,
  ProjectRevokeHtmlArtifactPreviewInput,
  ProjectRevokeHtmlArtifactPreviewResult,
} from "@synara/contracts";
import { Data, Effect, ServiceMap } from "effect";

export class HtmlArtifactPreviewError extends Data.TaggedError("HtmlArtifactPreviewError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface HtmlArtifactPreviewShape {
  readonly inspect: (
    input: ProjectInspectHtmlArtifactInput,
  ) => Effect.Effect<ProjectInspectHtmlArtifactResult, HtmlArtifactPreviewError>;
  readonly prepare: (
    input: ProjectPrepareHtmlArtifactPreviewInput,
  ) => Effect.Effect<ProjectPrepareHtmlArtifactPreviewResult, HtmlArtifactPreviewError>;
  readonly revoke: (
    input: ProjectRevokeHtmlArtifactPreviewInput,
  ) => Effect.Effect<ProjectRevokeHtmlArtifactPreviewResult>;
}

export class HtmlArtifactPreview extends ServiceMap.Service<
  HtmlArtifactPreview,
  HtmlArtifactPreviewShape
>()("synara/htmlPreview/Services/HtmlArtifactPreview") {}
