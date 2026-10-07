import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { LatexSelect } from "./LatexSelect";

/** Conversion choices use definitions already available in this document. */
export function LatexStatementTypeControl(props: {
  editor: Editor;
  environment: string;
  disabled: boolean;
  onChange: (environment: string) => void;
}) {
  const declarations = useEditorState({
    editor: props.editor,
    selector: ({ editor }) => latexEquationReferencesKey.getState(editor.state)?.environments ?? [],
  });
  const options = (declarations ?? [])
    .filter((item) => item.kind === "theorem" || item.name === props.environment)
    .map((item) => ({ value: item.name, label: item.title || item.name }));
  if (!options.some((option) => option.value === props.environment))
    options.push({
      value: props.environment,
      label: props.environment[0]!.toUpperCase() + props.environment.slice(1),
    });
  return (
    <label>
      Statement type
      <LatexSelect
        aria-label="Scientific statement type"
        value={props.environment}
        disabled={props.disabled || options.length === 1}
        onValueChange={props.onChange}
        options={options}
      />
    </label>
  );
}
