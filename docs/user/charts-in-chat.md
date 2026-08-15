# Interactive charts in chat

Scient turns a completed `vega-lite` Markdown fence into an interactive chart.
It is a good fit for comparisons, trends, distributions, uncertainty, linked
views, and lightweight exploration of quantitative data. Vega-Lite fences in
Markdown file previews use the same renderer.

Charts support native Vega-Lite interactions such as hover tooltips, legends,
selections, brushing, zoom/pan parameters, and bound controls. The chart card
also lets you:

- expand the live chart without losing its current selections;
- reset the interaction state;
- show, copy, or download the original Vega-Lite JSON;
- download the current view as SVG or high-resolution PNG; and
- copy the current view as a PNG when the platform clipboard supports images.

Hover tooltips remain anchored to the active mark while you inspect it. Cursor
changes distinguish tooltip inspection from clickable selections and movable
brushes without overriding cursor behavior declared by the chart.

While an answer is still streaming, Scient shows the JSON as an ordinary code
block. Rendering starts only after the answer settles and the chart approaches
the visible conversation. Invalid JSON, an invalid specification, or failed
external data shows a local recovery state without breaking the rest of the
message.

Scient uses one bundled, current Vega-Lite compiler. Compatible charts that
declare an older schema version render without a version-only warning, while a
chart declaring a newer major version reports that incompatibility rather than
silently dropping unsupported features. The original JSON remains unchanged.

Inline data is the most portable choice. Absolute HTTP and HTTPS data URLs are
supported with a timeout and size limit; credentials are never sent. Relative
or local resource paths need a future project-file adapter because a chat
message has no stable directory authority. The chart source is canonical: whole
message copy preserves the fenced JSON rather than generated SVG.

For layered charts, Scient prepares a disposable interaction-safe render copy
when an otherwise shared selection would create duplicate internal signals.
The JSON shown, copied, and downloaded from the card remains exactly what the
conversation contains.

An inline chart is not automatically a durable scientific artifact. Ask the
agent to create a real `.vl.json`, data, SVG, or PNG file when you need a
versioned project asset. A project-relative SVG or PNG referenced with ordinary
Markdown image syntax can be [viewed directly in chat](./images-in-chat.md).
