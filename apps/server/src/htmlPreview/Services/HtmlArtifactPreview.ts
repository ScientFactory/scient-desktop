// FILE: HtmlArtifactPreview.ts
// Purpose: Service contract for inspecting and preparing isolated HTML artifact previews.
// Layer: Server HTML-preview service boundary

import type {
  ProjectInspectHtmlArtifactInput,
  ProjectInspectHtmlArtifactResult,
  ProjectPrepareHtmlArtifactPreviewInput,
  ProjectRevokeHtmlArtifactPreviewInput,
  ProjectRevokeHtmlArtifactPreviewResult,
} from "@synara/contracts";
import type { LiveHtmlPreviewPrepareResult } from "@synara/shared/liveHtmlPreviewTransport";
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
  ) => Effect.Effect<LiveHtmlPreviewPrepareResult, HtmlArtifactPreviewError>;
  readonly revoke: (
    input: ProjectRevokeHtmlArtifactPreviewInput,
  ) => Effect.Effect<ProjectRevokeHtmlArtifactPreviewResult>;
}

export class HtmlArtifactPreview extends ServiceMap.Service<
  HtmlArtifactPreview,
  HtmlArtifactPreviewShape
>()("synara/htmlPreview/Services/HtmlArtifactPreview") {}
