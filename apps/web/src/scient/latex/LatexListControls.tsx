import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { LatexSelect } from "./LatexSelect";
import { parseLatexListOptions } from "./latexListOptions";
import { useLatexActionNotice } from "./latexObjectAuthoring";

export function LatexListControls({ editor }: { editor: Editor }) {
  const list = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { $from } = current.state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === "orderedList") return { node, position: $from.before(depth) };
      }
      return null;
    },
  });
  const setError = useLatexActionNotice();
  if (!list) return null;
  const parsed = parseLatexListOptions(String(list.node.attrs.latexListOptions ?? ""));
  const update = (changes: { start?: number; resume?: boolean; label?: string }) => {
    if (!parsed || !editor.isEditable) return;
    const next = {
      ...parsed,
      start: Number(list.node.attrs.start ?? parsed.start),
      resume: list.node.attrs.resume === true,
      ...changes,
    };
    if (!Number.isSafeInteger(next.start) || next.start < 1) {
      setError("Use a positive start number.");
      return;
    }
    const options = [
      next.resume ? "resume" : next.start !== 1 ? `start=${next.start}` : "",
      next.label ? `label=${next.label}` : "",
    ]
      .filter(Boolean)
      .join(",");
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(list.position, undefined, {
        ...list.node.attrs,
        start: next.start,
        resume: next.resume,
        latexListOptions: options || null,
      }),
    );
    setError(null);
  };
  return (
    <div
      role="toolbar"
      aria-label="List options"
      data-context-fallback=""
      className="scient-latex-context-toolbar"
    >
      <label>
        Numbering
        <LatexSelect
          aria-label="List numbering format"
          disabled={!parsed || !editor.isEditable}
          value={parsed?.label ?? ""}
          onValueChange={(label) => update({ label })}
          options={[
            { value: "", label: "Document default" },
            { value: "\\arabic*.", label: "1. 2. 3." },
            { value: "\\alph*)", label: "a) b) c)" },
            { value: "\\Alph*.", label: "A. B. C." },
            { value: "\\roman*.", label: "i. ii. iii." },
            { value: "(\\arabic*)", label: "(1) (2) (3)" },
          ]}
        />
      </label>
      <label>
        Start at
        <input
          aria-label="List start number"
          type="number"
          min={1}
          defaultValue={Number(list.node.attrs.start ?? 1)}
          key={list.position}
          disabled={!parsed || !editor.isEditable}
          onBlur={(event) => update({ start: Number(event.target.value), resume: false })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={list.node.attrs.resume === true}
          disabled={!parsed || !editor.isEditable}
          onChange={(event) => update({ resume: event.target.checked })}
        />
        Continue previous list
      </label>
    </div>
  );
}
