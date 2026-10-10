import { NodeView, type NodeViewRenderer, type NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration, DecorationSource } from "@tiptap/pm/view";
import { ReactRenderer, type NodeViewProps } from "@tiptap/react";
import type { ComponentType } from "react";

export interface ScientificStatementViewProps extends NodeViewProps {
  statementRoot: HTMLDivElement;
  statementHeading: HTMLDivElement;
  updatePresentation: (
    attributes: Record<string, string | boolean | undefined>,
    headingVisible: boolean,
  ) => void;
}

export function isScientificStatement(node: ProseMirrorNode): boolean {
  return node.attrs.environment !== "abstract" && !node.attrs.layout;
}

/** ProseMirror keeps the body in place; React only owns presentation outside it. */
export function scientificStatementNodeView(
  component: ComponentType<ScientificStatementViewProps>,
  fallback: NodeViewRenderer,
): NodeViewRenderer {
  class StatementNodeView extends NodeView<ComponentType<ScientificStatementViewProps>> {
    declare renderer: ReactRenderer<unknown, ScientificStatementViewProps>;
    declare element: HTMLDivElement;
    declare body: HTMLDivElement;

    override mount() {
      this.element = document.createElement("div");
      this.element.className = "react-renderer node-latexScientific";
      const root = document.createElement("div");
      root.className = "scient-latex-scientific-structure";
      root.setAttribute("data-node-view-wrapper", "");
      root.style.whiteSpace = "normal";
      const heading = document.createElement("div");
      heading.className = "scient-latex-scientific-heading";
      heading.contentEditable = "false";
      const bodyWrapper = document.createElement("div");
      bodyWrapper.className = "scient-latex-scientific-body";
      bodyWrapper.setAttribute("aria-label", "Scientific statement body");
      bodyWrapper.setAttribute("data-node-view-content", "");
      bodyWrapper.style.whiteSpace = "pre-wrap";
      this.body = document.createElement("div");
      this.body.setAttribute("data-node-view-content-react", "");
      this.body.setAttribute("data-node-view-wrapper", "");
      this.body.style.whiteSpace = "inherit";
      bodyWrapper.append(this.body);
      root.append(heading, bodyWrapper);
      this.element.append(root);
      this.renderer = new ReactRenderer(component, {
        editor: this.editor,
        props: {
          editor: this.editor,
          node: this.node,
          decorations: this.decorations,
          innerDecorations: this.innerDecorations,
          view: this.view,
          selected: false,
          extension: this.extension,
          HTMLAttributes: this.HTMLAttributes,
          getPos: this.getPos,
          updateAttributes: this.updateAttributes.bind(this),
          deleteNode: () => this.deleteNode(),
          statementRoot: root,
          statementHeading: heading,
          updatePresentation: ((attributes, headingVisible) => {
            for (const [name, value] of Object.entries(attributes)) {
              if (value == null) {
                if (root.hasAttribute(name)) root.removeAttribute(name);
              } else if (root.getAttribute(name) !== String(value))
                root.setAttribute(name, String(value));
            }
            // The heading's flex rule overrides the browser's hidden rule.
            const display = headingVisible ? "" : "none";
            if (heading.style.display !== display) heading.style.display = display;
          }) satisfies ScientificStatementViewProps["updatePresentation"],
        },
      });
      // The component portals into the native heading and the existing footer.
      this.renderer.element.hidden = true;
      this.element.append(this.renderer.element);
    }

    override get dom() {
      return this.element;
    }

    override get contentDOM() {
      return this.body;
    }

    update(node: ProseMirrorNode, decorations: readonly Decoration[], inner: DecorationSource) {
      if (node.type !== this.node.type || !isScientificStatement(node)) return false;
      const changed = node !== this.node;
      this.node = node;
      this.decorations = decorations;
      this.innerDecorations = inner;
      if (changed) this.renderer.updateProps({ node, decorations, innerDecorations: inner });
      return true;
    }

    selectNode() {
      this.element.classList.add("ProseMirror-selectednode");
      this.renderer.updateProps({ selected: true });
    }

    deselectNode() {
      this.element.classList.remove("ProseMirror-selectednode");
      this.renderer.updateProps({ selected: false });
    }

    destroy() {
      this.renderer.destroy();
    }
  }

  return (props: NodeViewRendererProps) => {
    if (
      !isScientificStatement(props.node) ||
      !("contentComponent" in props.editor) ||
      !props.editor.contentComponent
    )
      return fallback(props);
    return new StatementNodeView(component, props);
  };
}
