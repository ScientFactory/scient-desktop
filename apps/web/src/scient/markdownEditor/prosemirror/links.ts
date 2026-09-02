import type { EditorState } from "prosemirror-state";

/** The link run touching one document position, including segments with other inline marks. */
export function markdownLinkAtPosition(state: EditorState, position: number) {
  const $position = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
  const link = state.schema.marks.link;
  if (!link || !$position.parent.inlineContent) return null;
  const mark =
    link.isInSet($position.nodeAfter?.marks ?? []) ??
    link.isInSet($position.nodeBefore?.marks ?? []);
  if (!mark) return null;
  let from = $position.parentOffset;
  let to = from;
  $position.parent.forEach((node, offset) => {
    if (mark.isInSet(node.marks) && offset <= to && offset + node.nodeSize >= from) {
      from = Math.min(from, offset);
      to = Math.max(to, offset + node.nodeSize);
    }
  });
  // Include preceding runs with different non-link marks but the same href.
  for (
    let index = $position.parent.childCount - 1, end = $position.parent.content.size;
    index >= 0;
    index -= 1
  ) {
    const node = $position.parent.child(index);
    const start = end - node.nodeSize;
    if (end === from && mark.isInSet(node.marks)) from = start;
    end = start;
  }
  return {
    from: $position.start() + from,
    to: $position.start() + to,
    href: String(mark.attrs.href),
    title: typeof mark.attrs.title === "string" ? mark.attrs.title : null,
  };
}

/** The selected link, including its full marked run when only a caret is present. */
export function selectedMarkdownLink(state: EditorState) {
  return markdownLinkAtPosition(state, state.selection.from);
}
