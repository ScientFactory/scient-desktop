import { useRef, useState, type CSSProperties } from "react";
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
import { LatexAlgorithmControls } from "./LatexAlgorithmControls";
import { enterLatexObjectBody } from "./latexObjectCaret";
import { deleteEmptyAlgorithmStructure } from "./latexAlgorithmCommands";

export function LatexAlgorithmView({
  node,
  editor,
  selected,
  getPos,
  updateAttributes,
  editable,
  draftKey,
}: Pick<
  NodeViewProps,
  "node" | "editor" | "selected" | "getPos" | "updateAttributes" | "deleteNode"
> & { editable: boolean; draftKey?: string | undefined }) {
  const root = useRef<HTMLDivElement>(null);
  const [captionEditing, setCaptionEditing] = useState(false);
  const floating = node.attrs.layout.floating !== false;
  const captioned = node.attrs.layout.captioned === true;
  const caption = (title: string) =>
    updateAttributes({
      title,
      layout: {
        ...node.attrs.layout,
        captioned: title !== "",
        ...(title === "" ? { label: "" } : {}),
      },
    });
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
    <NodeViewWrapper
      ref={root}
      className="scient-latex-algorithm"
      data-floating={floating || undefined}
    >
      {floating && (captioned || captionEditing) && (
        <div className="scient-latex-algorithm-caption" contentEditable={false}>
          {captioned && <strong>Algorithm{number ? ` ${number}` : ""}</strong>}
          <LatexTextField
            aria-label="Algorithm caption"
            rows={1}
            value={String(node.attrs.title)}
            draftKey={draftKey && `${draftKey}:caption`}
            disabled={!editable}
            onFocus={() => setCaptionEditing(true)}
            onBlur={() => setCaptionEditing(false)}
            onValueChange={caption}
            onRemoveEmpty={() => {
              caption("");
              setCaptionEditing(false);
              const at = getPos();
              if (typeof at === "number") enterLatexObjectBody(editor.view, at);
            }}
          />
        </div>
      )}
      <NodeViewContent
        className="scient-latex-algorithm-body"
        aria-label="Pseudocode"
        data-latex-text-style={node.attrs.layout.fontSize ?? undefined}
      />
      <LatexObjectToolbar
        editor={editor}
        root={root}
        selected={selected}
        label="Algorithm tools"
        inline
      >
        <LatexAlgorithmControls
          node={node}
          editor={editor}
          getPos={getPos}
          updateAttributes={updateAttributes}
          editable={editable}
          draftKey={draftKey}
          onCaption={() => {
            setCaptionEditing(true);
            requestAnimationFrame(() =>
              root.current
                ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Algorithm caption"]')
                ?.focus({ preventScroll: true }),
            );
          }}
        />
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
      Backspace: () => deleteEmptyAlgorithmStructure(this.editor),
      Delete: () => deleteEmptyAlgorithmStructure(this.editor),
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
