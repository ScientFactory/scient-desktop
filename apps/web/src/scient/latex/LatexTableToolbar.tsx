import { useEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import {
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import {
  DockCommandCheckboxItem,
  DockCommandItem,
  DockCommandRadioItem,
  DockMenu,
  dockButtonClass,
} from "../writing/dockChrome";
import { LatexReferenceLabelControl } from "./LatexReferenceLabelControl";
import { useLatexObjectContext } from "./useLatexObjectContext";
import { LatexTableProperties } from "./LatexTableProperties";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { latexTableStructureEditable, type LatexTableAction } from "./latexTableAuthoring";
import { T, useGT } from "gt-react";

interface Props {
  source: string;
  onProperties: (action: LatexTableAction) => void;
  editor: Editor;
  tableRoot: RefObject<HTMLElement | null>;
  selected: boolean;
  editable: boolean;
  structureEditable: boolean;
  canMergeCells: boolean;
  canSplitCell: boolean;
  row: number;
  column: number;
  rowCount: number;
  columnCount: number;
  style: string;
  width: string;
  header: boolean;
  hasCaption: boolean;
  label: string;
  draftKey: string | undefined;
  captionEditable: boolean;
  labelEditable: boolean;
  onActiveChange: (active: boolean) => void;
  onAddRow: (after: number) => void;
  onRemoveRow: () => void;
  onMoveRow: (direction: -1 | 1) => void;
  onAddColumn: (after: number) => void;
  onRemoveColumn: () => void;
  onMoveColumn: (direction: -1 | 1) => void;
  onStyle: (value: string) => void;
  onWidth: (value: string) => void;
  onHeader: () => void;
  onEditCaption: () => void;
  onLabel: (value: string) => void;
  onDelete: () => void;
}

export function LatexTableToolbar(props: Props) {
  const gt = useGT();
  const { active, bar, id } = useLatexObjectContext(props.editor, props.tableRoot, props.selected);
  const onActiveChange = props.onActiveChange;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports toolbar active state to the parent through its imperative callback until unmount
  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);
  const host = active
    ? props.editor.view.dom
        .closest(".scient-latex-visual-workspace")
        ?.querySelector(".scient-latex-context-tools-slot")
    : null;
  if (!active || !host) return null;
  const readOnly = !props.editor.isEditable ? gt("This document is read-only.") : null;
  const contentReason =
    readOnly ?? (!props.editable ? gt("Edit this table's content in Source.") : null);
  const structureReason =
    contentReason ??
    (!props.structureEditable && !latexTableStructureEditable(props.source)
      ? gt("Edit this table's imported row and column structure in Source.")
      : null);
  const presentationReason =
    contentReason ??
    (!props.structureEditable ? gt("Use the column and border controls for this table.") : null);
  const rowAction = (
    operation: "insert-before" | "insert-after" | "previous" | "next" | "delete",
    legacy: () => void,
  ) => (props.structureEditable ? legacy() : props.onProperties({ kind: "row", operation }));
  const columnAction = (
    operation: "insert-before" | "insert-after" | "previous" | "next" | "delete",
    legacy: () => void,
  ) =>
    props.structureEditable
      ? legacy()
      : props.onProperties({ kind: "column-structure", operation });
  const action = (
    label: string,
    run: () => void,
    reason: string | null = readOnly,
    destructive = false,
  ) => (
    <DockCommandItem
      disabled={Boolean(reason)}
      aria-description={reason ?? undefined}
      variant={destructive ? "destructive" : "default"}
      onClick={run}
    >
      {label}
    </DockCommandItem>
  );
  return createPortal(
    <div
      ref={bar}
      className="scient-latex-context-toolbar scient-latex-table-context"
      data-context-presentation="inline"
      role="toolbar"
      aria-label={gt("Table tools")}
      onClick={(event) => event.stopPropagation()}
    >
      <DockMenu
        label={gt("Rows & columns")}
        icon={gt("Rows & columns")}
        commandScope="latex"
        side="top"
      >
        <MenuSub>
          <MenuSubTrigger id={`${id}-rows`}>
            <T>Rows</T>
          </MenuSubTrigger>
          <MenuSubPopup
            data-writing-menu-owner={`${id}-rows`}
            data-dock-command-scope="latex"
            data-keybinding-capture=""
          >
            {action(
              gt("Insert above"),
              () => rowAction("insert-before", () => props.onAddRow(props.row - 1)),
              structureReason,
            )}
            {action(
              gt("Insert below"),
              () => rowAction("insert-after", () => props.onAddRow(props.row)),
              structureReason,
            )}
            {action(
              gt("Move up"),
              () => rowAction("previous", () => props.onMoveRow(-1)),
              structureReason ?? (props.row === 0 ? gt("Already the first row.") : null),
            )}
            {action(
              gt("Move down"),
              () => rowAction("next", () => props.onMoveRow(1)),
              structureReason ??
                (props.row >= props.rowCount - 1 ? gt("Already the last row.") : null),
            )}
            <MenuSeparator />
            {action(
              gt("Delete row"),
              () => rowAction("delete", props.onRemoveRow),
              structureReason ?? (props.rowCount <= 1 ? gt("Keep at least one row.") : null),
              true,
            )}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger id={`${id}-columns`}>
            <T>Columns</T>
          </MenuSubTrigger>
          <MenuSubPopup
            data-writing-menu-owner={`${id}-columns`}
            data-dock-command-scope="latex"
            data-keybinding-capture=""
          >
            {action(
              gt("Insert left"),
              () => columnAction("insert-before", () => props.onAddColumn(props.column - 1)),
              structureReason,
            )}
            {action(
              gt("Insert right"),
              () => columnAction("insert-after", () => props.onAddColumn(props.column)),
              structureReason,
            )}
            {action(
              gt("Move left"),
              () => columnAction("previous", () => props.onMoveColumn(-1)),
              structureReason ?? (props.column === 0 ? gt("Already the first column.") : null),
            )}
            {action(
              gt("Move right"),
              () => columnAction("next", () => props.onMoveColumn(1)),
              structureReason ??
                (props.column >= props.columnCount - 1 ? gt("Already the last column.") : null),
            )}
            <MenuSeparator />
            {action(
              gt("Delete column"),
              () => columnAction("delete", props.onRemoveColumn),
              structureReason ?? (props.columnCount <= 1 ? gt("Keep at least one column.") : null),
              true,
            )}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        {action(gt("Delete table"), props.onDelete, readOnly, true)}
      </DockMenu>
      <DockMenu
        label={gt("Cells", { $context: "table cells menu" })}
        icon={gt("Cells", { $context: "table cells menu" })}
        commandScope="latex"
        side="top"
      >
        {action(
          gt("Merge cells"),
          () => props.onProperties({ kind: "merge" }),
          contentReason ?? (!props.canMergeCells ? gt("Select adjacent cells to merge.") : null),
        )}
        {action(
          gt("Split cell"),
          () => props.onProperties({ kind: "split" }),
          contentReason ?? (!props.canSplitCell ? gt("Choose a merged cell to split.") : null),
        )}
      </DockMenu>
      <DockMenu label={gt("Appearance")} icon={gt("Appearance")} commandScope="latex" side="top">
        <LatexTableProperties
          key={props.column}
          source={props.source}
          column={props.column}
          disabled={Boolean(contentReason)}
          hasCaption={props.hasCaption}
          apply={props.onProperties}
        >
          <MenuSub>
            <MenuSubTrigger id={`${id}-rules`} disabled={Boolean(presentationReason)}>
              <T context="table border rules">Rules</T>
            </MenuSubTrigger>
            <MenuSubPopup
              data-writing-menu-owner={`${id}-rules`}
              data-dock-command-scope="latex"
              data-keybinding-capture=""
            >
              <MenuRadioGroup value={props.style}>
                {[
                  { value: "plain", label: gt("Simple", { $context: "table rule style" }) },
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- the booktabs LaTeX package
                  { value: "booktabs", label: "Booktabs" },
                  { value: "grid", label: gt("Full grid") },
                ].map((option) => (
                  <DockCommandRadioItem
                    key={option.value}
                    value={option.value}
                    disabled={Boolean(presentationReason)}
                    aria-description={presentationReason ?? undefined}
                    onClick={() => props.onStyle(option.value)}
                  >
                    {option.label}
                  </DockCommandRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger
              id={`${id}-width`}
              disabled={Boolean(presentationReason) || props.width === "long"}
            >
              <T>Width</T>
            </MenuSubTrigger>
            <MenuSubPopup
              data-writing-menu-owner={`${id}-width`}
              data-dock-command-scope="latex"
              data-keybinding-capture=""
            >
              <MenuRadioGroup value={props.width}>
                {[
                  { value: "fixed", label: gt("Fit content") },
                  { value: "stretch", label: gt("Fit page") },
                  ...(props.width === "long" ? [{ value: "long", label: gt("Multipage") }] : []),
                ].map((option) => (
                  <DockCommandRadioItem
                    key={option.value}
                    value={option.value}
                    disabled={Boolean(presentationReason) || props.width === "long"}
                    onClick={() => props.onWidth(option.value)}
                  >
                    {option.label}
                  </DockCommandRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <DockCommandCheckboxItem
            variant="switch"
            checked={props.header}
            disabled={Boolean(presentationReason)}
            aria-description={presentationReason ?? undefined}
            onClick={props.onHeader}
          >
            <T>Header row</T>
          </DockCommandCheckboxItem>
        </LatexTableProperties>
      </DockMenu>
      <button
        type="button"
        className={dockButtonClass()}
        disabled={Boolean(contentReason) || !props.captionEditable}
        aria-label={props.hasCaption ? gt("Edit table caption") : gt("Add table caption")}
        aria-description={
          contentReason ??
          (!props.captionEditable ? gt("This table's caption setup requires Source.") : undefined)
        }
        onClick={props.onEditCaption}
      >
        <T>Caption</T>
      </button>
      {props.hasCaption && (
        <LatexReferenceLabelControl
          label={gt("Table reference label")}
          value={props.label}
          allowEmpty
          draftKey={props.draftKey}
          commitOn="blur"
          disabled={Boolean(contentReason) || !props.labelEditable}
          isAvailable={(value) =>
            !value ||
            value === props.label ||
            !latexEquationReferencesKey.getState(props.editor.state)?.labels.has(value)
          }
          onCommit={props.onLabel}
        />
      )}
    </div>,
    host,
  );
}
