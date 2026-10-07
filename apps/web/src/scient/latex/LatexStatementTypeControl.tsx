import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { MenuRadioGroup } from "~/components/ui/menu";
import { DockCommandRadioItem, DockMenu } from "../writing/dockChrome";

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
    <DockMenu
      label="Scientific statement type"
      commandScope="latex"
      disabled={props.disabled || options.length === 1}
      chevron
      icon={
        <span className="grid text-left">
          <span className="col-start-1 row-start-1">
            {options.find((option) => option.value === props.environment)?.label}
          </span>
          <span
            aria-hidden="true"
            className="invisible pointer-events-none col-start-1 row-start-1 grid"
          >
            {options.map((option) => (
              <span key={option.value} className="col-start-1 row-start-1">
                {option.label}
              </span>
            ))}
          </span>
        </span>
      }
    >
      <MenuRadioGroup value={props.environment}>
        {options.map((option) => (
          <DockCommandRadioItem
            key={option.value}
            value={option.value}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </DockCommandRadioItem>
        ))}
      </MenuRadioGroup>
    </DockMenu>
  );
}
