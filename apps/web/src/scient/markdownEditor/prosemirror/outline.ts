import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";

export interface ScientMarkdownOutlineItem {
  readonly level: number;
  readonly position: number;
  readonly text: string;
}

export interface ScientMarkdownOutlineState {
  readonly items: ReadonlyArray<ScientMarkdownOutlineItem>;
}

export const scientMarkdownOutlinePluginKey = new PluginKey<ScientMarkdownOutlineState>(
  "scientMarkdownOutline",
);

function documentOutline(doc: ProseMirrorNode): ScientMarkdownOutlineState {
  const items: ScientMarkdownOutlineItem[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    items.push({
      level: Number(node.attrs.level),
      position,
      text: node.textContent.trim(),
    });
  });
  return { items };
}

export function scientMarkdownOutlinePlugin(): Plugin<ScientMarkdownOutlineState> {
  return new Plugin<ScientMarkdownOutlineState>({
    key: scientMarkdownOutlinePluginKey,
    state: {
      init: (_config, state) => documentOutline(state.doc),
      apply: (transaction, previous) =>
        transaction.docChanged ? documentOutline(transaction.doc) : previous,
    },
  });
}

export function scientMarkdownOutlineState(state: EditorState): ScientMarkdownOutlineState {
  return scientMarkdownOutlinePluginKey.getState(state) ?? { items: [] };
}
