import { lazy, Suspense, useRef, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { sanitizeDocumentHtml } from "~/components/files/DocumentPages";
import { useTheme } from "~/hooks/useTheme";
import { ScientDisplayMath } from "~/scient/math/ScientMath";

import { ComputeJsonTree } from "./ComputeJsonTree";
import { ComputeOutputBlock } from "./ComputeOutputBlock";
import {
  computeLatexMath,
  type ComputeDisplay,
  type ComputeTablePreview,
} from "./computeRichRepresentation";
import { renderTerminalText } from "./computeTerminalText";
import { ComputeTerminalOutput } from "./ComputeTerminalOutput";
import "./scient-compute-output.css";

const PlotlyChartCard = lazy(() =>
  import("~/scient/visualizations/PlotlyChartCard").then((module) => ({
    default: module.PlotlyChartCard,
  })),
);
const VegaLiteChartCard = lazy(() =>
  import("~/scient/visualizations/VegaLiteChartCard").then((module) => ({
    default: module.VegaLiteChartCard,
  })),
);

export type ComputeRichDisplay = Exclude<ComputeDisplay, { readonly kind: "image" }>;

function tableText(table: ComputeTablePreview): string {
  return [table.columns, ...table.rows]
    .map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join("\t"))
    .join("\n");
}

export function ComputeTable(props: { readonly table: ComputeTablePreview }) {
  return (
    <figure className="min-w-0">
      <div className="max-w-full overflow-x-auto">
        <table className="scient-compute-table text-xs" aria-label="Result table">
          <thead>
            <tr>
              {props.table.columns.map((column) => (
                <th key={column} scope="col" dir="auto">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.table.rows.map((row, index) => (
              // eslint-disable-next-line react/no-array-index-key -- Immutable output rows can be identical and have no persistent row identity.
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={props.table.columns[column]} dir="auto">
                    {cell === null ? "" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.table.truncated ? (
        <figcaption className="mt-1 text-[11px] text-muted-foreground">
          First {props.table.rows.length} rows
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Sanitized like saved notebook output: no scripts, styles, links or remote images. */
function sanitizeComputeHtml(source: string): string | null {
  const html = sanitizeDocumentHtml(source);
  const probe = document.createElement("template");
  probe.innerHTML = html;
  const visible =
    (probe.content.textContent ?? "").trim().length > 0 || probe.content.querySelector("img");
  return visible ? html : null;
}

function ComputeHtml(props: { readonly html: string; readonly fallback: () => ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const html = sanitizeComputeHtml(props.html);
  if (html === null) return props.fallback();
  return (
    <ComputeOutputBlock copy={() => ({ text: element.current?.innerText ?? "", html })}>
      <div
        ref={element}
        className="scient-compute-html"
        // The sanitizer keeps only inert structural tags and data-URL images.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </ComputeOutputBlock>
  );
}

function ComputeLatex(props: { readonly text: string }) {
  const math = computeLatexMath(props.text);
  return (
    <ComputeOutputBlock copy={() => ({ text: props.text })}>
      {math === null ? (
        <ChatMarkdown text={props.text} cwd={undefined} parseRawHtml={false} />
      ) : (
        <ScientDisplayMath tex={math} focusable={false} />
      )}
    </ComputeOutputBlock>
  );
}

/** Renders the first display that can be shown, falling back through the rest. */
export function ComputeRichOutput(props: { readonly displays: ReadonlyArray<ComputeRichDisplay> }) {
  const { resolvedTheme } = useTheme();
  const [display, ...rest] = props.displays;
  if (display === undefined) return null;
  switch (display.kind) {
    case "plotly":
      return (
        <Suspense fallback={null}>
          <PlotlyChartCard
            language="plotly"
            source={display.source}
            theme={resolvedTheme}
            title={null}
          />
        </Suspense>
      );
    case "vega-lite":
      return (
        <Suspense fallback={null}>
          <VegaLiteChartCard
            language="vega-lite"
            source={display.source}
            theme={resolvedTheme}
            title={null}
          />
        </Suspense>
      );
    case "html":
      return (
        <ComputeHtml html={display.html} fallback={() => <ComputeRichOutput displays={rest} />} />
      );
    case "markdown":
      return (
        <ComputeOutputBlock copy={() => ({ text: display.text })}>
          <ChatMarkdown text={display.text} cwd={undefined} parseRawHtml={false} />
        </ComputeOutputBlock>
      );
    case "latex":
      return <ComputeLatex text={display.text} />;
    case "table":
      return (
        <ComputeOutputBlock copy={() => ({ text: tableText(display.table) })}>
          <ComputeTable table={display.table} />
        </ComputeOutputBlock>
      );
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(display.json);
      } catch {
        return <ComputeRichOutput displays={rest} />;
      }
      return (
        <ComputeOutputBlock copy={() => ({ text: JSON.stringify(value, null, 2) })}>
          <ComputeJsonTree value={value} />
        </ComputeOutputBlock>
      );
    }
    case "text": {
      const terminal = renderTerminalText(display.text);
      return (
        <ComputeOutputBlock copy={() => ({ text: terminal.text })}>
          <ComputeTerminalOutput terminal={terminal} />
        </ComputeOutputBlock>
      );
    }
  }
}
