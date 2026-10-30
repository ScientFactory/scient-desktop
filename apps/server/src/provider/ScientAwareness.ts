import type { McpCapability } from "../mcp/McpInvocationContext.ts";

import { SCIENT_DEVICE_TOOL_INSTRUCTIONS } from "./ScientProviderInstructions.ts";
import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  type ScientToolProjection,
} from "./ScientToolProjection.ts";

/** Always-on product identity and presentation capabilities. */
export const SCIENT_CORE_AWARENESS = `## Scient
You are in Scient, a project workspace for code and science. The user reads your replies in Scient's Markdown chat and can edit project files.

Replies render LaTeX math, Markdown images, and fenced \`mermaid\`, \`vega-lite\` (JSON) and \`plotly\` (self-contained figure JSON) blocks. Put a chart or diagram that fits one in your reply as that block, and explain it nearby. Show a visual without being asked when it says more than prose. Start Mermaid with its diagram type. Do not wrap them in HTML or JavaScript or embed base64 images.

Put standalone deliverables in project files and link them instead of preview URLs. Linked \`.tex\` files open in Scient's LaTeX editor and \`.html\` files in its browser.`;

/** Included only when the session credential actually grants preview access. */
const buildScientPreviewAwareness = (tools: ScientToolProjection): string => `## Scient browser
Scient's preview tools drive the browser the user also sees. For browser work, use them first: \`${tools.name("preview_status")}\`, then \`${tools.name("preview_open")}\` if no tab you can drive is attached. Use another browser only when these tools are unavailable or the user asks.`;

export const SCIENT_PREVIEW_AWARENESS = buildScientPreviewAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included only when the session may build project documents. */
const buildScientDocumentAwareness = (tools: ScientToolProjection): string => `## Scient PDF builds
For a requested PDF deliverable, use \`${tools.name("scient_pdf_build")}\` to build an existing project HTML source, \`${tools.name("scient_latex_build")}\` to build an existing project LaTeX source, and \`${tools.name("scient_document_export")}\` to export an existing project Markdown document.${tools.deferred ? ` If any is deferred, load its exact name through \`ToolSearch\` first.` : ""}`;

export const SCIENT_DOCUMENT_BUILD_AWARENESS = buildScientDocumentAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/**
 * Included with document authority: the Overleaf tools need no grant of their own
 * (pr-c-design.md section 1). The skill carries the details.
 */
const buildScientOverleafAwareness = (tools: ScientToolProjection): string => `## Scient Overleaf
A project folder can be linked to one Overleaf project and synced both ways on request. For Overleaf work, use the Overleaf tools, starting with \`${tools.name("scient_overleaf_status")}\`, and follow the \`overleaf-sync\` skill. The tools need no approval: do what the user asked. Only a conflict stops a sync.${tools.deferred ? " If they are deferred, load their exact names through `ToolSearch` first." : ""}`;

export const SCIENT_OVERLEAF_AWARENESS = buildScientOverleafAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included when this provider can receive turn-scoped Scient skills. */
const buildScientSkillsAwareness = (tools: ScientToolProjection): string => `## Scient skills
Scient skills are instructions the user manages in Scient, separate from your provider's own skills. On a substantive task, follow this turn's Scient skill scope note; without one, call \`${tools.name("scient_skills_list")}\`. Load a skill with \`${tools.name("scient_skill_load")}\` before you follow it; load one the user selected directly.${tools.deferred ? " If these tools are deferred, find their exact names through `ToolSearch` first." : ""} Skills give guidance only and grant no tools or permissions.`;

export const SCIENT_SKILLS_AWARENESS = buildScientSkillsAwareness(CANONICAL_SCIENT_TOOL_PROJECTION);

const buildScientComputeAwareness = (tools: ScientToolProjection): string => `## Scient Compute
Run data analysis and figures with \`${tools.name("scient_compute_run")}\`, not a shell interpreter: the user sees each run, variables persist, and you get the output and figures back. \`${tools.name("scient_compute_sessions")}\` finds the user's sessions, such as an open file.${tools.deferred ? " If deferred, load these tools through `ToolSearch` first." : ""}`;

export const SCIENT_COMPUTE_AWARENESS = buildScientComputeAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Compose only the blocks supported by this exact provider session. */
export function buildScientAwareness(
  capabilities?: ReadonlySet<McpCapability>,
  tools: ScientToolProjection = CANONICAL_SCIENT_TOOL_PROJECTION,
): string {
  return [
    SCIENT_CORE_AWARENESS,
    ...(capabilities?.has("preview") ? [buildScientPreviewAwareness(tools)] : []),
    ...(capabilities?.has("compute") ? [buildScientComputeAwareness(tools)] : []),
    // Included only when the session may drive the environment's mobile devices.
    ...(capabilities?.has("device") ? [SCIENT_DEVICE_TOOL_INSTRUCTIONS] : []),
    ...(capabilities?.has("documents:build")
      ? [buildScientDocumentAwareness(tools), buildScientOverleafAwareness(tools)]
      : []),
    ...(capabilities?.has("skills:read") ? [buildScientSkillsAwareness(tools)] : []),
  ].join("\n\n");
}

/**
 * Every built-in provider must make an explicit delivery decision. The
 * coverage test compares these keys with the authoritative driver registry so
 * adding a provider cannot silently omit Scient awareness.
 */
export const SCIENT_AWARENESS_DELIVERY = {
  acpRegistry: "unsupported-no-private-system-seam",
  antigravity: "unsupported-no-private-system-seam",
  claudeAgent: "system-preset-append",
  codex: "developer-instructions",
  cursor: "unsupported-no-private-system-seam",
  droid: "system-prompt-append",
  fx: "unsupported-no-private-system-seam",
  grok: "rules-append",
  // Native sessionMcp exposes tools; MSP does not expose a private system prompt seam.
  muse: "unsupported-no-private-system-seam",
  opencode: "managed-server-per-message-system",
  omp: "before-agent-start-system-append",
  pi: "before-agent-start-system-append",
  scient: "before-agent-start-system-append",
} as const;

export type ScientAwarenessProvider = keyof typeof SCIENT_AWARENESS_DELIVERY;
export type ScientAwarenessDelivery = (typeof SCIENT_AWARENESS_DELIVERY)[ScientAwarenessProvider];
