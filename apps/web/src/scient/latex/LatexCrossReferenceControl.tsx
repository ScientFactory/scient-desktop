import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import { MenuRadioGroup } from "~/components/ui/menu";
import { DockMenu, DockCommandRadioItem } from "../writing/dockChrome";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { useGT } from "gt-react";

/** Retarget a reference without changing its command or display text. */
export function LatexCrossReferenceControl(props: {
  editor: Editor;
  command: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
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
    <DockMenu
      icon={undefined}
      label={gt("Target", { $context: "cross-reference target" })}
      commandScope="latex"
      disabled={props.disabled}
    >
      <LatexContextMenuForm label={gt("Find reference target")}>
        <Input
          size="compact"
          type="search"
          aria-label={gt("Find reference target")}
          placeholder={gt("Search targets")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </LatexContextMenuForm>
      <MenuRadioGroup value={props.value}>
        {unresolved && props.value && (
          <DockCommandRadioItem value={props.value} disabled size="compact" onClick={() => {}}>
            {props.value}
          </DockCommandRadioItem>
        )}
        {options
          .filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
          .map((option) => (
            <DockCommandRadioItem
              key={option.value}
              value={option.value}
              size="compact"
              onClick={() => props.onChange(option.value)}
            >
              <span className="truncate">{option.label}</span>
            </DockCommandRadioItem>
          ))}
      </MenuRadioGroup>
    </DockMenu>
  );
}
