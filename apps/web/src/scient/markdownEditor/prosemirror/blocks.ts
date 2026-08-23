import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { Selection, type EditorState, type Transaction } from "prosemirror-state";

import { scientMarkdownSchema } from "./schema";

export type ScientMarkdownBlockAction = "delete" | "duplicate" | "move-down" | "move-up";

export interface ScientMarkdownBlockContext {
  readonly canDelete: boolean;
  readonly canDuplicate: boolean;
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly from: number;
  readonly index: number;
  readonly nodes: ReadonlyArray<ProseMirrorNode>;
  readonly to: number;
  readonly toIndex: number;
}

export function selectedTopLevelBlock(state: EditorState): ScientMarkdownBlockContext | null {
  if (state.doc.childCount === 0) return null;
  const index = Math.min(state.selection.$from.index(0), state.doc.childCount - 1);
  const toIndex = Math.max(
    index,
    Math.min(state.selection.$to.indexAfter(0) - 1, state.doc.childCount - 1),
  );
  let from = 0;
  for (let cursor = 0; cursor < index; cursor += 1) from += state.doc.child(cursor).nodeSize;
  const nodes: ProseMirrorNode[] = [];
  let to = from;
  for (let cursor = index; cursor <= toIndex; cursor += 1) {
    const node = state.doc.child(cursor);
    nodes.push(node);
    to += node.nodeSize;
  }
  return {
    canDelete: true,
    canDuplicate: true,
    canMoveDown: toIndex < state.doc.childCount - 1,
    canMoveUp: index > 0,
    from,
    index,
    nodes,
    to,
    toIndex,
  };
}

function copiedBlock(node: ProseMirrorNode): ProseMirrorNode {
  const sourceId =
    typeof node.attrs.sourceId === "string" && node.attrs.sourceId.length > 0
      ? node.attrs.sourceId
      : null;
  const sourceCopyId =
    sourceId ??
    (typeof node.attrs.sourceCopyId === "string" && node.attrs.sourceCopyId.length > 0
      ? node.attrs.sourceCopyId
      : null);
  return node.type.create(
    { ...node.attrs, sourceId: null, sourceCopyId },
    node.content,
    node.marks,
  );
}

function selectNear(transaction: Transaction, position: number): Transaction {
  const resolved = transaction.doc.resolve(
    Math.min(Math.max(0, position), transaction.doc.content.size),
  );
  return transaction.setSelection(Selection.near(resolved, 1)).scrollIntoView();
}

export function runScientMarkdownBlockAction(
  action: ScientMarkdownBlockAction,
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const context = selectedTopLevelBlock(state);
  if (!context) return false;
  const selectedContent = Fragment.fromArray([...context.nodes]);
  let transaction = state.tr;
  let selectionPosition = context.from;
  switch (action) {
    case "move-up": {
      if (!context.canMoveUp) return false;
      const previous = state.doc.child(context.index - 1);
      selectionPosition = context.from - previous.nodeSize;
      transaction = transaction
        .delete(context.from, context.to)
        .insert(selectionPosition, selectedContent);
      break;
    }
    case "move-down": {
      if (!context.canMoveDown) return false;
      const next = state.doc.child(context.toIndex + 1);
      selectionPosition = context.from + next.nodeSize;
      transaction = transaction
        .delete(context.from, context.to)
        .insert(selectionPosition, selectedContent);
      break;
    }
    case "duplicate": {
      selectionPosition = context.to;
      transaction = transaction.insert(
        context.to,
        Fragment.fromArray(context.nodes.map(copiedBlock)),
      );
      break;
    }
    case "delete": {
      if (context.nodes.length === state.doc.childCount) {
        const paragraph = scientMarkdownSchema.nodes.paragraph?.create();
        if (!paragraph) return false;
        transaction = transaction.replaceWith(context.from, context.to, paragraph);
      } else {
        transaction = transaction.delete(context.from, context.to);
      }
      selectionPosition = Math.min(context.from, transaction.doc.content.size);
      break;
    }
  }
  dispatch?.(selectNear(closeHistory(transaction), selectionPosition));
  return true;
}
