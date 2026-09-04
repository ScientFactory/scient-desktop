# Diagrams in chat

Scient turns a completed `mermaid` Markdown fence into an inline diagram. This
works well for research workflows, architectures, timelines, state changes,
entity relationships, and other explanations where the connections matter.
The same rendering is available for Mermaid fences in Markdown file previews.
Ask the AI to make a Mermaid diagram when a process, hierarchy, or relationship
would be easier to understand visually than as a list of steps.

The diagram card lets you:

- expand and zoom the diagram;
- show or copy its Mermaid source;
- download a scalable SVG;
- copy or download a high-resolution PNG; and
- retry or read the original source if the diagram is malformed.

Quiet **Expand** and **More** icons sit at the top-right. Any authored title
remains visible; **More diagram actions** identifies the diagram and its type,
and contains source, copy, and download actions. Source inspection opens only
when requested. Expanded viewers keep zoom, fit, and actual-size controls visible.

Choose **Move controls** in More to expose a movement handle. Drag it or use
arrow keys to move within the card; press Enter or Escape to finish.
**Reset controls position** restores the default placement.

While an answer is still being written, Scient shows the Mermaid source as an
ordinary code block. Rendering begins only after the answer settles and the
diagram is close to the visible conversation. A bad or unsupported diagram
never makes the rest of the answer disappear.

The Mermaid source remains the original content in the conversation. Copying
the whole answer preserves a fenced `mermaid` block, so it remains readable
where an interactive diagram is unavailable. Rendering and image export happen
locally; Scient does not send diagram source to a rendering service.

Rendering is local and restricted: source callbacks and remote asset loaders
are not activated. Very large diagrams are rejected instead of slowing the
whole conversation.

An inline diagram is not automatically saved as a project file. Ask the agent
to create a real `.mmd`, SVG, or other project artifact when you need something
durable and editable outside the conversation.
