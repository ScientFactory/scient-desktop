import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";

function detached(node: JSONContent): JSONContent {
  return {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs, sourceId: null } } : {}),
    ...(node.content ? { content: node.content.map(detached) } : {}),
  };
}

/** Insert at a valid block boundary; only explicit wrapping replaces selected content. */
export function insertLatexBlock(
  editor: Editor,
  node: JSONContent | JSONContent[],
  wrapSelection = false,
): boolean {
  if (!editor.isEditable) return false;
  const selection = editor.state.selection;
  let from = selection.from,
    to = selection.to;
  const nodes = (Array.isArray(node) ? node : [node]).map(detached);
  if (!nodes.length) return false;
  let content = nodes[0]!;
  if (wrapSelection && !selection.empty && !(selection instanceof NodeSelection)) {
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      if (selection.$from.node(depth).type.name === "latexScientific") return false;
    }
    if (
      selection.$from.parent.type.name !== "paragraph" &&
      selection.$from.sameParent(selection.$to)
    )
      return false;
    const body = (
      selection.$from.sameParent(selection.$to)
        ? [
            {
              type: "paragraph",
              content: selection.$from.parent.content
                .cut(selection.$from.parentOffset, selection.$to.parentOffset)
                .toJSON(),
            },
          ]
        : selection.content().content.toJSON()
    ) as JSONContent[];
    if (
      !body.every((child) =>
        ["paragraph", "latexDisplayMath", "bulletList", "orderedList", "blockquote"].includes(
          child.type ?? "",
        ),
      )
    )
      return false;
    content = { ...content, content: body.map(detached) };
    const candidate = editor.schema.nodeFromJSON(content);
    if (!candidate.type.validContent(candidate.content)) return false;
  } else {
    // A selected object is a destination, never an implicit replacement.
    from = to;
    for (let depth = selection.$to.depth; depth > 0; depth--) {
      if (
        content.type === "latexScientific" &&
        selection.$to.node(depth).type.name === "latexScientific"
      ) {
        from = to = selection.$to.after(depth);
        break;
      }
    }
  }
  nodes[0] = content;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      closeHistory(tr);
      return true;
    })
    .insertContentAt({ from, to }, nodes)
    .command(({ tr }) => {
      const caret = tr.selection.from;
      let target = -1,
        distance = Infinity;
      tr.doc.descendants((candidate, position) => {
        if (candidate.type.name !== content.type || candidate.attrs.sourceId != null) return;
        if (content.attrs?.kind && candidate.attrs.kind !== content.attrs.kind) return;
        const next = Math.abs(position + candidate.nodeSize - caret);
        if (next < distance) {
          target = position;
          distance = next;
        }
      });
      if (target >= 0) {
        const inserted = tr.doc.nodeAt(target)!;
        tr.setSelection(
          inserted.isAtom
            ? NodeSelection.create(tr.doc, target)
            : Selection.near(tr.doc.resolve(target + 1), 1),
        );
      }
      return true;
    })
    .run();
}
