import { msg, T, useGT, useMessages } from "gt-react";
import { useContext, useId, type ReactNode } from "react";
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

/** `label`s are `msg()` strings, resolved where the menu renders. */
const steps = [
  { value: "State", label: msg("Step", { $context: "algorithm step" }) },
  { value: "Return", label: msg("Return", { $context: "algorithm step" }) },
  { value: "Require", label: msg("Input", { $context: "algorithm step" }) },
  { value: "Ensure", label: msg("Output", { $context: "algorithm step" }) },
  { value: "Statex", label: msg("Unnumbered step", { $context: "algorithm step" }) },
];
const blocks = [
  { value: "If", label: msg("Condition", { $context: "algorithm step" }) },
  { value: "For", label: msg("For loop", { $context: "algorithm step" }) },
  { value: "ForAll", label: msg("For each loop", { $context: "algorithm step" }) },
  { value: "While", label: msg("While loop", { $context: "algorithm step" }) },
  { value: "Repeat", label: msg("Repeat until", { $context: "algorithm step" }) },
  { value: "Loop", label: msg("Loop", { $context: "algorithm step" }) },
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
  const gt = useGT();
  const messages = useMessages();
  const context = useContext(LatexAuthoringContext);
  const report = useLatexActionNotice();
  const labels = latexLabelInventory(context.source);
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
    { value: "", label: gt("Automatic") },
    { value: "t", label: gt("Top", { $context: "float placement" }) },
    { value: "b", label: gt("Bottom", { $context: "float placement" }) },
    { value: "H", label: gt("Here", { $context: "float placement" }) },
  ];
  if (!placements.some((option) => option.value === placement))
    placements.push({
      value: placement,
      label:
        placement === "htbp"
          ? gt("Prefer here")
          : gt("Custom", { $context: "custom float placement" }),
    });
  const selection = active?.selection;
  return (
    <>
      <DockMenu
        label={gt("Algorithm steps")}
        icon={gt("Steps", { $context: "algorithm steps menu" })}
        commandScope="latex"
        disabled={!editable}
      >
        <AlgorithmSubmenu
          label={gt("Insert", { $context: "insert algorithm step" })}
          disabled={!selection}
        >
          {steps.map((option) => (
            <DockCommandItem key={option.value} onClick={() => run("add", option.value)}>
              {messages(option.label)}
            </DockCommandItem>
          ))}
          <MenuSeparator />
          {blocks.map((option) => (
            <DockCommandItem key={option.value} onClick={() => run("add", option.value)}>
              {messages(option.label)}
            </DockCommandItem>
          ))}
        </AlgorithmSubmenu>
        <AlgorithmSubmenu
          label={gt("Wrap", { $context: "wrap algorithm steps in a block" })}
          disabled={!selection}
        >
          {blocks.map((option) => (
            <DockCommandItem key={option.value} onClick={() => run("wrap", option.value)}>
              {messages(option.label)}
            </DockCommandItem>
          ))}
        </AlgorithmSubmenu>
        <DockCommandItem
          disabled={!selection || selection.first !== selection.last}
          onClick={() => run("comment")}
        >
          {active?.comment ? gt("Edit comment") : gt("Add comment")}
        </DockCommandItem>
        <AlgorithmSubmenu label={gt("Add branch")} disabled={selection?.condition == null}>
          <DockCommandItem
            disabled={!selection || selection.elseAt >= 0}
            onClick={() => run("else")}
          >
            <T context="algorithm else branch">Else</T>
          </DockCommandItem>
          <DockCommandItem onClick={() => run("elseif")}>
            <T context="algorithm else-if branch">Else if</T>
          </DockCommandItem>
        </AlgorithmSubmenu>
        <MenuSeparator />
        <DockCommandItem disabled={!selection?.up} onClick={() => run("up")}>
          <T>Move up</T>
        </DockCommandItem>
        <DockCommandItem disabled={!selection?.down} onClick={() => run("down")}>
          <T>Move down</T>
        </DockCommandItem>
        <DockCommandItem variant="destructive" disabled={!selection} onClick={() => run("remove")}>
          <T>Delete step</T>
        </DockCommandItem>
      </DockMenu>
      <DockMenu
        label={gt("Algorithm appearance")}
        icon={gt("Appearance")}
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
          <T>Line numbers</T>
        </MenuCheckboxItem>
        {floating && (
          <AlgorithmSubmenu label={gt("Placement")}>
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
          aria-label={captioned ? gt("Edit algorithm caption") : gt("Add algorithm caption")}
          onClick={onCaption}
        >
          <T>Caption</T>
        </button>
      )}
      {floating && captioned && (
        <LatexReferenceLabelControl
          label={gt("Algorithm reference label")}
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
