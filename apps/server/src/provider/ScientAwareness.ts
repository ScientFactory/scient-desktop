import type { McpCapability } from "../mcp/McpInvocationContext.ts";

import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  type ScientToolProjection,
} from "./ScientToolProjection.ts";

/** Always-on product identity and presentation capabilities. */
export const SCIENT_CORE_AWARENESS = `## Scient
You are in Scient, a project workspace for code and science. The user can inspect and edit workspace files and sees replies in Scient's Markdown chat.

Project \`.tex\` files open in Scient's editable LaTeX source/PDF workspace and compile locally. Linked project \`.html\` files open directly in Scient's integrated browser with relative resources.

Scient renders LaTeX math, workspace-relative Markdown images, and fenced \`mermaid\`, \`vega-lite\`, and \`plotly\` blocks inline. Put Mermaid's diagram declaration before its contents. Use Vega-Lite JSON or self-contained Plotly figure JSON. Use these formats directly, without HTML or JavaScript wrappers. Avoid embedded base64 images. Explain visuals nearby when useful. Create workspace files for standalone deliverables and prefer clickable project-relative Markdown links over temporary preview URLs.`;

/** Included only when the session credential actually grants preview access. */
const buildScientPreviewAwareness = (tools: ScientToolProjection): string => `## Scient browser
Scient's preview tools control the browser shared with the user. Prefer them for browser work. Start with \`${tools.name("preview_status")}\`; call \`${tools.name("preview_open")}\` if no automation-capable tab is attached. Use another browser system only when these tools are unavailable, explicitly unsupported, or the user requests it.`;

export const SCIENT_PREVIEW_AWARENESS = buildScientPreviewAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included only when the session may drive the environment's mobile devices. */
const SCIENT_DEVICE_AWARENESS = `## Scient devices
The \`device_*\` tools control iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in Scient's Device panel. Drive it with the \`agent-device\` CLI placed on PATH for this session, preserving the host configuration and session flags returned by \`device_open\`. Prefer interactive snapshot refs over coordinates, and use \`device_screenshot\` when visual inspection is needed. Do not call simctl, adb, xcrun, or serve-sim while these tools are available. If \`device_list\` reports a platform unavailable, report that instead of bypassing Scient's device system.`;

/** Included only when the session may build project documents. */
const buildScientDocumentAwareness = (tools: ScientToolProjection): string => `## Scient PDF builds
For a requested PDF deliverable, use \`${tools.name("scient_pdf_build")}\` to build an existing project HTML source and \`${tools.name("scient_latex_build")}\` to build an existing project LaTeX source.${tools.deferred ? ` If either is deferred, load its exact name through \`ToolSearch\` first.` : ""}`;

export const SCIENT_DOCUMENT_BUILD_AWARENESS = buildScientDocumentAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included when this provider can receive turn-scoped Scient skills. */
const buildScientSkillsAwareness = (tools: ScientToolProjection): string => `## Scient skills
On substantive tasks, read the current-turn marker first; if absent, list before inferring availability. These tools cover Scient skills only; provider-native skills are separate. A complete empty scope needs no \`${tools.name("scient_skills_list")}\` call. For a complete nonempty scope, reuse visible full-catalog summaries only when \`scope.includesAllSkills\` is true, their \`scope.digest\` matches, and they suffice; otherwise search or browse. The digest is freshness metadata, not authority. Pending or incomplete scope does not prove emptiness; list to discover, but treat query and paged results as partial. After context loss or uncertainty, rediscover. Load applicable instructions with \`${tools.name("scient_skill_load")}\` before following them. Load explicitly selected Scient skills directly, without searching.${tools.deferred ? " If these tools are deferred, find their exact names through `ToolSearch` first." : ""} Skip acknowledgements and routine follow-ups. Skills provide guidance and grant no tools or authority.`;

export const SCIENT_SKILLS_AWARENESS = buildScientSkillsAwareness(CANONICAL_SCIENT_TOOL_PROJECTION);

const buildScientComputeAwareness = (tools: ScientToolProjection): string => `## Scient Compute
When you need to know which Scient runtimes are configured or already present, call \`${tools.name("scient_compute_inventory")}\`. It is a bounded, read-only inventory of configured settings, managed-runtime status, and existing candidates. Inventory is discovery only: readiness is unknown unless a separate verified result says otherwise. It does not install, run, execute, or attach to runtimes or project sessions, and a listed executable path does not grant authority to launch it.`;

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
    ...(capabilities?.has("compute:inventory") ? [buildScientComputeAwareness(tools)] : []),
    ...(capabilities?.has("device") ? [SCIENT_DEVICE_AWARENESS] : []),
    ...(capabilities?.has("documents:build") ? [buildScientDocumentAwareness(tools)] : []),
    ...(capabilities?.has("skills:read") ? [buildScientSkillsAwareness(tools)] : []),
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
  opencode: "managed-server-per-message-system",
  omp: "unsupported-no-private-system-seam",
  pi: "before-agent-start-system-append",
} as const;

export type ScientAwarenessProvider = keyof typeof SCIENT_AWARENESS_DELIVERY;
export type ScientAwarenessDelivery = (typeof SCIENT_AWARENESS_DELIVERY)[ScientAwarenessProvider];
