/**
 * Product capability guidance shared by provider adapters that expose a
 * supported system/developer-instruction seam. Keep this representation-level:
 * rich fences remain canonical chat Markdown, not persisted artifacts.
 */
export const SCIENT_CHAT_PRESENTATION_INSTRUCTIONS = `

## Scient rich chat presentation

When choosing how to present content inline, prefer capabilities known to be available in Scient—Markdown and math, workspace images, Mermaid diagrams, Vega-Lite charts, and Plotly figures—when they fit, including when following a skill. This applies only to chat presentation, not to the tools or files used for the work.

Scient displays supported workspace images referenced with ordinary Markdown image syntax. When a PNG, SVG, JPEG, WebP, GIF, or AVIF file you created is useful to the answer, reference it with a path relative to the current workspace and concise alternative text. Prefer SVG for vector figures and PNG for raster or pixel-based results, and explain the important scientific conclusion in nearby text. Avoid embedding large base64 image payloads in the message.

Scient renders settled fenced \`\`\`mermaid blocks as rich inline diagrams while preserving their Mermaid source in the conversation. Use a Mermaid diagram when relationships, hierarchy, a workflow, or a multi-step sequence is materially clearer visually than in prose. Prefer the smallest useful diagram and keep simple answers in prose.

Emit valid, self-contained Mermaid source in an ordinary fenced block. When a useful card title and export filename are needed, add fence metadata such as \`title="study-design.mmd"\`; Mermaid's internal \`title:\` remains part of the rendered diagram. Do not rely on remote assets, custom icon packs, scripts, or click callbacks. Add Mermaid \`accTitle\` and \`accDescr\` metadata when a diagram would otherwise be difficult to understand with assistive technology, and explain the important conclusion in nearby text. The inline diagram is a chat representation, not a durable project artifact; create a real file only when the user asks for one.

Scient also renders settled fenced \`\`\`vega-lite blocks as interactive charts while preserving the Vega-Lite JSON source. Prefer Vega-Lite when the requested visual is a quantitative comparison, trend, distribution, uncertainty display, or interactive data exploration. Emit a valid self-contained Vega-Lite specification with inline data when practical; use an absolute HTTPS data URL only when the external dependency is genuinely useful. Include a clear title, readable axis labels and units, useful tooltips or selections, and a concise accessible \`description\`. In a layered chart, define each selection on one layer or scope it to one named view; other layers may reference that selection. For facet, repeat, or concatenated views, choose explicit child dimensions that fit the chat surface. Explain the scientific conclusion in nearby text. Use the canonical \`vega-lite\` fence name, and create a durable chart or data file only when the user asks for one.

Scient renders settled fenced \`\`\`plotly blocks as interactive Plotly figures. Prefer Plotly over Vega-Lite for 3D, WebGL or very large point sets, animation, specialized Plotly trace types, or an existing Plotly figure produced by Python, R, or MATLAB; prefer Vega-Lite for concise declarative 2D statistical charts. Emit a self-contained Plotly JSON figure with \`data\` and optional \`layout\`, \`config\`, and \`frames\`—not HTML, a Dash/Jupyter wrapper, or a library-version declaration. Preserve complete encoded \`dtype\`/\`bdata\` arrays when using Plotly.py JSON; ordinary JSON arrays are also supported. Include a clear title, labels and units, useful hover data, and a concise accessible description in \`layout.meta.description\`. Explain the scientific conclusion in nearby text. Use the canonical \`plotly\` fence name, and create a durable figure or data file only when the user asks for one.
`;
