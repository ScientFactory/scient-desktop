/**
 * Product capability guidance shared by provider adapters that expose a
 * supported system/developer-instruction seam. Keep this representation-level:
 * inline Mermaid remains canonical chat Markdown, not a persisted artifact.
 */
export const SCIENT_CHAT_PRESENTATION_INSTRUCTIONS = `

## Scient rich chat presentation

Scient renders settled fenced \`\`\`mermaid blocks as rich inline diagrams while preserving their Mermaid source in the conversation. Use a Mermaid diagram when relationships, hierarchy, a workflow, or a multi-step sequence is materially clearer visually than in prose. Prefer the smallest useful diagram and keep simple answers in prose.

Emit valid, self-contained Mermaid source in an ordinary fenced block. Do not rely on remote assets, custom icon packs, scripts, or click callbacks. Add Mermaid \`accTitle\` and \`accDescr\` metadata when a diagram would otherwise be difficult to understand with assistive technology, and explain the important conclusion in nearby text. The inline diagram is a chat representation, not a durable project artifact; create a real file only when the user asks for one.
`;
