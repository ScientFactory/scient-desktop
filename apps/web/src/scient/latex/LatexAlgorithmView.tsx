import { useRef, type CSSProperties } from "react";
import { Node as TiptapNode } from "@tiptap/core";
import { splitBlockAs } from "@tiptap/pm/commands";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type NodeViewProps,
} from "@tiptap/react";
import { algorithmKeywords } from "./latexAlgorithm";
import { LatexObjectToolbar } from "./LatexObjectToolbar";
import { LatexTextField } from "./LatexTextField";
import { latexEquationReferencesKey } from "./latexEquationReferences";

export function LatexAlgorithmView({
  node,
  editor,
  selected,
  getPos,
  updateAttributes,
  deleteNode,
  editable,
  draftKey,
}: Pick<
  NodeViewProps,
  "node" | "editor" | "selected" | "getPos" | "updateAttributes" | "deleteNode"
> & { editable: boolean; draftKey?: string | undefined }) {
  const root = useRef<HTMLDivElement>(null);
  const number = useEditorState({
    editor,
    selector: ({ editor }) => {
      const position = getPos();
      return typeof position === "number"
        ? (latexEquationReferencesKey.getState(editor.state)?.algorithms?.get(position)?.number ??
            null)
        : null;
    },
  });
  return (
    <NodeViewWrapper ref={root} className="scient-latex-algorithm">
      {node.attrs.layout.captioned && (
        <div className="scient-latex-algorithm-caption" contentEditable={false}>
          <strong>Algorithm{number ? ` ${number}` : ""}</strong>
          <LatexTextField
            aria-label="Algorithm caption"
            rows={1}
            value={String(node.attrs.title)}
            draftKey={draftKey && `${draftKey}:caption`}
            disabled={!editable}
            onValueChange={(title) => updateAttributes({ title })}
          />
        </div>
      )}
      <NodeViewContent
        className="scient-latex-algorithm-body"
        aria-label="Pseudocode"
        data-latex-text-style={node.attrs.layout.fontSize ?? undefined}
      />
      <LatexObjectToolbar editor={editor} root={root} selected={selected} label="Algorithm tools">
        <details className="scient-latex-context-menu">
          <summary>Algorithm options</summary>
          <div className="scient-latex-context-menu-panel">
            <button
              type="button"
              disabled={!editable}
              onClick={() => {
                const position = getPos();
                if (typeof position !== "number") return;
                const selection = editor.state.selection.$from;
                let after = position + node.nodeSize - 1;
                for (let depth = selection.depth; depth > 0; depth--)
                  if (
                    selection.pos > position &&
                    selection.pos < position + node.nodeSize &&
                    selection.node(depth).type.name === "latexAlgorithmLine"
                  ) {
                    after = selection.after(depth);
                    break;
                  }
                editor
                  .chain()
                  .focus()
                  .insertContentAt(after, {
                    type: "latexAlgorithmLine",
                    attrs: { command: "State" },
                  })
                  .run();
              }}
            >
              Add step
            </button>
            <button type="button" disabled={!editable} onClick={deleteNode}>
              Delete algorithm
            </button>
          </div>
        </details>
      </LatexObjectToolbar>
    </NodeViewWrapper>
  );
}

function AlgorithmLineView({ node, editor, getPos }: NodeViewProps) {
  const layout = useEditorState({
    editor,
    selector: ({ editor }) => {
      const position = getPos();
      if (typeof position !== "number") return null;
      return (
        latexEquationReferencesKey.getState(editor.state)?.algorithmLines?.get(position) ?? null
      );
    },
  });
  const keyword = algorithmKeywords[String(node.attrs.command)] ?? algorithmKeywords.State!;
  return (
    <NodeViewWrapper
      className="scient-latex-algorithm-line"
      style={{ "--algorithm-indent": layout?.indent ?? 0 } as CSSProperties}
    >
      <span className="scient-latex-algorithm-number" contentEditable={false}>
        {layout?.number}
      </span>
      <div className="scient-latex-algorithm-line-body">
        {keyword.prefix && <strong contentEditable={false}>{keyword.prefix} </strong>}
        <NodeViewContent<"span"> as="span" className="scient-latex-algorithm-line-content" />
        {keyword.suffix && <strong contentEditable={false}> {keyword.suffix}</strong>}
      </div>
    </NodeViewWrapper>
  );
}

export const LatexAlgorithmLine = TiptapNode.create({
  name: "latexAlgorithmLine",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return { command: { default: "State" } };
  },
  parseHTML() {
    return [{ tag: "div[data-algorithm-line]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-algorithm-line": "" }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlgorithmLineView, { contentDOMElementTag: "span" });
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (this.editor.state.selection.$from.parent.type.name !== this.name) return false;
        return splitBlockAs(() => ({ type: this.type, attrs: { command: "State" } }))(
          this.editor.state,
          this.editor.view.dispatch,
        );
      },
    };
  },
});

export const LatexAlgorithmComment = TiptapNode.create({
  name: "latexAlgorithmComment",
  group: "inline",
  inline: true,
  content: "inline*",
  isolating: true,
  parseHTML() {
    return [{ tag: "span[data-algorithm-comment]" }];
  },
  renderHTML() {
    return ["span", { "data-algorithm-comment": "", class: "scient-latex-algorithm-comment" }, 0];
  },
});
