import { T, useGT } from "gt-react";
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
  const gt = useGT();
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
  const action = (label: string, change: LatexTableAction, disabled?: boolean) => (
    <DockCommandItem disabled={disabled ?? props.disabled} onClick={() => props.apply(change)}>
      {label}
    </DockCommandItem>
  );
  return (
    <>
      {props.children}
      <MenuSeparator />
      <TableSubmenu label={gt("Column", { $context: "table column" })}>
        <LatexContextMenuForm label={gt("Column options")}>
          <label>
            <T>Alignment</T>
            <LatexSelect
              size="sm"
              aria-label={gt("Column text alignment")}
              value={alignment}
              disabled={props.disabled}
              onValueChange={(value) => setAlignment(value as typeof alignment)}
              options={[
                { value: "left", label: gt("Left", { $context: "text alignment" }) },
                { value: "center", label: gt("Center", { $context: "text alignment" }) },
                { value: "right", label: gt("Right", { $context: "text alignment" }) },
              ]}
            />
          </label>
          <label>
            <T>Width</T>
            <LatexSelect
              size="sm"
              aria-label={gt("Column wrapping")}
              value={wrapping}
              disabled={props.disabled}
              onValueChange={(value) => setWrapping(value as typeof wrapping)}
              options={[
                { value: "natural", label: gt("Fit content") },
                { value: "fixed", label: gt("Fixed width") },
                ...(shape?.environment === "tabularx"
                  ? [{ value: "flexible", label: gt("Flexible") }]
                  : []),
              ]}
            />
          </label>
          {wrapping === "fixed" && (
            <LatexLengthField
              size="sm"
              label={gt("Column width")}
              value={width}
              onChange={setWidth}
              relative
              disabled={props.disabled}
            />
          )}
          <div className="flex justify-end">
            {action(
              gt("Apply"),
              { kind: "column", width, wrapping, alignment },
              props.disabled ||
                (wrapping === "fixed" &&
                  !/^(?:\d+(?:\.\d*)?|\.\d+)(?:mm|cm|in|pt|em|\\linewidth)$/u.test(width)),
            )}
          </div>
        </LatexContextMenuForm>
      </TableSubmenu>
      <TableSubmenu label={gt("Borders", { $context: "table borders" })}>
        {action(gt("Add above"), { kind: "rule", edge: "above", enabled: true })}
        {action(gt("Add below"), { kind: "rule", edge: "below", enabled: true })}
        <MenuSeparator />
        {action(gt("Remove above"), { kind: "rule", edge: "above", enabled: false })}
        {action(gt("Remove below"), { kind: "rule", edge: "below", enabled: false })}
      </TableSubmenu>
      <TableSubmenu label={gt("Layout")}>
        {props.hasCaption && (
          <TableSubmenu label={gt("Caption position")}>
            {action(gt("Above", { $context: "caption position" }), {
              kind: "caption-position",
              position: "above",
            })}
            {action(gt("Below", { $context: "caption position" }), {
              kind: "caption-position",
              position: "below",
            })}
          </TableSubmenu>
        )}
        {float && (
          <TableSubmenu label={gt("Placement")}>
            <MenuRadioGroup value={float[1] ?? "htbp"}>
              {[
                { value: "htbp", label: gt("Automatic") },
                { value: "t", label: gt("Top", { $context: "float placement" }) },
                { value: "b", label: gt("Bottom", { $context: "float placement" }) },
                { value: "p", label: gt("Float page") },
                { value: "H", label: gt("Here", { $context: "float placement" }) },
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
            gt("Multipage"),
            { kind: "multipage" },
            props.disabled || shape?.environment !== "tabular",
          )}
        {shape?.environment === "longtable" && (
          <TableSubmenu label={gt("Continuation")}>
            <LatexContextMenuForm label={gt("Table continuation")}>
              <label>
                <T>Header rows</T>
                <Input
                  size="compact"
                  aria-label={gt("Repeated header row count")}
                  type="number"
                  min={1}
                  max={10}
                  value={headerRows}
                  disabled={props.disabled}
                  onChange={(event) => setHeaderRows(event.target.value)}
                />
              </label>
              {action(
                gt("Repeat header"),
                { kind: "repeat-header", rows: Number(headerRows) },
                props.disabled ||
                  !Number.isInteger(Number(headerRows)) ||
                  Number(headerRows) < 1 ||
                  Number(headerRows) > 10,
              )}
              <label>
                <T context="table continuation footer">Footer</T>
                <Input
                  size="compact"
                  aria-label={gt("Table continuation footer")}
                  value={continuation}
                  disabled={props.disabled}
                  onChange={(event) => setContinuation(event.target.value)}
                />
              </label>
              {action(
                gt("Apply footer"),
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
