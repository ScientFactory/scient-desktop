import { useContext, useRef, useState, type CSSProperties } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { LatexObjectToolbar } from "./LatexObjectToolbar";
import { LatexTextField } from "./LatexTextField";
import { latexColorCss, latexColorBoxOpening } from "./latexColorBoxes";
import { LatexColorControl } from "./LatexColorControl";
import { LatexContextSection } from "./LatexContextAction";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { setLatexEnvironmentOption } from "./latexObjectProperties";
import { LatexLengthField } from "./LatexLengthField";

export function LatexColorBoxView({
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
> & {
  editable: boolean;
  draftKey?: string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layout = node.attrs.layout;
  const context = useContext(LatexAuthoringContext);
  const setError = useLatexActionNotice();
  const [padding, setPadding] = useState(String(layout.padding ?? "3mm"));
  const [border, setBorder] = useState(String(layout.borderWidth ?? "0.5mm"));
  const [radius, setRadius] = useState(String(layout.radius ?? "1mm"));
  const option = (name: string, value: string | null) => {
    if (context.prepare())
      setError(
        editLatexObjectSource(editor, getPos(), context.source, (source) =>
          setLatexEnvironmentOption(source, "tcolorbox", name, value),
        ),
      );
  };
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
          "--scient-box-padding": layout.padding,
          borderWidth: layout.borderWidth,
          borderRadius: layout.radius,
        } as CSSProperties
      }
    >
      {(node.attrs.title !== "" || latexColorBoxOpening(String(node.attrs.raw))?.titleRange) && (
        <div
          className="scient-latex-color-box-title"
          contentEditable={false}
          style={{ fontWeight: layout.boldTitle ? 700 : 400 }}
        >
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
        <LatexContextSection title="Title & color">
          {!node.attrs.title && (
            <button type="button" disabled={!editable} onClick={() => option("title", "{}")}>
              Add title field
            </button>
          )}
          <LatexColorControl
            label="Box background"
            value={layout.colback}
            disabled={!editable}
            onApply={(value) => option("colback", value || null)}
          />
          <LatexColorControl
            label="Box border"
            value={layout.colframe}
            disabled={!editable}
            onApply={(value) => option("colframe", value || null)}
          />
          <LatexColorControl
            label="Box title color"
            value={layout.coltitle}
            disabled={!editable}
            onApply={(value) => option("coltitle", value || null)}
          />
          <label>
            <input
              type="checkbox"
              checked={layout.boldTitle === true}
              disabled={!editable}
              onChange={(event) =>
                option("fonttitle", event.target.checked ? "\\bfseries" : "\\mdseries")
              }
            />
            Bold title
          </label>
        </LatexContextSection>
        <LatexContextSection title="Spacing & page breaking">
          <LatexLengthField
            label="Box padding"
            value={padding}
            onChange={setPadding}
            disabled={!editable}
          />
          <button type="button" disabled={!editable} onClick={() => option("boxsep", padding)}>
            Apply padding
          </button>
          <LatexLengthField
            label="Box border width"
            value={border}
            onChange={setBorder}
            disabled={!editable}
          />
          <button type="button" disabled={!editable} onClick={() => option("boxrule", border)}>
            Apply border
          </button>
          <LatexLengthField
            label="Corner radius"
            value={radius}
            onChange={setRadius}
            disabled={!editable}
          />
          <button type="button" disabled={!editable} onClick={() => option("arc", radius)}>
            Apply corners
          </button>
          <label>
            <input
              type="checkbox"
              checked={layout.breakable}
              disabled={!editable}
              onChange={(event) => option("breakable", event.target.checked ? "" : null)}
            />
            Allow page breaks
          </label>
        </LatexContextSection>
        <div className="scient-latex-context-menu-panel">
          <button type="button" disabled={!editable} onClick={deleteNode}>
            Delete box
          </button>
        </div>
      </LatexObjectToolbar>
    </NodeViewWrapper>
  );
}
