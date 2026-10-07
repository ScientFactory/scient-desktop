import { useContext, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { setLatexLayoutOpening, setLatexPanelRow } from "./latexObjectProperties";
import { LatexSelect } from "./LatexSelect";
import { latexSourceArgument as arg } from "./latexSourceSyntax";
import { LatexLengthField } from "./LatexLengthField";

export function LatexLayoutControls({
  node,
  editor,
  getPos,
}: Pick<NodeViewProps, "node" | "editor" | "getPos">) {
  const context = useContext(LatexAuthoringContext);
  const layout = node.attrs.layout;
  const source = String(node.attrs.raw);
  const setError = useLatexActionNotice();
  const [width, setWidth] = useState(() => {
    let at = "\\begin{minipage}".length;
    for (let i = 0; i < 3; i++) {
      const option = arg(source, at, "[", "]");
      if (option) at = option.end;
    }
    return arg(source, at)?.value ?? "0.46\\linewidth";
  });
  const [height, setHeight] = useState(layout.height ?? "");
  const [alignment, setAlignment] = useState(String(layout.alignment ?? "t"));
  const [innerAlignment, setInnerAlignment] = useState(String(layout.innerAlignment ?? "t"));
  const [ratios, setRatios] = useState(
    Array.from({ length: Math.max(2, node.childCount) }, () => "1").join(":"),
  );
  const [gap, setGap] = useState("auto");
  const apply = (options: Parameters<typeof setLatexLayoutOpening>[1]) => {
    if (context.prepare())
      setError(
        editLatexObjectSource(editor, getPos(), context.source, (source) =>
          setLatexLayoutOpening(source, options),
        ),
      );
  };
  return (
    <div className="scient-latex-context-menu-panel">
      {layout.kind === "columns" ? (
        <label>
          Columns
          <LatexSelect
            aria-label="Column count"
            value={String(layout.columns)}
            onValueChange={(value) => apply({ columns: Number(value) })}
            options={[2, 3, 4, 5, 6].map((count) => ({
              value: String(count),
              label: String(count),
            }))}
          />
        </label>
      ) : layout.kind === "minipage" ? (
        <>
          <LatexLengthField
            label="Panel width"
            value={width}
            onChange={setWidth}
            relative
            disabled={!editor.isEditable}
          />
          <LatexLengthField
            label="Panel height"
            value={height}
            onChange={setHeight}
            automatic
            disabled={!editor.isEditable}
          />
          <label>
            Alignment
            <LatexSelect
              aria-label="Panel alignment"
              value={alignment}
              onValueChange={setAlignment}
              options={[
                { value: "t", label: "Top" },
                { value: "c", label: "Center" },
                { value: "b", label: "Bottom" },
              ]}
            />
          </label>
          {height && (
            <label>
              Content alignment
              <LatexSelect
                aria-label="Panel content alignment"
                value={innerAlignment}
                onValueChange={setInnerAlignment}
                options={[
                  { value: "t", label: "Top" },
                  { value: "c", label: "Center" },
                  { value: "b", label: "Bottom" },
                  { value: "s", label: "Stretch" },
                ]}
              />
            </label>
          )}
          <button
            type="button"
            disabled={!editor.isEditable}
            onClick={() => apply({ width, height, alignment, innerAlignment })}
          >
            Apply panel
          </button>
        </>
      ) : layout.kind === "row" ? (
        <>
          <label>
            Panel ratios
            <input
              aria-label="Panel ratios"
              value={ratios}
              onChange={(event) => setRatios(event.target.value)}
              placeholder="1:1 or 2:1:1"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={gap === "auto"}
              onChange={(event) => setGap(event.target.checked ? "auto" : "3mm")}
            />
            Automatic gap
          </label>
          {gap !== "auto" && (
            <LatexLengthField
              label="Panel gap"
              value={gap}
              onChange={setGap}
              disabled={!editor.isEditable}
            />
          )}
          <button
            type="button"
            disabled={!editor.isEditable}
            onClick={() => {
              if (context.prepare())
                setError(
                  editLatexObjectSource(editor, getPos(), context.source, (source) =>
                    setLatexPanelRow(source, ratios.split(":").map(Number), gap),
                  ),
                );
            }}
          >
            Apply panel layout
          </button>
        </>
      ) : null}
    </div>
  );
}
