import type { EditorState } from "prosemirror-state";

/** The selected link, including its full marked run when only a caret is present. */
export function selectedMarkdownLink(state: EditorState) {
  const { selection } = state;
  const { $from } = selection;
  const link = state.schema.marks.link;
  if (!link || !$from.parent.inlineContent) return null;
  const mark =
    link.isInSet($from.nodeAfter?.marks ?? []) ?? link.isInSet($from.nodeBefore?.marks ?? []);
  if (!mark) return null;
  let from = $from.parentOffset;
  let to = from;
  $from.parent.forEach((node, offset) => {
    if (mark.isInSet(node.marks) && offset <= to && offset + node.nodeSize >= from) {
      from = Math.min(from, offset);
      to = Math.max(to, offset + node.nodeSize);
    }
  });
  // Include preceding runs with different non-link marks but the same href.
  for (
    let index = $from.parent.childCount - 1, end = $from.parent.content.size;
    index >= 0;
    index -= 1
  ) {
    const node = $from.parent.child(index);
    const start = end - node.nodeSize;
    if (end === from && mark.isInSet(node.marks)) from = start;
    end = start;
  }
  return {
    from: $from.start() + from,
    to: $from.start() + to,
    href: String(mark.attrs.href),
    title: typeof mark.attrs.title === "string" ? mark.attrs.title : null,
  };
}
