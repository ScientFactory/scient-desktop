import { DOMSerializer, type Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";

/**
 * Modal isolation walks into the document to preserve CodeMirror's aria-live
 * announcer. Its attributes on surrounding blocks must not trigger reparsing:
 * that would destroy the node view which owns the open dialog.
 */
function isPresentationMutation(record: ViewMutationRecord): boolean {
  return (
    record.type === "attributes" &&
    (record.attributeName === "aria-hidden" ||
      record.attributeName === "inert" ||
      record.attributeName === "data-base-ui-inert")
  );
}

export function guardPresentationMutations(nodeView: NodeView): NodeView {
  const ignoreMutation = nodeView.ignoreMutation?.bind(nodeView);
  nodeView.ignoreMutation = (record) =>
    isPresentationMutation(record) ||
    (ignoreMutation?.(record) ?? (!nodeView.contentDOM && record.type !== "selection"));
  return nodeView;
}

/** Keep schema rendering and normal content reconciliation for structural nodes. */
export function createPresentationNodeView(node: ProseMirrorNode, view: EditorView): NodeView {
  const { dom, contentDOM } = DOMSerializer.renderSpec(
    view.dom.ownerDocument,
    node.type.spec.toDOM!(node),
  );
  return {
    dom,
    ...(contentDOM ? { contentDOM } : {}),
    update(next) {
      if (!next.sameMarkup(node)) return false;
      node = next;
      return true;
    },
  };
}
