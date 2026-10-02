import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, type EditorState } from "@tiptap/pm/state";
import { projectLatexVisualDocument, serializeLatexVisualBlock } from "./latexVisualDocument";

export type LatexListType = "bulletList" | "orderedList" | "description";

function listType(node: ProseMirrorNode): LatexListType | null {
  if (node.type.name === "bulletList" || node.type.name === "orderedList") return node.type.name;
  return node.type.name === "latexRichPreview" && node.attrs.kind === "description"
    ? "description"
    : null;
}

export function selectedLatexListType(state: EditorState): LatexListType | null {
  const range = listRange(state);
  return range ? listType(range.node) : null;
}

function children(node: ProseMirrorNode): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = [];
  node.forEach((child) => result.push(child));
  return result;
}

// Treat a caret as the entire current list for type changes. An explicit
// selection changes only the intersecting items, splitting the list if needed.
function listRange(state: EditorState) {
  const { selection } = state;
  if (selection instanceof NodeSelection && listType(selection.node))
    return {
      from: selection.from,
      to: selection.to,
      node: selection.node,
      first: 0,
      last: selection.node.childCount,
    };
  const { $from, $to } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!listType(node) || $to.pos > $from.end(depth)) continue;
    let first = 0;
    let last = node.childCount;
    if (!selection.empty) {
      first = node.childCount;
      last = 0;
      node.forEach((item, offset, index) => {
        const start = $from.start(depth) + offset;
        if (start < selection.to && start + item.nodeSize > selection.from) {
          first = Math.min(first, index);
          last = index + 1;
        }
      });
    }
    return { from: $from.before(depth), to: $from.after(depth), node, first, last };
  }
  return null;
}

function descriptionItems(node: ProseMirrorNode, state: EditorState): ProseMirrorNode[] | null {
  const source = serializeLatexVisualBlock(node.toJSON());
  if (source === null) return null;
  const projected = projectLatexVisualDocument(source).content.content?.[0];
  const originals: unknown = projected?.attrs?.sourceMeta?.originalItems;
  if (!Array.isArray(originals)) return null;
  const items: ProseMirrorNode[] = [];
  for (const item of originals as unknown[]) {
    if (!item || typeof item !== "object" || !("raw" in item) || typeof item.raw !== "string")
      return null;
    const entry = /^\\item\s*\[([^\]]*)\]([\s\S]*)$/u.exec(item.raw);
    if (!entry) return null;
    const body = projectLatexVisualDocument(
      (entry[1] ? `\\textbf{${entry[1]}} ` : "") + entry[2]!.trim(),
    );
    if (body.rawBlocks > 0) return null;
    const content = children(state.schema.nodeFromJSON(body.content));
    if (content[0]?.type.name !== "paragraph")
      content.unshift(state.schema.nodes.paragraph!.create());
    items.push(state.schema.nodes.listItem!.create(null, content));
  }
  return items;
}

function orderedListStart(state: EditorState, position: number): number {
  const counters = new Map<number, number>();
  let result = 1;
  state.doc.descendants((node, pos) => {
    if (pos > position) return false;
    if (node.type.name !== "orderedList") return;
    const resolved = state.doc.resolve(pos);
    let level = 0;
    for (let depth = 1; depth <= resolved.depth; depth++)
      if (resolved.node(depth).type.name === "orderedList") level++;
    const start =
      node.attrs.resume === true ? (counters.get(level) ?? 0) + 1 : Number(node.attrs.start ?? 1);
    counters.set(level, start + node.childCount - 1);
    if (pos === position) result = start;
  });
  return result;
}

function asItems(nodes: ProseMirrorNode[], state: EditorState): ProseMirrorNode[] | null {
  const items: ProseMirrorNode[] = [];
  for (const node of nodes) {
    if (listType(node) === "description") {
      const described = descriptionItems(node, state);
      if (!described) return null;
      items.push(...described);
    } else if (listType(node)) items.push(...children(node));
    else if (node.type.name === "listItem") items.push(node);
    else if (node.type.name === "paragraph")
      items.push(state.schema.nodes.listItem!.create(null, node));
    else return null;
  }
  return items;
}

function withoutLists(nodes: ProseMirrorNode[], state: EditorState): ProseMirrorNode[] | null {
  const result: ProseMirrorNode[] = [];
  for (const node of nodes) {
    if (listType(node) === "description") {
      const items = descriptionItems(node, state);
      const content = items && withoutLists(items, state);
      if (!content) return null;
      result.push(...content);
    } else if (listType(node) || node.type.name === "listItem") {
      const content = withoutLists(children(node), state);
      if (!content) return null;
      result.push(...content);
    } else result.push(node);
  }
  return result;
}

/** Uses the existing description adapter; unsupported rich bodies are never flattened. */
function asDescription(items: ProseMirrorNode[], state: EditorState): ProseMirrorNode | null {
  const entries: { label: string; body: string }[] = [];
  for (const item of items) {
    if (item.childCount !== 1 || item.firstChild?.type.name !== "paragraph") return null;
    const paragraph = item.firstChild;
    if (children(paragraph).some((child) => !child.isText || child.marks.length > 0)) return null;
    entries.push({ label: "", body: paragraph.textContent });
  }
  const template = projectLatexVisualDocument("\\begin{description}\n\\item[] \n\\end{description}")
    .content.content?.[0];
  if (!template || template.attrs?.kind !== "description") return null;
  return state.schema.nodeFromJSON({
    ...template,
    attrs: {
      ...template.attrs,
      items: entries,
      itemIds: entries.map((_, index) => `new-description-${index}`),
    },
  });
}

export function changeLatexList(
  editor: Editor,
  target: LatexListType | null,
  apply = true,
): boolean {
  if (!editor.isEditable) return false;
  const state = editor.state;
  const range = listRange(state);
  if (target !== null && range && listType(range.node) === target) {
    if (apply) editor.commands.focus(undefined, { scrollIntoView: false });
    return true;
  }
  let from: number;
  let to: number;
  let nodes: ProseMirrorNode[];
  let before: ProseMirrorNode[] = [];
  let after: ProseMirrorNode[] = [];
  if (range) {
    ({ from, to } = range);
    if (listType(range.node) === "description") nodes = [range.node];
    else {
      const items = children(range.node);
      nodes = items.slice(range.first, range.last);
      if (range.first > 0)
        before = [range.node.copy(Fragment.fromArray(items.slice(0, range.first)))];
      if (range.last < items.length)
        after = [
          range.node.type.create(
            {
              ...range.node.attrs,
              sourceId: null,
              ...(range.node.type.name === "orderedList"
                ? { start: orderedListStart(state, from) + range.last, resume: false }
                : {}),
            },
            items.slice(range.last),
          ),
        ];
    }
  } else {
    const blocks = state.selection.$from.blockRange(state.selection.$to);
    if (!blocks) return false;
    from = blocks.start;
    to = blocks.end;
    nodes = children(blocks.parent).slice(blocks.startIndex, blocks.endIndex);
    if (target === null && !nodes.some((node) => listType(node))) return false;
  }
  const items = asItems(nodes, state);
  if (!items || items.length === 0) return false;
  let replacement: ProseMirrorNode[];
  if (target === null) {
    const paragraphs = withoutLists(items, state);
    if (!paragraphs) return false;
    replacement = paragraphs;
  } else if (target === "description") {
    const description = asDescription(items, state);
    if (!description) return false;
    replacement = [description];
  } else replacement = [state.schema.nodes[target]!.create(null, items)];

  const content = Fragment.fromArray([...before, ...replacement, ...after]);
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.canReplace($from.index(), $to.index(), content))
    return false;
  if (!apply) return true;
  const tr = state.tr.replaceWith(from, to, content);
  const start = from + before.reduce((size, node) => size + node.nodeSize, 0);
  tr.setSelection(
    replacement[0]?.type.name === "latexRichPreview"
      ? NodeSelection.create(tr.doc, start)
      : Selection.near(tr.doc.resolve(start + 1)),
  );
  editor.view.dispatch(tr.scrollIntoView());
  if (editor.state.doc === state.doc) return false;
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}
