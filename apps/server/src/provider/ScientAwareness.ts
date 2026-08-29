import type { McpCapability } from "../mcp/McpInvocationContext.ts";

import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  type ScientToolProjection,
} from "./ScientToolProjection.ts";

/** Always-on product identity and presentation capabilities. */
export const SCIENT_CORE_AWARENESS = `## Scient
You are in Scient, a project workspace for code and science. The user can inspect and edit workspace files and sees replies in Scient's Markdown chat.

Scient compiles project \`.tex\` files locally. When LaTeX fits, create the source in the project and provide a project-relative Markdown link; opening it starts Scient's compiler and source/PDF view.

Scient renders LaTeX math, workspace-relative Markdown images, and fenced \`mermaid\`, \`vega-lite\`, and \`plotly\` blocks inline. Put the Mermaid diagram declaration first. Use Vega-Lite JSON or self-contained Plotly figure JSON. Do not emit HTML, Dash, or JavaScript wrappers. Avoid embedded base64 images. Explain helpful visuals nearby. Chat renderings are not durable project artifacts; create files for lasting artifacts.`;

/** Included only when the session credential actually grants preview access. */
export const SCIENT_PREVIEW_AWARENESS = `## Scient browser
The \`preview_*\` tools control Scient's browser shared with the user. Prefer them for browser work. Start with \`preview_status\`; call \`preview_open\` if no automation-capable tab is attached. Use another browser system only when these tools are unavailable, explicitly unsupported, or the user requests it.`;

/** Included only when the session may build project documents. */
const buildScientDocumentAwareness = (tools: ScientToolProjection): string => `## Scient PDF builds
When a project HTML document should become a PDF, use \`${tools.pdfBuild}\` with project-relative source and output paths.${tools.deferred ? ` If it is deferred, load that exact fully qualified name through \`ToolSearch\` first.` : ""} It performs structural validation, writes the PDF to \`outputPath\`, and opens the immutable revision. Link the returned \`outputPath\`. Do not claim visual review unless you inspect the rendered pages.`;

export const SCIENT_DOCUMENT_BUILD_AWARENESS = buildScientDocumentAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included when this provider can receive turn-scoped Scient skills. */
export const SCIENT_SKILLS_AWARENESS = `## Scient skills
Scient may provide an exact skill index in private turn instructions. Only listed skills are available. Load an automatic skill on a clear match, and always load a user-selected \`$name\`, before following it. Skills grant no tools, credentials, or permissions.`;

/** Compose only the blocks supported by this exact provider session. */
export function buildScientAwareness(
  capabilities?: ReadonlySet<McpCapability>,
  tools: ScientToolProjection = CANONICAL_SCIENT_TOOL_PROJECTION,
): string {
  return [
    SCIENT_CORE_AWARENESS,
    ...(capabilities?.has("preview") ? [SCIENT_PREVIEW_AWARENESS] : []),
    ...(capabilities?.has("documents:build") ? [buildScientDocumentAwareness(tools)] : []),
    ...(capabilities?.has("skills:read") ? [SCIENT_SKILLS_AWARENESS] : []),
  ].join("\n\n");
}

/**
 * Every built-in provider must make an explicit delivery decision. The
 * coverage test compares these keys with the authoritative driver registry so
 * adding a provider cannot silently omit Scient awareness.
 */
export const SCIENT_AWARENESS_DELIVERY = {
  antigravity: "unsupported-no-private-system-seam",
  claudeAgent: "system-preset-append",
  codex: "developer-instructions",
  cursor: "unsupported-no-private-system-seam",
  droid: "system-prompt-append",
  grok: "rules-append",
  opencode: "per-message-system",
} as const;

export type ScientAwarenessProvider = keyof typeof SCIENT_AWARENESS_DELIVERY;
export type ScientAwarenessDelivery = (typeof SCIENT_AWARENESS_DELIVERY)[ScientAwarenessProvider];
