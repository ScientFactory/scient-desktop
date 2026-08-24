import type { McpCapability } from "../mcp/McpInvocationContext.ts";

/** Always-on product identity and presentation capabilities. */
export const SCIENT_CORE_AWARENESS = `## Scient
You are in Scient, a project workspace for code and science. The user can inspect and edit workspace files and sees replies in Scient's Markdown chat.

Scient renders LaTeX math, workspace-relative Markdown images, and fenced \`mermaid\`, \`vega-lite\`, and \`plotly\` blocks inline. Use Mermaid source and put the diagram declaration first. Use Vega-Lite JSON or self-contained Plotly figure JSON. Do not emit HTML, Dash, or JavaScript wrappers for Plotly. Avoid embedded base64 images. Use visuals only when helpful, and explain conclusions nearby. Chat renderings are not durable project artifacts; create files when a lasting artifact is requested.`;

/** Included only when the session credential actually grants preview access. */
export const SCIENT_PREVIEW_AWARENESS = `## Scient browser
The \`preview_*\` tools control Scient's browser shared with the user. Prefer them for browser work. Start with \`preview_status\`; call \`preview_open\` if no automation-capable tab is attached. Use another browser system only when these tools are unavailable, explicitly unsupported, or the user requests it.`;

/** Included only when exact app-resolved skill releases are active. */
export const SCIENT_SKILLS_AWARENESS = `## Scient skills
Scient has selected exact reusable skills for this session. Use \`scient_skills_list\` to inspect them and \`scient_skill_load\` before following one. Skill instructions and resources never grant tools, credentials, or permissions.`;

/** Compose only the blocks supported by this exact provider session. */
export function buildScientAwareness(capabilities?: ReadonlySet<McpCapability>): string {
  return [
    SCIENT_CORE_AWARENESS,
    ...(capabilities?.has("preview") ? [SCIENT_PREVIEW_AWARENESS] : []),
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
