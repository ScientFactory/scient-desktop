import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import { MenuRadioGroup, MenuSeparator, MenuCheckboxItem } from "~/components/ui/menu";
import { DockMenu, DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { LatexFooterSubmenu } from "./LatexFooterSubmenu";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { parseLatexListOptions } from "./latexListOptions";
import { useLatexActionNotice } from "./latexObjectAuthoring";
import { T, useGT } from "gt-react";

export function LatexListControls({ editor }: { editor: Editor }) {
  const gt = useGT();
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
    const current = editor.state.doc.nodeAt(list.position);
    if (current?.type.name !== "orderedList") return;
    const currentOptions = parseLatexListOptions(String(current.attrs.latexListOptions ?? ""));
    if (!currentOptions) return;
    const next = {
      ...currentOptions,
      start: Number(current.attrs.start ?? currentOptions.start),
      resume: current.attrs.resume === true,
      ...changes,
    };
    if (!Number.isSafeInteger(next.start) || next.start < 1) {
      setError(gt("Use a positive start number."));
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
        ...current.attrs,
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
      aria-label={gt("List options")}
      data-context-fallback=""
      data-context-presentation="inline"
      data-context-position={gt("List", { $context: "LaTeX list object" })}
      className="scient-latex-context-toolbar"
    >
      <DockMenu
        icon={undefined}
        label={gt("Numbering")}
        commandScope="latex"
        disabled={!parsed || !editor.isEditable}
      >
        <MenuRadioGroup value={parsed?.label ?? ""}>
          {[
            { value: "", label: gt("Document default") },
            { value: "\\arabic*.", label: "1. 2. 3." },
            { value: "\\alph*)", label: "a) b) c)" },
            { value: "\\Alph*.", label: "A. B. C." },
            // oxlint-disable-next-line t3code/no-untranslated-copy -- a numbering sample
            { value: "\\roman*.", label: "i. ii. iii." },
            // oxlint-disable-next-line t3code/no-untranslated-copy -- a numbering sample
            { value: "\\Roman*.", label: "I. II. III." },
            { value: "(\\arabic*)", label: "(1) (2) (3)" },
          ].map(({ value, label }) => (
            <DockCommandRadioItem
              key={value}
              value={value}
              size="compact"
              onClick={() => update({ label: value })}
            >
              {label}
            </DockCommandRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <LatexFooterSubmenu label={gt("Start at")}>
          <ListStartNumber
            key={`${list.position}:${list.node.attrs.start}`}
            value={Number(list.node.attrs.start ?? 1)}
            onChange={(start) => update({ start, resume: false })}
          />
        </LatexFooterSubmenu>
        <MenuCheckboxItem
          variant="switch"
          checked={list.node.attrs.resume === true}
          closeOnClick={false}
          onCheckedChange={(resume) => update({ resume })}
        >
          <T>Continue previous</T>
        </MenuCheckboxItem>
      </DockMenu>
    </div>
  );
}

function ListStartNumber(props: { value: number; onChange: (value: number) => void }) {
  const gt = useGT();
  const [draft, setDraft] = useState(String(props.value));
  const valid = /^\d+$/u.test(draft) && Number.isSafeInteger(Number(draft)) && Number(draft) > 0;
  return (
    <LatexContextMenuForm label={gt("List start number")} width="content">
      <Input
        size="compact"
        type="number"
        min={1}
        aria-label={gt("List start number")}
        value={draft}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onChange(Number(draft))}>
        <T>Apply</T>
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}
