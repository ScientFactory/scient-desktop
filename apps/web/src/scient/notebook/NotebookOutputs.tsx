/* oxlint-disable react/no-array-index-key -- Notebook outputs keep their saved order and have no identity. */
import type { EnvironmentId, NotebookCellView, ScopedThreadRef } from "@t3tools/contracts";
import type { Root, RootContent } from "mdast";
import { useEffect, useState } from "react";

import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { ComputeOutputBlock } from "~/scient/compute/ComputeOutputBlock";
import { ComputeRichOutput, type ComputeRichDisplay } from "~/scient/compute/ComputeRichOutput";
import { computeDisplays } from "~/scient/compute/computeRichRepresentation";
import { renderTerminalText } from "~/scient/compute/computeTerminalText";
import { ComputeTerminalOutput } from "~/scient/compute/ComputeTerminalOutput";
import { ComputeOutputView } from "~/scient/compute/ComputeOutputView";
import { useStore } from "zustand";
import type { NotebookController } from "./notebookController";

type NotebookOutput = Readonly<Record<string, unknown>>;

/** nbformat stores multiline text as a string or as a list of lines. */
function notebookText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((line) => typeof line === "string").join("") : "";
}

type ComputeRepresentation = Parameters<
  typeof computeDisplays
>[0]["bundle"]["representations"][number];

/** Where a notebook's runs live. */
export interface NotebookPlace {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
}

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

function SavedOutputs(props: {
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly label: string;
}) {
  if (props.outputs.length === 0) return null;
  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      {props.outputs.map((output, index) => {
        switch (output.output_type) {
          case "stream": {
            const text = notebookText(output.text);
            return (
              <ComputeOutputBlock key={index} tail copy={() => ({ text })}>
                <ComputeTerminalOutput
                  terminal={renderTerminalText(text)}
                  stream={output.name === "stderr" ? "stderr" : "stdout"}
                />
              </ComputeOutputBlock>
            );
          }
          case "error": {
            const text =
              Array.isArray(output.traceback) && output.traceback.length > 0
                ? output.traceback.filter((line) => typeof line === "string").join("\n")
                : `${String(output.ename)}: ${String(output.evalue)}`;
            return (
              <ComputeOutputBlock key={index} copy={() => ({ text })}>
                <div className="text-destructive">
                  <ComputeTerminalOutput terminal={renderTerminalText(text)} />
                </div>
              </ComputeOutputBlock>
            );
          }
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

const PENDING_FIGURE_HEIGHT = "20rem";

/** Outputs stored in the file, loaded when the cell comes near the view. */
function StoredOutputs(props: {
  readonly controller: NotebookController;
  readonly cell: NotebookCellView;
  readonly near: boolean;
}) {
  const { controller, cell, near } = props;
  const [loaded, setLoaded] = useState<ReadonlyArray<NotebookOutput> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- large stored outputs come from the server when their cell is on screen.
  useEffect(() => {
    if (!near || cell.outputs.length === 0) return;
    let cancelled = false;
    void Promise.all(
      cell.outputs.map((output, index) => controller.readOutput(cell.id, index, output)),
    ).then((outputs) => {
      if (cancelled) return;
      setLoaded(
        outputs.flatMap((json) =>
          json === null ? [] : [JSON.parse(json) as Readonly<Record<string, unknown>>],
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [cell.id, cell.outputs, controller, near]);
  if (loaded === null) {
    return cell.outputs.length === 0 ? null : (
      <div
        style={{
          minHeight: cell.outputs.some((output) => output.mediaTypes.length > 0)
            ? PENDING_FIGURE_HEIGHT
            : undefined,
        }}
      />
    );
  }
  return <SavedOutputs outputs={loaded} label={`Output of ${cell.id}`} />;
}

export function NotebookCellOutputs(props: {
  readonly controller: NotebookController;
  readonly place: NotebookPlace;
  readonly cell: NotebookCellView;
  readonly near: boolean;
}) {
  const { controller, cell, near } = props;
  const liveRun = useStore(controller.store, (state) => state.liveRuns[cell.id]);
  const running = useStore(controller.store, (state) => (state.activity[cell.id] ?? null) !== null);
  const showsRun =
    liveRun !== undefined &&
    (running || (cell.run?.execution === liveRun.executionId && cell.outputs.length > 0));
  return showsRun ? (
    <LiveOutputs
      controller={controller}
      place={props.place}
      cell={cell}
      near={near}
      run={liveRun}
    />
  ) : (
    <StoredOutputs controller={controller} cell={cell} near={near} />
  );
}

/** A run from this page keeps its full tools; older runs fall back to what the file stores. */
function LiveOutputs(props: {
  readonly controller: NotebookController;
  readonly place: NotebookPlace;
  readonly cell: NotebookCellView;
  readonly near: boolean;
  readonly run: { readonly sessionId: string; readonly executionId: string };
}) {
  const { environmentId, cwd, threadRef } = props.place;
  const events = useEnvironmentQuery(computeEnvironment.events({ environmentId, input: { cwd } }));
  const session = events.data?.sessions.get(props.run.sessionId as never);
  const live = events.data?.outputs.get(`${props.run.sessionId}/${props.run.executionId}`);
  if (session === undefined || live === undefined) {
    return <StoredOutputs controller={props.controller} cell={props.cell} near={props.near} />;
  }
  return (
    <div className="px-3 py-2">
      <ComputeOutputView
        cwd={cwd}
        environmentId={environmentId}
        session={session}
        executionId={props.run.executionId as never}
        outputs={live.outputs}
        threadRef={threadRef}
      />
    </div>
  );
}
