import { useContext, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Input } from "~/components/ui/input";
import { MenuRadioGroup } from "~/components/ui/menu";
import { DockMenu, DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { setLatexLayoutOpening, setLatexPanelRow } from "./latexObjectProperties";
import { LatexFooterSubmenu } from "./LatexFooterSubmenu";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { latexSourceArgument as arg } from "./latexSourceSyntax";
import { LatexLengthField } from "./LatexLengthField";
import { latexLayoutLength } from "./latexPageLayouts";

function opening(source: string) {
  let at = "\\begin{minipage}".length;
  const options: string[] = [];
  for (let i = 0; i < 3; i++) {
    const value = arg(source, at, "[", "]");
    if (!value) break;
    options.push(value.value);
    at = value.end;
  }
  return {
    width: arg(source, at)?.value ?? "",
    height: options[1] ?? "",
    alignment: options[0] ?? "c",
    innerAlignment: options[2] ?? options[0] ?? "c",
  };
}

function LayoutDimensions(props: {
  width: string;
  height: string;
  onApply: (width: string, height: string) => void;
}) {
  const [width, setWidth] = useState(props.width);
  const [height, setHeight] = useState(props.height);
  const valid =
    !!latexLayoutLength(width) &&
    parseFloat(width) > 0 &&
    (!height || (!!latexLayoutLength(height) && !latexLayoutLength(height)!.endsWith("%")));
  return (
    <LatexContextMenuForm label="Panel dimensions" width="content">
      <LatexLengthField
        label="Width"
        value={width}
        onChange={setWidth}
        relative
        relativeTo={["linewidth", "textwidth", "columnwidth"]}
        size="sm"
        width="content"
      />
      <LatexLengthField
        label="Height"
        value={height}
        onChange={setHeight}
        automatic
        size="sm"
        width="content"
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onApply(width, height)}>
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}
function PanelRatios(props: { value: string; count: number; onApply: (values: number[]) => void }) {
  const [draft, setDraft] = useState(props.value);
  const values = draft.split(":").map(Number);
  const valid =
    values.length === props.count && values.every((value) => Number.isFinite(value) && value > 0);
  return (
    <LatexContextMenuForm label="Panel widths" width="content">
      <label>
        Ratios
        <Input
          size="compact"
          aria-label="Panel width ratios"
          value={draft}
          aria-invalid={!valid}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <DockCommandItem disabled={!valid} onClick={() => props.onApply(values)}>
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}
function PanelGap(props: { value: string; onApply: (gap: string) => void }) {
  const [gap, setGap] = useState(props.value === "auto" ? "3mm" : props.value);
  const valid = !!latexLayoutLength(gap) && !latexLayoutLength(gap)!.endsWith("%");
  return (
    <LatexContextMenuForm label="Panel spacing" width="content">
      <LatexLengthField label="Gap" value={gap} onChange={setGap} size="sm" width="content" />
      <DockCommandItem disabled={!valid} onClick={() => props.onApply(gap)}>
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}
export function LatexLayoutControls({
  node,
  editor,
  getPos,
}: Pick<NodeViewProps, "node" | "editor" | "getPos">) {
  const context = useContext(LatexAuthoringContext);
  const setError = useLatexActionNotice();
  const layout = node.attrs.layout;
  const source = String(node.attrs.raw);
  const panel = opening(source);
  const apply = (options: Parameters<typeof setLatexLayoutOpening>[1]) => {
    if (context.prepare())
      setError(
        editLatexObjectSource(editor, getPos(), context.source, (source) =>
          setLatexLayoutOpening(source, options),
        ),
      );
  };
  const alignmentOptions = [
    { value: "t", label: "Top" },
    { value: "c", label: "Center" },
    { value: "b", label: "Bottom" },
  ];
  const widths: number[] = [];
  const units: string[] = [];
  const gaps: string[] = [];
  node.forEach((child, _offset, index) => {
    widths.push(parseFloat(String(child.attrs.layout?.width ?? "")));
    units.push(String(child.attrs.layout?.width ?? "").replace(/^[\d.]+/u, ""));
    if (index) gaps.push(String(child.attrs.layoutGap ?? "auto"));
  });
  // Mixed imported gaps have no selected preset; changing spacing is an explicit operation.
  const gap = gaps.every((value) => value === gaps[0]) ? (gaps[0] ?? "auto") : "";
  const ratios = widths.every((value) => Number.isFinite(value) && value > 0)
    ? widths.join(":")
    : Array.from({ length: node.childCount }, () => 1).join(":");
  const applyRow = (ratios: number[], gap: string, preserveWidths: boolean) => {
    if (context.prepare())
      setError(
        editLatexObjectSource(editor, getPos(), context.source, (source) =>
          setLatexPanelRow(source, ratios, gap, preserveWidths, !preserveWidths),
        ),
      );
  };
  if (layout.kind === "columns")
    return (
      <DockMenu icon={undefined} label="Columns" commandScope="latex" disabled={!editor.isEditable}>
        <MenuRadioGroup value={String(layout.columns)}>
          {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => (
            <DockCommandRadioItem
              key={count}
              value={String(count)}
              size="compact"
              onClick={() => apply({ columns: count })}
            >
              {count}
            </DockCommandRadioItem>
          ))}
        </MenuRadioGroup>
      </DockMenu>
    );
  if (layout.kind === "minipage")
    return (
      <DockMenu
        icon={undefined}
        label="Appearance"
        commandScope="latex"
        disabled={!editor.isEditable}
      >
        <LatexFooterSubmenu label="Dimensions">
          <LayoutDimensions
            key={source.slice(0, 100)}
            width={panel.width}
            height={panel.height}
            onApply={(width, height) => apply({ ...panel, width, height })}
          />
        </LatexFooterSubmenu>
        <LatexFooterSubmenu label="Alignment">
          <MenuRadioGroup value={panel.alignment}>
            {alignmentOptions.map((choice) => (
              <DockCommandRadioItem
                key={choice.value}
                value={choice.value}
                size="compact"
                onClick={() => apply({ ...panel, alignment: choice.value })}
              >
                {choice.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </LatexFooterSubmenu>
        <LatexFooterSubmenu label="Content alignment" disabled={!panel.height}>
          <MenuRadioGroup value={panel.innerAlignment}>
            {[...alignmentOptions, { value: "s", label: "Stretch" }].map((choice) => (
              <DockCommandRadioItem
                key={choice.value}
                value={choice.value}
                size="compact"
                onClick={() => apply({ ...panel, innerAlignment: choice.value })}
              >
                {choice.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </LatexFooterSubmenu>
      </DockMenu>
    );
  if (layout.kind === "row")
    return (
      <DockMenu icon={undefined} label="Layout" commandScope="latex" disabled={!editor.isEditable}>
        <LatexFooterSubmenu
          label="Panel widths"
          disabled={node.childCount > 6 || !units.every((unit) => unit === units[0])}
        >
          <PanelRatios
            key={ratios}
            value={ratios}
            count={node.childCount}
            onApply={(values) => applyRow(values, gap, false)}
          />
        </LatexFooterSubmenu>
        <LatexFooterSubmenu label="Spacing" disabled={node.childCount > 6}>
          <MenuRadioGroup value={gap}>
            <DockCommandRadioItem
              value="auto"
              size="compact"
              onClick={() => applyRow(widths, "auto", true)}
            >
              Automatic
            </DockCommandRadioItem>
          </MenuRadioGroup>
          <LatexFooterSubmenu label="Custom">
            <PanelGap
              key={gap}
              value={gap || "3mm"}
              onApply={(gap) => applyRow(widths, gap, true)}
            />
          </LatexFooterSubmenu>
        </LatexFooterSubmenu>
      </DockMenu>
    );
  return null;
}
