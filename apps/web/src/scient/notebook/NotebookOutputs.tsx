/* oxlint-disable react/no-array-index-key -- Notebook outputs keep their saved order and have no identity. */
import type { Root, RootContent } from "mdast";

import { ComputeRichOutput, type ComputeRichDisplay } from "~/scient/compute/ComputeRichOutput";
import { computeDisplays } from "~/scient/compute/computeRichRepresentation";
import { renderTerminalText } from "~/scient/compute/computeTerminalText";
import { ComputeTerminalOutput } from "~/scient/compute/ComputeTerminalOutput";
import { notebookText, type NotebookOutput } from "./notebookDocument";

type ComputeRepresentation = Parameters<
  typeof computeDisplays
>[0]["bundle"]["representations"][number];

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

/** A saved MIME bundle in the shape Compute's renderers read, so notebooks and Results match. */
function richDisplays(data: Readonly<Record<string, unknown>>): ReadonlyArray<ComputeRichDisplay> {
  const representations: ComputeRepresentation[] = [];
  for (const [mediaType, value] of Object.entries(data)) {
    if (typeof value === "string" || Array.isArray(value))
      representations.push({ mediaType, data: { _tag: "text", text: notebookText(value) } });
    else if (value !== null && typeof value === "object")
      representations.push({ mediaType, data: { _tag: "json", json: JSON.stringify(value) } });
  }
  if (representations.length === 0) return [];
  return computeDisplays({
    _tag: "representation",
    kind: "display-data",
    sequence: 0,
    observedAt: "",
    revisionSequence: 0,
    revisedAt: "",
    bundle: { representations, metadataJson: null },
    displayId: null,
    executionCount: null,
  }).filter((display): display is ComputeRichDisplay => display.kind !== "image");
}

function Data(props: { readonly data: Readonly<Record<string, unknown>>; readonly label: string }) {
  const raster = RASTER_TYPES.find((type) => props.data[type] !== undefined);
  if (raster !== undefined) {
    return (
      <img
        src={`data:${raster};base64,${notebookText(props.data[raster]).replace(/\s/g, "")}`}
        alt={props.label}
        loading="lazy"
        className="max-h-[32rem] max-w-full object-contain"
      />
    );
  }
  return <ComputeRichOutput displays={richDisplays(props.data)} />;
}

export function NotebookOutputs(props: {
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly label: string;
}) {
  if (props.outputs.length === 0) return null;
  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      {props.outputs.map((output, index) => {
        switch (output.output_type) {
          case "stream":
            return (
              <ComputeTerminalOutput
                key={index}
                terminal={renderTerminalText(notebookText(output.text))}
                stream={output.name === "stderr" ? "stderr" : "stdout"}
              />
            );
          case "error":
            return (
              <div key={index} className="text-destructive">
                <ComputeTerminalOutput
                  terminal={renderTerminalText(
                    Array.isArray(output.traceback) && output.traceback.length > 0
                      ? output.traceback.filter((line) => typeof line === "string").join("\n")
                      : `${String(output.ename)}: ${String(output.evalue)}`,
                  )}
                />
              </div>
            );
          case "display_data":
          case "execute_result":
            return typeof output.data === "object" && output.data !== null ? (
              <Data key={index} data={output.data as Record<string, unknown>} label={props.label} />
            ) : null;
          default:
            return null;
        }
      })}
    </div>
  );
}
