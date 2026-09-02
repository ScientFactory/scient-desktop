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

Compact controls sit at the top-right without a full-width header bar. Any
authored title remains visible; **More diagram actions** also identifies the
diagram and its type. Source inspection opens only when requested.

Drag the dotted corner or empty toolbar space to move it within the card;
action buttons keep their normal behavior. Click the corner grip or press
Home while focused to restore its default position; arrow keys also move it.

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
