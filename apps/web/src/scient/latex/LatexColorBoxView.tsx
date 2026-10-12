import { useContext, useRef, useState, type CSSProperties } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { LatexObjectToolbar } from "./LatexObjectToolbar";
import { LatexStatementTitle } from "./LatexStatementTitle";
import { LatexBoxControls } from "./LatexBoxControls";
import { latexColorCss, latexColorBoxOpening } from "./latexColorBoxes";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { setLatexEnvironmentOption } from "./latexObjectProperties";
import { enterLatexObjectBody } from "./latexObjectCaret";
import { escapeText } from "./latexVisualDocument";

export function LatexColorBoxView({
  node,
  editor,
  selected,
  getPos,
  updateAttributes,
  editable,
  draftKey,
}: Pick<NodeViewProps, "node" | "editor" | "selected" | "getPos" | "updateAttributes"> & {
  editable: boolean;
  draftKey?: string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layout = node.attrs.layout;
  const context = useContext(LatexAuthoringContext);
  const report = useLatexActionNotice();
  const [titleEditing, setTitleEditing] = useState(false);
  const title = String(node.attrs.title ?? "");
  const hasTitle = Boolean(
    title || (!node.attrs.titleRemoved && latexColorBoxOpening(String(node.attrs.raw))?.titleRange),
  );
  const option = (name: string, value: string | null) => {
    if (!editable || !editor.isEditable || !context.prepare()) return;
    report(
      editLatexObjectSource(editor, getPos(), context.source, (source) =>
        setLatexEnvironmentOption(source, "tcolorbox", name, value),
      ),
    );
  };
  const enterBody = () => {
    const at = getPos();
    if (typeof at === "number") enterLatexObjectBody(editor.view, at);
  };
  return (
    <NodeViewWrapper
      ref={root}
      className="scient-latex-color-box"
      data-breakable={layout.breakable || undefined}
      data-split={node.firstChild?.attrs.layout?.kind === "boxRegion" || undefined}
      style={
        {
          "--scient-box-background": latexColorCss(layout.colback),
          "--scient-box-frame": latexColorCss(layout.colframe),
          "--scient-box-title": latexColorCss(layout.coltitle),
          "--scient-box-padding": layout.padding,
          borderWidth: layout.frameHidden && !layout.borderColor ? "0px" : layout.borderWidth,
          borderStyle: layout.borderStyle,
          ...(layout.borderSide === "west"
            ? { borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 }
            : {}),
          borderColor: latexColorCss(layout.borderColor || layout.colframe),
          borderRadius: layout.radius,
          boxShadow: layout.shadow ? "1mm 1mm 1mm #00000040" : undefined,
          textAlign: layout.alignment,
        } as CSSProperties
      }
    >
      {(hasTitle || titleEditing) && (
        <div
          className="scient-latex-color-box-title"
          contentEditable={false}
          style={{ fontWeight: layout.boldTitle ? 700 : 400 }}
        >
          <LatexStatementTitle
            editor={editor}
            label="Box title"
            value={title}
            source={node.attrs.titleSource ?? escapeText(title)}
            editing={titleEditing}
            editable={editable}
            draftKey={draftKey && draftKey + ":title"}
            onEditing={setTitleEditing}
            onChange={(title) =>
              updateAttributes({ title, titleSource: null, titleRemoved: title === "" })
            }
            onExit={enterBody}
          />
        </div>
      )}
      <NodeViewContent className="scient-latex-color-box-body" aria-label="Box content" />
      <LatexObjectToolbar
        editor={editor}
        root={root}
        selected={selected}
        label="Box tools"
        position="Box"
        inline
      >
        <LatexBoxControls
          editable={editable}
          hasTitle={hasTitle}
          background={layout.colback}
          border={layout.colframe}
          borderWidth={layout.borderWidth}
          radius={layout.radius}
          padding={layout.padding}
          breakable={layout.breakable}
          onOption={option}
          onTitle={() => {
            if (!editable) return;
            setTitleEditing(true);
            requestAnimationFrame(() => {
              const field = root.current?.querySelector<HTMLTextAreaElement>(
                '[aria-label="Box title"]',
              );
              field?.focus({ preventScroll: true });
              field?.setSelectionRange(0, 0);
            });
          }}
        />
      </LatexObjectToolbar>
    </NodeViewWrapper>
  );
}
