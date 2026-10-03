import { LatexSelect } from "./LatexSelect";
import { isLatexContextEvent } from "./latexContextEvents";
import { useEffect, useId, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { ChevronUp } from "lucide-react";

interface Props {
  editor: Editor;
  tableRoot: RefObject<HTMLElement | null>;
  selected: boolean;
  editable: boolean;
  structureEditable: boolean;
  row: number;
  column: number;
  rowCount: number;
  columnCount: number;
  style: string;
  width: string;
  header: boolean;
  alignment: string;
  caption: string;
  label: string;
  captionEditable: boolean;
  labelEditable: boolean;
  onActiveChange: (active: boolean) => void;
  hasCellSelection: boolean;
  onSelectTable: () => void;
  onSelectRow: () => void;
  onSelectColumn: () => void;
  onClearCells: () => void;
  onAddRow: (after: number) => void;
  onRemoveRow: () => void;
  onMoveRow: (direction: -1 | 1) => void;
  onAddColumn: (after: number) => void;
  onRemoveColumn: () => void;
  onMoveColumn: (direction: -1 | 1) => void;
  onStyle: (value: string) => void;
  onWidth: (value: string) => void;
  onHeader: () => void;
  onAlignment: (value: string) => void;
  onCaption: (value: string) => void;
  onLabel: (value: string) => void;
  onDelete: () => void;
}

export function LatexTableToolbar(props: Props) {
  const { tableRoot, selected, onActiveChange } = props;
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const activate = () => {
    document.dispatchEvent(new CustomEvent("scient-latex-context-activate", { detail: id }));
    setActive(true);
  };
  const activation = useRef(activate);
  activation.current = activate;
  useEffect(() => {
    if (selected) activation.current();
  }, [selected]);
  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);
  useEffect(() => {
    const table = tableRoot.current;
    const focus = () => activation.current();
    const outside = (event: Event) => {
      if (isLatexContextEvent(event, bar.current)) return;
      const path = event.composedPath();
      if (!path.includes(tableRoot.current!) && !path.includes(bar.current!)) setActive(false);
      if (!path.includes(bar.current!))
        bar.current
          ?.querySelectorAll("details[open]")
          .forEach((menu) => menu.removeAttribute("open"));
    };
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setActive(false);
    };
    table?.addEventListener("focusin", focus);
    table?.addEventListener("pointerdown", focus);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("scient-latex-context-activate", deactivate);
    return () => {
      table?.removeEventListener("focusin", focus);
      table?.removeEventListener("pointerdown", focus);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scient-latex-context-activate", deactivate);
    };
  }, [id, tableRoot]);
  if (!active) return null;
  const host = props.editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  if (!host) return null;
  const action = (label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      disabled={!props.editable || disabled}
      onClick={() => {
        bar.current
          ?.querySelectorAll("details[open]")
          .forEach((menu) => menu.removeAttribute("open"));
        run();
      }}
    >
      {label}
    </button>
  );
  const menu = (label: string, children: ReactNode) => (
    <details
      name={`table-tools-${id}`}
      className="scient-latex-context-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        {label}
        <ChevronUp aria-hidden="true" />
      </summary>
      <div className="scient-latex-context-menu-panel">{children}</div>
    </details>
  );
  return createPortal(
    <div
      ref={bar}
      className="scient-latex-context-toolbar scient-latex-table-context"
      role="toolbar"
      aria-label="Table tools"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest("button"))
          event.preventDefault();
      }}
    >
      <span
        className="scient-latex-context-label scient-latex-table-position"
        aria-label={`Table: row ${props.row + 1}, column ${props.column + 1}`}
      >
        R{props.row + 1} C{props.column + 1}
      </span>
      {props.editable ? (
        <>
          {menu(
            "Row",
            <>
              {action("Select row", props.onSelectRow)}
              {action(
                "Insert row above",
                () => props.onAddRow(props.row - 1),
                !props.structureEditable,
              )}
              {action(
                "Insert row below",
                () => props.onAddRow(props.row),
                !props.structureEditable,
              )}
              {action(
                "Move row up",
                () => props.onMoveRow(-1),
                !props.structureEditable || props.row === 0,
              )}
              {action(
                "Move row down",
                () => props.onMoveRow(1),
                !props.structureEditable || props.row >= props.rowCount - 1,
              )}
              {action(
                "Delete row",
                props.onRemoveRow,
                !props.structureEditable || props.rowCount <= 1,
              )}
            </>,
          )}
          {menu(
            "Column",
            <>
              {action("Select column", props.onSelectColumn)}
              {action(
                "Insert column left",
                () => props.onAddColumn(props.column - 1),
                !props.structureEditable,
              )}
              {action(
                "Insert column right",
                () => props.onAddColumn(props.column),
                !props.structureEditable,
              )}
              {action(
                "Move column left",
                () => props.onMoveColumn(-1),
                !props.structureEditable || props.column === 0,
              )}
              {action(
                "Move column right",
                () => props.onMoveColumn(1),
                !props.structureEditable || props.column >= props.columnCount - 1,
              )}
              {action(
                "Delete column",
                props.onRemoveColumn,
                !props.structureEditable || props.columnCount <= 1,
              )}
              <label>
                Alignment
                <LatexSelect
                  aria-label="Selected column alignment"
                  disabled={!props.structureEditable}
                  value={props.alignment}
                  onValueChange={(value) => props.onAlignment(value)}
                  size="compact"
                  options={[
                    { value: "left", label: "Left" },
                    { value: "center", label: "Center" },
                    { value: "right", label: "Right" },
                  ]}
                />
              </label>
            </>,
          )}
          {menu(
            "Table",
            <>
              {action("Select table", props.onSelectTable)}
              {action("Clear selected cells", props.onClearCells, !props.hasCellSelection)}
              <label>
                Style
                <LatexSelect
                  aria-label="Table style"
                  disabled={!props.structureEditable}
                  value={props.style}
                  onValueChange={(value) => props.onStyle(value)}
                  size="compact"
                  options={[
                    { value: "plain", label: "Simple" },
                    { value: "booktabs", label: "Booktabs" },
                    { value: "grid", label: "Full grid" },
                  ]}
                />
              </label>
              <label>
                Width
                <LatexSelect
                  aria-label="Table width behavior"
                  value={props.width}
                  disabled={!props.structureEditable || props.width === "long"}
                  onValueChange={(value) => props.onWidth(value)}
                  size="compact"
                  options={[
                    { value: "fixed", label: "Fit content" },
                    { value: "stretch", label: "Fit page" },
                    ...(props.width === "long" ? [{ value: "long", label: "Multipage" }] : []),
                  ]}
                />
              </label>
              <label className="scient-latex-context-checkbox">
                <input
                  type="checkbox"
                  checked={props.header}
                  disabled={!props.structureEditable}
                  onChange={props.onHeader}
                />
                Header row
              </label>
              {props.captionEditable ? (
                <label>
                  Caption
                  <textarea
                    aria-label="Table caption"
                    rows={2}
                    value={props.caption}
                    onChange={(event) => props.onCaption(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              {props.labelEditable ? (
                <label>
                  Reference label
                  <input
                    aria-label="Table reference label"
                    placeholder="tab:results"
                    value={props.label}
                    onChange={(event) => props.onLabel(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              {action("Delete table", props.onDelete)}
              <p>
                Drag across cells or Shift+click to select. Copy with Ctrl/Cmd+C; Delete clears
                cells. Select table to copy or delete the whole table.
              </p>
              <p>
                {props.structureEditable
                  ? "Tab moves between cells. Tab in the last cell adds a row."
                  : "Tab moves between cells. Merged cells, shading and rules are preserved; change the table structure in Source."}
              </p>
            </>,
          )}
        </>
      ) : (
        <span>
          {props.editor.isEditable ? "Protected table — edit in Source" : "Read-only table"}
        </span>
      )}
    </div>,
    host,
  );
}
