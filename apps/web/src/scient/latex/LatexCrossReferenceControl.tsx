import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { LatexSelect } from "./LatexSelect";

/** Retarget a reference without changing its command or display text. */
export function LatexCrossReferenceControl(props: {
  editor: Editor;
  command: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const targets = useEditorState({
    editor: props.editor,
    selector: ({ editor }) => {
      const index = latexEquationReferencesKey.getState(editor.state);
      const entries = props.command === "hyperlink" ? index?.anchors : index?.labels;
      return [...(entries ?? [])]
        .filter(([, target]) =>
          props.command === "eqref"
            ? target.kind === "equation"
            : props.command === "subref"
              ? target.panelIndex !== undefined
              : true,
        )
        .map(([key, target]) => ({
          value: key,
          label: `${target.title || target.kind} ${target.number ?? ""} · ${key}`.trim(),
        }));
    },
  });
  const options = targets ?? [];
  const unresolved = !options.some((option) => option.value === props.value);
  return (
    <label>
      Target
      <LatexSelect
        aria-label="Cross-reference target"
        value={props.value}
        disabled={props.disabled}
        options={
          unresolved
            ? [
                {
                  value: props.value,
                  label: props.value ? `${props.value} · Unresolved` : "Choose a target",
                },
                ...options,
              ]
            : options
        }
        onValueChange={props.onChange}
      />
    </label>
  );
}
