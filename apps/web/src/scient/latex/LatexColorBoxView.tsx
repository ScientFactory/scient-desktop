import { useRef, type CSSProperties } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { LatexObjectToolbar } from "./LatexObjectToolbar";
import { LatexTextField } from "./LatexTextField";
import { latexColorCss, latexColorBoxOpening } from "./latexColorBoxes";

export function LatexColorBoxView({
  node,
  editor,
  selected,
  updateAttributes,
  deleteNode,
  editable,
  draftKey,
}: Pick<NodeViewProps, "node" | "editor" | "selected" | "updateAttributes" | "deleteNode"> & {
  editable: boolean;
  draftKey?: string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layout = node.attrs.layout;
  return (
    <NodeViewWrapper
      ref={root}
      className="scient-latex-color-box"
      data-breakable={layout.breakable || undefined}
      style={
        {
          "--scient-box-background": latexColorCss(layout.colback),
          "--scient-box-frame": latexColorCss(layout.colframe),
          "--scient-box-title": latexColorCss(layout.coltitle),
        } as CSSProperties
      }
    >
      {(node.attrs.title !== "" || latexColorBoxOpening(String(node.attrs.raw))?.titleRange) && (
        <div className="scient-latex-color-box-title" contentEditable={false}>
          <LatexTextField
            aria-label="Box title"
            value={String(node.attrs.title)}
            rows={1}
            disabled={!editable}
            draftKey={draftKey && `${draftKey}:title`}
            onValueChange={(title) => updateAttributes({ title })}
          />
        </div>
      )}
      <NodeViewContent className="scient-latex-color-box-body" aria-label="Box content" />
      <LatexObjectToolbar editor={editor} root={root} selected={selected} label="Box tools">
        <details className="scient-latex-context-menu">
          <summary>Box options</summary>
          <div className="scient-latex-context-menu-panel">
            <p>
              {layout.breakable
                ? "This box can continue onto the next page."
                : "This box stays together on the page."}
            </p>
            {String(node.attrs.raw).includes("\\loop") && (
              <p>
                Editing a generated paragraph expands its loop into individual editable paragraphs
                in Source.
              </p>
            )}
            <button type="button" disabled={!editable} onClick={deleteNode}>
              Delete box
            </button>
          </div>
        </details>
      </LatexObjectToolbar>
    </NodeViewWrapper>
  );
}
