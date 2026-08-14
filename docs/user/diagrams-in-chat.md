# Diagrams in chat

Scient turns a completed `mermaid` Markdown fence into an inline diagram. This
works well for research workflows, architectures, timelines, state changes,
entity relationships, and other explanations where the connections matter.
The same rendering is available for Mermaid fences in Markdown file previews.

The diagram card lets you:

- expand and zoom the diagram;
- show or copy its Mermaid source;
- download a scalable SVG;
- copy or download a high-resolution PNG; and
- retry or read the original source if the diagram is malformed.

While an answer is still being written, Scient shows the Mermaid source as an
ordinary code block. Rendering begins only after the answer settles and the
diagram is close to the visible conversation. A bad or unsupported diagram
never makes the rest of the answer disappear.

The Mermaid source remains the canonical content in the conversation. Copying
the whole answer preserves a fenced `mermaid` block, so it remains readable in
clients that do not have the rich renderer. Rendering and image export happen
locally; Scient does not send diagram source to a rendering service.

An inline diagram is not automatically saved as a project file. Ask the agent
to create a real `.mmd`, SVG, or other project artifact when you need something
durable and editable outside the conversation.
