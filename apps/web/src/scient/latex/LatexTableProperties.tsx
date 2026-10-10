import { useId, useState, type ReactNode } from "react";
import { Input } from "~/components/ui/input";
import {
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { LatexSelect } from "./LatexSelect";
import { latexTableSourceShape, type LatexTableAction } from "./latexTableAuthoring";
import { LatexLengthField } from "./LatexLengthField";
import { LatexContextMenuForm } from "./LatexContextMenuForm";

/** Each portaled submenu remains owned by the table's footer selection. */
function TableSubmenu(props: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <MenuSub>
      <MenuSubTrigger id={id}>{props.label}</MenuSubTrigger>
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

export function LatexTableProperties(props: {
  source: string;
  column: number;
  disabled: boolean;
  hasCaption: boolean;
  children: ReactNode;
  apply: (action: LatexTableAction) => void;
}) {
  const shape = latexTableSourceShape(props.source);
  const column = shape?.columns[props.column];
  const [width, setWidth] = useState(column?.width ?? "30mm");
  const [wrapping, setWrapping] = useState<"natural" | "fixed" | "flexible">(
    column?.kind === "X" ? "flexible" : column?.width ? "fixed" : "natural",
  );
  const [alignment, setAlignment] = useState(column?.alignment ?? "left");
  const [headerRows, setHeaderRows] = useState("1");
  const [continuation, setContinuation] = useState("");
  const float = /\\begin\{table\*?\}(?:\[([^\]]*)\])?/u.exec(props.source);
  const action = (label: string, change: LatexTableAction, disabled = props.disabled) => (
    <DockCommandItem disabled={disabled} onClick={() => props.apply(change)}>
      {label}
    </DockCommandItem>
  );
  return (
    <>
      {props.children}
      <MenuSeparator />
      <TableSubmenu label="Column">
        <LatexContextMenuForm label="Column options">
          <label>
            Alignment
            <LatexSelect
              size="sm"
              aria-label="Column text alignment"
              value={alignment}
              disabled={props.disabled}
              onValueChange={(value) => setAlignment(value as typeof alignment)}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
                { value: "right", label: "Right" },
              ]}
            />
          </label>
          <label>
            Width
            <LatexSelect
              size="sm"
              aria-label="Column wrapping"
              value={wrapping}
              disabled={props.disabled}
              onValueChange={(value) => setWrapping(value as typeof wrapping)}
              options={[
                { value: "natural", label: "Fit content" },
                { value: "fixed", label: "Fixed width" },
                ...(shape?.environment === "tabularx"
                  ? [{ value: "flexible", label: "Flexible" }]
                  : []),
              ]}
            />
          </label>
          {wrapping === "fixed" && (
            <LatexLengthField
              size="sm"
              label="Column width"
              value={width}
              onChange={setWidth}
              relative
              disabled={props.disabled}
            />
          )}
          <div className="flex justify-end">
            {action(
              "Apply",
              { kind: "column", width, wrapping, alignment },
              props.disabled ||
                (wrapping === "fixed" &&
                  !/^(?:\d+(?:\.\d*)?|\.\d+)(?:mm|cm|in|pt|em|\\linewidth)$/u.test(width)),
            )}
          </div>
        </LatexContextMenuForm>
      </TableSubmenu>
      <TableSubmenu label="Borders">
        {action("Add above", { kind: "rule", edge: "above", enabled: true })}
        {action("Add below", { kind: "rule", edge: "below", enabled: true })}
        <MenuSeparator />
        {action("Remove above", { kind: "rule", edge: "above", enabled: false })}
        {action("Remove below", { kind: "rule", edge: "below", enabled: false })}
      </TableSubmenu>
      <TableSubmenu label="Layout">
        {props.hasCaption && (
          <TableSubmenu label="Caption position">
            {action("Above", { kind: "caption-position", position: "above" })}
            {action("Below", { kind: "caption-position", position: "below" })}
          </TableSubmenu>
        )}
        {float && (
          <TableSubmenu label="Placement">
            <MenuRadioGroup value={float[1] ?? "htbp"}>
              {[
                { value: "htbp", label: "Automatic" },
                { value: "t", label: "Top" },
                { value: "b", label: "Bottom" },
                { value: "p", label: "Float page" },
                { value: "H", label: "Here" },
              ].map((option) => (
                <DockCommandRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={props.disabled}
                  onClick={() => props.apply({ kind: "placement", value: option.value })}
                >
                  {option.label}
                </DockCommandRadioItem>
              ))}
            </MenuRadioGroup>
          </TableSubmenu>
        )}
        {shape?.environment !== "longtable" &&
          action(
            "Multipage",
            { kind: "multipage" },
            props.disabled || shape?.environment !== "tabular",
          )}
        {shape?.environment === "longtable" && (
          <TableSubmenu label="Continuation">
            <LatexContextMenuForm label="Table continuation">
              <label>
                Header rows
                <Input
                  size="compact"
                  aria-label="Repeated header row count"
                  type="number"
                  min={1}
                  max={10}
                  value={headerRows}
                  disabled={props.disabled}
                  onChange={(event) => setHeaderRows(event.target.value)}
                />
              </label>
              {action(
                "Repeat header",
                { kind: "repeat-header", rows: Number(headerRows) },
                props.disabled ||
                  !Number.isInteger(Number(headerRows)) ||
                  Number(headerRows) < 1 ||
                  Number(headerRows) > 10,
              )}
              <label>
                Footer
                <Input
                  size="compact"
                  aria-label="Table continuation footer"
                  value={continuation}
                  disabled={props.disabled}
                  onChange={(event) => setContinuation(event.target.value)}
                />
              </label>
              {action(
                "Apply footer",
                { kind: "continuation", text: continuation },
                props.disabled || /[\\{}%#$&_^~]/u.test(continuation),
              )}
            </LatexContextMenuForm>
          </TableSubmenu>
        )}
      </TableSubmenu>
    </>
  );
}
