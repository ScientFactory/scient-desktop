/* oxlint-disable react/no-array-index-key -- Notebook outputs keep their saved order and have no identity. */
import { lazy, Suspense } from "react";
import type { Root, RootContent } from "mdast";

import ChatMarkdown from "~/components/ChatMarkdown";
import DocumentPages from "~/components/files/DocumentPages";
import { useTheme } from "~/hooks/useTheme";
import { ComputeTable } from "~/scient/compute/ComputeRichOutput";
import { parseComputeTable } from "~/scient/compute/computeRichRepresentation";
import { notebookText, type NotebookOutput } from "./notebookDocument";

const PlotlyChartCard = lazy(() =>
  import("~/scient/visualizations/PlotlyChartCard").then((module) => ({
    default: module.PlotlyChartCard,
  })),
);

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif"] as const;

/** Notebook Markdown never loads URLs or turns links into app actions. */
function inertMarkdown() {
  const clean = (nodes: RootContent[]): RootContent[] =>
    nodes.flatMap((node): RootContent[] => {
      if (node.type === "html" || node.type === "definition") return [];
      if (node.type === "image" || node.type === "imageReference")
        return [{ type: "text", value: node.alt ?? "" }];
      if (node.type === "link" || node.type === "linkReference") return clean(node.children);
      if ("children" in node) node.children = clean(node.children) as typeof node.children;
      return [node];
    });
  return (tree: Root) => {
    tree.children = clean(tree.children) as Root["children"];
  };
}
export const NOTEBOOK_MARKDOWN_PLUGINS = [inertMarkdown];

/** Carriage returns and backspaces as a terminal shows them, colors dropped. */
function terminalText(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => {
      let shown = "";
      for (const segment of line.replace(/\r$/, "").split("\r")) {
        shown = segment + shown.slice(segment.length);
      }
      return shown;
    })
    .join("\n");
}

function Text(props: { readonly text: string; readonly tone?: "error" | "muted" }) {
  return (
    <pre
      className={
        props.tone === "error"
          ? "overflow-x-auto px-4 py-2 font-mono text-xs whitespace-pre-wrap break-words text-destructive"
          : props.tone === "muted"
            ? "overflow-x-auto px-4 py-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground"
            : "overflow-x-auto px-4 py-2 font-mono text-xs whitespace-pre-wrap break-words"
      }
    >
      {props.text}
    </pre>
  );
}

function RichData(props: {
  readonly data: Readonly<Record<string, unknown>>;
  readonly label: string;
}) {
  const { resolvedTheme } = useTheme();
  const raster = RASTER_TYPES.find((type) => typeof props.data[type] === "string");
  if (raster !== undefined) {
    return (
      <img
        src={`data:${raster};base64,${notebookText(props.data[raster]).replace(/\s/g, "")}`}
        alt={props.label}
        loading="lazy"
        className="max-h-[32rem] max-w-full object-contain px-4 py-2"
      />
    );
  }
  const table = props.data["application/vnd.dataresource+json"];
  const parsedTable = table === undefined ? null : parseComputeTable(JSON.stringify(table));
  if (parsedTable !== null) return <ComputeTable table={parsedTable} />;
  const plotly = props.data["application/vnd.plotly.v1+json"];
  if (plotly !== undefined) {
    return (
      <Suspense fallback={null}>
        <PlotlyChartCard
          language="plotly"
          source={JSON.stringify(plotly)}
          theme={resolvedTheme}
          title={null}
        />
      </Suspense>
    );
  }
  if (
    typeof props.data["image/svg+xml"] === "string" ||
    Array.isArray(props.data["image/svg+xml"])
  ) {
    const svg = notebookText(props.data["image/svg+xml"]);
    return (
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
        alt={props.label}
        loading="lazy"
        className="max-h-[32rem] max-w-full object-contain px-4 py-2"
      />
    );
  }
  if (props.data["text/html"] !== undefined) {
    return <DocumentPages html={notebookText(props.data["text/html"])} name={props.label} output />;
  }
  const markdown = props.data["text/markdown"] ?? props.data["text/latex"];
  if (markdown !== undefined) {
    return (
      <ChatMarkdown
        text={notebookText(markdown)}
        cwd={undefined}
        parseRawHtml={false}
        extraRemarkPlugins={NOTEBOOK_MARKDOWN_PLUGINS}
        className="px-4 py-2"
      />
    );
  }
  if (props.data["text/plain"] !== undefined) {
    return <Text text={terminalText(notebookText(props.data["text/plain"]))} />;
  }
  const json = props.data["application/json"];
  return json === undefined ? null : <Text text={JSON.stringify(json, null, 2)} />;
}

export function NotebookOutputs(props: {
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly label: string;
}) {
  if (props.outputs.length === 0) return null;
  return (
    <div className="min-w-0">
      {props.outputs.map((output, index) => {
        switch (output.output_type) {
          case "stream":
            return (
              <Text
                key={index}
                text={terminalText(notebookText(output.text))}
                {...(output.name === "stderr" ? { tone: "muted" as const } : {})}
              />
            );
          case "error":
            return (
              <Text
                key={index}
                tone="error"
                text={terminalText(
                  Array.isArray(output.traceback) && output.traceback.length > 0
                    ? output.traceback.filter((line) => typeof line === "string").join("\n")
                    : `${String(output.ename)}: ${String(output.evalue)}`,
                )}
              />
            );
          case "display_data":
          case "execute_result":
            return typeof output.data === "object" && output.data !== null ? (
              <RichData
                key={index}
                data={output.data as Record<string, unknown>}
                label={props.label}
              />
            ) : null;
          default:
            return null;
        }
      })}
    </div>
  );
}
