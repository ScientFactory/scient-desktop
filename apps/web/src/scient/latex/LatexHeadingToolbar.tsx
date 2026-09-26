import type { Editor } from "@tiptap/core";
import { LatexTextField } from "./LatexTextField";

export function LatexHeadingToolbar({ editor, draftKey }: { editor: Editor; draftKey: string }) {
  const heading = editor.getAttributes("heading");
  const { $from } = editor.state.selection;
  const position = $from.depth > 0 ? $from.before() : $from.pos;
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
          checked={!heading.unnumbered}
          onChange={(event) =>
            editor.commands.updateAttributes("heading", { unnumbered: !event.target.checked })
          }
        />
        Numbered
      </label>
      <label className="scient-latex-heading-reference">
        Reference label
        <LatexTextField
          key={position}
          aria-label="Heading reference label"
          rows={1}
          spellCheck={false}
          draftKey={`${draftKey}:heading:${position}:label`}
          value={String(heading.referenceLabel ?? "")}
          placeholder="sec:introduction"
          onValueChange={(referenceLabel) => {
            if (!/[{}\\%\s#$&~^]/u.test(referenceLabel))
              editor.commands.updateAttributes("heading", {
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
