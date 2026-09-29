import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { LatexTextField } from "./LatexTextField";

export function LatexHeadingToolbar({ editor, draftKey }: { editor: Editor; draftKey: string }) {
  const heading = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { $from } = current.state.selection;
      const position = $from.depth > 0 ? $from.before() : $from.pos;
      const node = current.state.doc.nodeAt(position);
      return node?.type.name === "heading"
        ? {
            position,
            numbered: node.attrs.unnumbered !== true,
            referenceLabel: String(node.attrs.referenceLabel ?? ""),
          }
        : null;
    },
  });
  if (!heading) return null;
  const updateHeading = (attributes: Record<string, unknown>) => {
    const node = editor.state.doc.nodeAt(heading.position);
    if (node?.type.name !== "heading") return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(heading.position, undefined, {
        ...node.attrs,
        ...attributes,
      }),
    );
  };
  return (
    <div
      role="toolbar"
      aria-label="Heading options"
      className="scient-latex-context-toolbar scient-latex-heading-bar"
    >
      <span className="scient-latex-context-label">Heading</span>
      <label className="scient-latex-title-author-toggle">
        <input
          type="checkbox"
          checked={heading.numbered}
          onChange={(event) => updateHeading({ unnumbered: !event.currentTarget.checked })}
        />
        Numbered
      </label>
      <label className="scient-latex-heading-reference">
        Reference label
        <LatexTextField
          key={heading.position}
          aria-label="Heading reference label"
          rows={1}
          spellCheck={false}
          draftKey={`${draftKey}:heading:${heading.position}:label`}
          value={heading.referenceLabel}
          placeholder="sec:introduction"
          onValueChange={(referenceLabel) => {
            if (!/[{}\\%\s#$&~^]/u.test(referenceLabel))
              updateHeading({
                referenceLabel: referenceLabel || null,
              });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              editor.commands.focus(undefined, { scrollIntoView: false });
            }
          }}
        />
      </label>
    </div>
  );
}
