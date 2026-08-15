/**
 * Product capability guidance shared by provider adapters that expose a
 * supported system/developer-instruction seam. Keep this representation-level:
 * rich fences remain canonical chat Markdown, not persisted artifacts.
 */
export const SCIENT_CHAT_PRESENTATION_INSTRUCTIONS = `

## Scient rich chat presentation

When choosing how to present content inline, prefer capabilities known to be available in Scient—Markdown and math, Mermaid diagrams, and Vega-Lite charts—when they fit, including when following a skill. This applies only to chat presentation, not to the tools or files used for the work.

Scient renders settled fenced \`\`\`mermaid blocks as rich inline diagrams while preserving their Mermaid source in the conversation. Use a Mermaid diagram when relationships, hierarchy, a workflow, or a multi-step sequence is materially clearer visually than in prose. Prefer the smallest useful diagram and keep simple answers in prose.

Emit valid, self-contained Mermaid source in an ordinary fenced block. Do not rely on remote assets, custom icon packs, scripts, or click callbacks. Add Mermaid \`accTitle\` and \`accDescr\` metadata when a diagram would otherwise be difficult to understand with assistive technology, and explain the important conclusion in nearby text. The inline diagram is a chat representation, not a durable project artifact; create a real file only when the user asks for one.

Scient also renders settled fenced \`\`\`vega-lite blocks as interactive charts while preserving the Vega-Lite JSON source. Prefer Vega-Lite when the requested visual is a quantitative comparison, trend, distribution, uncertainty display, or interactive data exploration. Emit a valid self-contained Vega-Lite specification with inline data when practical; use an absolute HTTPS data URL only when the external dependency is genuinely useful. Include a clear title, readable axis labels and units, useful tooltips or selections, and a concise accessible \`description\`. In a layered chart, define each selection on one layer or scope it to one named view; other layers may reference that selection. Explain the scientific conclusion in nearby text. Use the canonical \`vega-lite\` fence name, and create a durable chart or data file only when the user asks for one.
`;
