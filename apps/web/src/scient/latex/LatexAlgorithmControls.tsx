import { useContext, useId, useMemo, type ReactNode } from "react";
import { useEditorState, type NodeViewProps } from "@tiptap/react";
import {
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import {
  DockCommandItem,
  DockCommandRadioItem,
  DockMenu,
  dockButtonClass,
} from "../writing/dockChrome";
import { LatexReferenceLabelControl } from "./LatexReferenceLabelControl";
import { LatexAuthoringContext, useLatexActionNotice } from "./latexObjectAuthoring";
import { latexLabelInventory } from "./latexLabelAuthoring";
import { algorithmStepSelection, type AlgorithmStepOperation } from "./latexAlgorithmEditing";
import { applyAlgorithmStepEdit } from "./latexAlgorithmCommands";

const steps = [
  { value: "State", label: "Step" },
  { value: "Return", label: "Return" },
  { value: "Require", label: "Input" },
  { value: "Ensure", label: "Output" },
  { value: "Statex", label: "Unnumbered step" },
];
const blocks = [
  { value: "If", label: "Condition" },
  { value: "For", label: "For loop" },
  { value: "ForAll", label: "For each loop" },
  { value: "While", label: "While loop" },
  { value: "Repeat", label: "Repeat until" },
  { value: "Loop", label: "Loop" },
];

function AlgorithmSubmenu(props: { label: string; disabled?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <MenuSub>
      <MenuSubTrigger id={id} disabled={props.disabled}>
        {props.label}
      </MenuSubTrigger>
      <MenuSubPopup
        data-writing-menu-owner={id}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
      >
        {props.children}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Compact algorithm commands use the same menus and selection ownership as figures and tables. */
export function LatexAlgorithmControls({
  node,
  editor,
  getPos,
  updateAttributes,
  editable,
  draftKey,
  onCaption,
}: Pick<NodeViewProps, "node" | "editor" | "getPos" | "updateAttributes"> & {
  editable: boolean;
  draftKey?: string | undefined;
  onCaption: () => void;
}) {
  const context = useContext(LatexAuthoringContext);
  const report = useLatexActionNotice();
  const labels = useMemo(() => latexLabelInventory(context.source), [context.source]);
  const active = useEditorState({
    editor,
    selector: ({ editor }) => {
      const position = getPos();
      if (typeof position !== "number") return null;
      const current = editor.state.doc.nodeAt(position);
      const selection =
        current && algorithmStepSelection(current, position, editor.state.selection);
      if (!current || !selection) return null;
      let comment = false;
      current.child(selection.first).forEach((child) => {
        if (child.type.name === "latexAlgorithmComment") comment = true;
      });
      return { selection, comment };
    },
  });
  const run = (operation: AlgorithmStepOperation, kind?: string) => {
    if (!editable || !editor.isEditable || !context.prepare()) return;
    const at = getPos();
    if (typeof at !== "number") return;
    report(applyAlgorithmStepEdit(editor, at, operation, kind));
  };
  const property = (attrs: { interval?: number; placement?: string; label?: string }) => {
    if (!editable || !editor.isEditable || !context.prepare()) return;
    const at = getPos();
    const current = typeof at === "number" ? editor.state.doc.nodeAt(at) : null;
    if (current?.attrs.layout?.kind !== "algorithm") return;
    updateAttributes({ layout: { ...current.attrs.layout, ...attrs } });
  };
  const floating = node.attrs.layout.floating !== false;
  const captioned = node.attrs.layout.captioned === true;
  const label = String(node.attrs.layout.label ?? "");
  const interval = Number(node.attrs.layout.interval ?? 0);
  const placement = String(node.attrs.layout.placement ?? "");
  const placements = [
    { value: "", label: "Automatic" },
    { value: "t", label: "Top" },
    { value: "b", label: "Bottom" },
    { value: "H", label: "Here" },
  ];
  if (!placements.some((option) => option.value === placement))
    placements.push({ value: placement, label: placement === "htbp" ? "Prefer here" : "Custom" });
  const selection = active?.selection;
  return (
    <>
      <DockMenu label="Algorithm steps" icon="Steps" commandScope="latex" disabled={!editable}>
        <AlgorithmSubmenu label="Insert" disabled={!selection}>
          {steps.map((option) => (
            <DockCommandItem key={option.value} onClick={() => run("add", option.value)}>
              {option.label}
            </DockCommandItem>
          ))}
          <MenuSeparator />
          {blocks.map((option) => (
            <DockCommandItem key={option.value} onClick={() => run("add", option.value)}>
              {option.label}
            </DockCommandItem>
          ))}
        </AlgorithmSubmenu>
        <AlgorithmSubmenu label="Wrap" disabled={!selection}>
          {blocks.map((option) => (
            <DockCommandItem key={option.value} onClick={() => run("wrap", option.value)}>
              {option.label}
            </DockCommandItem>
          ))}
        </AlgorithmSubmenu>
        <DockCommandItem
          disabled={!selection || selection.first !== selection.last}
          onClick={() => run("comment")}
        >
          {active?.comment ? "Edit comment" : "Add comment"}
        </DockCommandItem>
        <AlgorithmSubmenu label="Add branch" disabled={selection?.condition == null}>
          <DockCommandItem
            disabled={!selection || selection.elseAt >= 0}
            onClick={() => run("else")}
          >
            Else
          </DockCommandItem>
          <DockCommandItem onClick={() => run("elseif")}>Else if</DockCommandItem>
        </AlgorithmSubmenu>
        <MenuSeparator />
        <DockCommandItem disabled={!selection?.up} onClick={() => run("up")}>
          Move up
        </DockCommandItem>
        <DockCommandItem disabled={!selection?.down} onClick={() => run("down")}>
          Move down
        </DockCommandItem>
        <DockCommandItem variant="destructive" disabled={!selection} onClick={() => run("remove")}>
          Delete step
        </DockCommandItem>
      </DockMenu>
      <DockMenu
        label="Algorithm appearance"
        icon="Appearance"
        commandScope="latex"
        disabled={!editable}
      >
        <MenuCheckboxItem
          variant="switch"
          checked={interval > 0}
          disabled={!editable}
          closeOnClick={false}
          onCheckedChange={(checked) => property({ interval: checked ? 1 : 0 })}
        >
          Line numbers
        </MenuCheckboxItem>
        {floating && (
          <AlgorithmSubmenu label="Placement">
            <MenuRadioGroup value={placement}>
              {placements.map((option) => (
                <DockCommandRadioItem
                  key={option.value}
                  value={option.value}
                  onClick={() => property({ placement: option.value })}
                >
                  {option.label}
                </DockCommandRadioItem>
              ))}
            </MenuRadioGroup>
          </AlgorithmSubmenu>
        )}
      </DockMenu>
      {floating && (
        <button
          className={dockButtonClass()}
          type="button"
          disabled={!editable}
          aria-label={captioned ? "Edit algorithm caption" : "Add algorithm caption"}
          onClick={onCaption}
        >
          Caption
        </button>
      )}
      {floating && captioned && (
        <LatexReferenceLabelControl
          label="Algorithm reference label"
          allowEmpty
          value={label}
          draftKey={draftKey && `${draftKey}:label`}
          commitOn="blur"
          disabled={!editable}
          isAvailable={(value) =>
            !value || value === label || !labels.targets.some((target) => target.key === value)
          }
          onCommit={(value, fieldId) => {
            if (value === label) return;
            if (label && value && context.renameLabel) context.renameLabel(label, value, fieldId);
            else property({ label: value });
          }}
        />
      )}
    </>
  );
}
