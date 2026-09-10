import { DOMSerializer, type Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";

/**
 * Presentation-owned attributes must not trigger document reparsing. Modal
 * isolation uses these for accessibility, while the table node view uses one
 * to keep automatic column alignment out of saved Markdown.
 */
function isPresentationMutation(record: ViewMutationRecord): boolean {
  return (
    record.type === "attributes" &&
    (record.attributeName === "aria-hidden" ||
      record.attributeName === "inert" ||
      record.attributeName === "data-base-ui-inert" ||
      record.attributeName === "data-scient-table-column-direction")
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
