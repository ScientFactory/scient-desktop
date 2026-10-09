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
import { LatexReferenceLabelPopover } from "./LatexReferenceLabelPopover";
import { useLatexObjectContext } from "./useLatexObjectContext";
import { LatexTableProperties } from "./LatexTableProperties";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { latexTableStructureEditable, type LatexTableAction } from "./latexTableAuthoring";

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
  const { active, bar, id } = useLatexObjectContext(props.editor, props.tableRoot, props.selected);
  const onActiveChange = props.onActiveChange;
  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);
  const host = props.editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  if (!active || !host) return null;
  const readOnly = !props.editor.isEditable ? "This document is read-only." : null;
  const contentReason =
    readOnly ?? (!props.editable ? "Edit this table's content in Source." : null);
  const structureReason =
    contentReason ??
    (!props.structureEditable && !latexTableStructureEditable(props.source)
      ? "Edit this table's imported row and column structure in Source."
      : null);
  const presentationReason =
    contentReason ??
    (!props.structureEditable ? "Use the column and border controls for this table." : null);
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
      aria-label="Table tools"
      onClick={(event) => event.stopPropagation()}
    >
      <DockMenu label="Rows & columns" icon="Rows & columns" commandScope="latex" side="top">
        <MenuSub>
          <MenuSubTrigger id={`${id}-rows`}>Rows</MenuSubTrigger>
          <MenuSubPopup
            data-writing-menu-owner={`${id}-rows`}
            data-dock-command-scope="latex"
            data-keybinding-capture=""
          >
            {action(
              "Insert above",
              () => rowAction("insert-before", () => props.onAddRow(props.row - 1)),
              structureReason,
            )}
            {action(
              "Insert below",
              () => rowAction("insert-after", () => props.onAddRow(props.row)),
              structureReason,
            )}
            {action(
              "Move up",
              () => rowAction("previous", () => props.onMoveRow(-1)),
              structureReason ?? (props.row === 0 ? "Already the first row." : null),
            )}
            {action(
              "Move down",
              () => rowAction("next", () => props.onMoveRow(1)),
              structureReason ?? (props.row >= props.rowCount - 1 ? "Already the last row." : null),
            )}
            <MenuSeparator />
            {action(
              "Delete row",
              () => rowAction("delete", props.onRemoveRow),
              structureReason ?? (props.rowCount <= 1 ? "Keep at least one row." : null),
              true,
            )}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger id={`${id}-columns`}>Columns</MenuSubTrigger>
          <MenuSubPopup
            data-writing-menu-owner={`${id}-columns`}
            data-dock-command-scope="latex"
            data-keybinding-capture=""
          >
            {action(
              "Insert left",
              () => columnAction("insert-before", () => props.onAddColumn(props.column - 1)),
              structureReason,
            )}
            {action(
              "Insert right",
              () => columnAction("insert-after", () => props.onAddColumn(props.column)),
              structureReason,
            )}
            {action(
              "Move left",
              () => columnAction("previous", () => props.onMoveColumn(-1)),
              structureReason ?? (props.column === 0 ? "Already the first column." : null),
            )}
            {action(
              "Move right",
              () => columnAction("next", () => props.onMoveColumn(1)),
              structureReason ??
                (props.column >= props.columnCount - 1 ? "Already the last column." : null),
            )}
            <MenuSeparator />
            {action(
              "Delete column",
              () => columnAction("delete", props.onRemoveColumn),
              structureReason ?? (props.columnCount <= 1 ? "Keep at least one column." : null),
              true,
            )}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        {action("Delete table", props.onDelete, readOnly, true)}
      </DockMenu>
      <DockMenu label="Cells" icon="Cells" commandScope="latex" side="top">
        {action(
          "Merge cells",
          () => props.onProperties({ kind: "merge" }),
          contentReason ?? (!props.canMergeCells ? "Select adjacent cells to merge." : null),
        )}
        {action(
          "Split cell",
          () => props.onProperties({ kind: "split" }),
          contentReason ?? (!props.canSplitCell ? "Choose a merged cell to split." : null),
        )}
      </DockMenu>
      <DockMenu label="Appearance" icon="Appearance" commandScope="latex" side="top">
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
              Rules
            </MenuSubTrigger>
            <MenuSubPopup
              data-writing-menu-owner={`${id}-rules`}
              data-dock-command-scope="latex"
              data-keybinding-capture=""
            >
              <MenuRadioGroup value={props.style}>
                {[
                  { value: "plain", label: "Simple" },
                  { value: "booktabs", label: "Booktabs" },
                  { value: "grid", label: "Full grid" },
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
              Width
            </MenuSubTrigger>
            <MenuSubPopup
              data-writing-menu-owner={`${id}-width`}
              data-dock-command-scope="latex"
              data-keybinding-capture=""
            >
              <MenuRadioGroup value={props.width}>
                {[
                  { value: "fixed", label: "Fit content" },
                  { value: "stretch", label: "Fit page" },
                  ...(props.width === "long" ? [{ value: "long", label: "Multipage" }] : []),
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
            Header row
          </DockCommandCheckboxItem>
        </LatexTableProperties>
      </DockMenu>
      <button
        type="button"
        className={dockButtonClass()}
        disabled={Boolean(contentReason) || !props.captionEditable}
        aria-label={props.hasCaption ? "Edit table caption" : "Add table caption"}
        aria-description={
          contentReason ??
          (!props.captionEditable ? "This table's caption setup requires Source." : undefined)
        }
        onClick={props.onEditCaption}
      >
        Caption
      </button>
      {props.hasCaption && (
        <LatexReferenceLabelPopover
          label="Table reference label"
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
