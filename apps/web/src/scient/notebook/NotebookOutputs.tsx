/* oxlint-disable react/no-array-index-key -- Notebook outputs keep their saved order and have no identity. */
import type {
  ComputeExecutionRecord,
  ComputeRuntimeInspection,
  ComputeSessionId,
  EnvironmentId,
  NotebookCellView,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { CircleAlert } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";

import { Button } from "~/components/ui/button";
import { computeEnvironment } from "~/state/compute";
import { ComputeOutputBlock } from "~/scient/compute/ComputeOutputBlock";
import { computeDiagnosticSummary } from "~/scient/compute/computeResultPresentation";
import { ComputeRichOutput, type ComputeRichDisplay } from "~/scient/compute/ComputeRichOutput";
import { computeDisplays } from "~/scient/compute/computeRichRepresentation";
import { renderTerminalText } from "~/scient/compute/computeTerminalText";
import { ComputeTerminalOutput } from "~/scient/compute/ComputeTerminalOutput";
import { copyStaticImage, downloadStaticImage } from "~/components/preview/staticImageActions";
import { ComputeOutputView, NotebookSetupRecovery } from "~/scient/compute/ComputeOutputView";
import {
  ScientImageActionMenu,
  type ScientImageAction,
} from "~/scient/images/ScientImageActionMenu";
import { useStore } from "zustand";
import type { MarkdownExtensions } from "~/markdown/wordsHast";
import type { NotebookController } from "./notebookController";
import { notebookDefiningCell, type NotebookDefiningCell } from "./notebookRunSummary";

type NotebookOutput = Readonly<Record<string, unknown>>;

const notebookLiveOutput = Atom.family((scope: string) => {
  const [environmentId, cwd, sessionId, executionId] = JSON.parse(scope) as [
    EnvironmentId,
    string,
    ComputeSessionId,
    string,
  ];
  const events = computeEnvironment.events({ environmentId, input: { cwd } });
  return Atom.make((get) => {
    const state = AsyncResult.getOrElse(get(events), () => null);
    const session = state?.sessions.get(sessionId);
    const output = state?.outputs.get(`${sessionId}/${executionId}`);
    if (session === undefined || output === undefined) return null;
    const cached = get.self<{
      readonly session: typeof session;
      readonly output: typeof output;
    } | null>();
    if (
      cached._tag === "Some" &&
      cached.value?.output === output &&
      cached.value.session.generation === session.generation
    )
      return cached.value;
    return { session, output };
  });
});

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
  readonly path: string;
  readonly liveSessionGeneration?: number | null | undefined;
  readonly runtimeInspection?: ComputeRuntimeInspection | null | undefined;
  readonly dependencyRecovery?: ComponentProps<typeof ComputeOutputView>["dependencyRecovery"];
  readonly cellRuns?: ReadonlyMap<string, ComputeExecutionRecord> | undefined;
  readonly onJumpToCell?: ((cellId: string) => void) | undefined;
  /** Adds text from a cell's output to the chat as a quote of that cell, when a chat is open. */
  readonly askAboutCell?: ((cellId: string, text: string) => void) | undefined;
  readonly replay?:
    | {
        readonly firstCodeCell: string;
        readonly runThrough: (cellId: string) => void;
      }
    | undefined;
}

const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif"] as const;

/** Notebook Markdown never loads URLs or turns links into app actions. */
export const NOTEBOOK_MARKDOWN: MarkdownExtensions = { scientNotebook: true };

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

const dataUrl = (mediaType: string, value: unknown) =>
  `data:${mediaType};base64,${notebookText(value).replace(/\s/g, "")}`;

/** A figure stored in the file, with the same ways out as a figure from a live run. */
function SavedFigure(props: {
  readonly mediaType: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly label: string;
}) {
  const gt = useGT();
  const url = dataUrl(props.mediaType, props.data[props.mediaType]);
  const pdf = props.data["application/pdf"];
  const extension = props.mediaType.split("/")[1] ?? "png";
  const [busy, setBusy] = useState(false);
  const actions: ReadonlyArray<ScientImageAction> = [
    {
      id: "copy",
      label: gt("Copy image"),
      requiresUserActivation: true,
      run: () => copyStaticImage(url),
    },
    {
      id: "download",
      label: gt("Download image"),
      run: () => downloadStaticImage(url, `${props.label}.${extension}`),
    },
    ...(pdf === undefined
      ? []
      : [
          {
            id: "pdf",
            label: gt("Download PDF"),
            run: () => downloadStaticImage(dataUrl("application/pdf", pdf), `${props.label}.pdf`),
          },
        ]),
  ];
  return (
    <div className="group/figure relative inline-flex max-w-full">
      <img
        src={url}
        alt={props.label}
        loading="lazy"
        decoding="async"
        className="max-h-[32rem] max-w-full object-contain"
      />
      <span className="absolute top-1 right-1 rounded-md bg-background/85 opacity-0 transition-opacity group-focus-within/figure:opacity-100 group-hover/figure:opacity-100 has-[[data-popup-open]]:opacity-100">
        <ScientImageActionMenu
          actions={actions}
          busy={busy}
          run={(action) => {
            setBusy(true);
            void Promise.resolve(action.run()).finally(() => setBusy(false));
          }}
        />
      </span>
    </div>
  );
}

function Data(props: { readonly data: Readonly<Record<string, unknown>>; readonly label: string }) {
  const raster = RASTER_TYPES.find((type) => props.data[type] !== undefined);
  if (raster !== undefined) {
    return <SavedFigure mediaType={raster} data={props.data} label={props.label} />;
  }
  return <ComputeRichOutput displays={richDisplays(props.data)} />;
}

function SavedOutputs(props: {
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly label: string;
  readonly onReplay?: (() => void) | undefined;
  readonly onJumpToCell?: ((cellId: string) => void) | undefined;
  readonly definingCell?: ((name: string) => NotebookDefiningCell | null) | undefined;
  readonly onAskAgent?: ((text: string) => void) | undefined;
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
            const errorName = typeof output.ename === "string" ? output.ename : "Error";
            const message = typeof output.evalue === "string" ? output.evalue : "";
            const rawTraceback = Array.isArray(output.traceback)
              ? output.traceback.filter((line): line is string => typeof line === "string")
              : [];
            const { summary, traceback } = computeDiagnosticSummary({
              errorName,
              message,
              traceback: rawTraceback,
              frames: [],
            });
            const fullText = [summary, traceback].filter(Boolean).join("\n");
            const definingCell =
              errorName === "NameError" && props.definingCell !== undefined
                ? (() => {
                    const match = /^name '([^'\r\n]+)' is not defined$/.exec(message);
                    return match?.[1] ? props.definingCell(match[1]) : null;
                  })()
                : null;
            return (
              <ComputeOutputBlock key={index} copy={() => ({ text: fullText })}>
                <div className="rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs">
                  <div className="flex items-start gap-2">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 font-medium break-words text-destructive">
                          {summary}
                        </p>
                        {props.onAskAgent === undefined ? null : (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => props.onAskAgent?.(fullText)}
                          >
                            <T>Ask agent</T>
                          </Button>
                        )}
                      </div>
                      <NotebookSetupRecovery
                        errorName={output.ename}
                        message={output.evalue}
                        onReplay={props.onReplay}
                        onJumpToCell={props.onJumpToCell}
                        definingCell={definingCell}
                      />
                      {traceback.length > 0 ? (
                        <details className="mt-1 text-muted-foreground">
                          <summary className="cursor-pointer">
                            <T>Details</T>
                          </summary>
                          <div className="mt-1">
                            <ComputeTerminalOutput terminal={renderTerminalText(traceback)} />
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
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
  readonly place: NotebookPlace;
  readonly cell: NotebookCellView;
  readonly near: boolean;
  readonly onReplay: (() => void) | undefined;
  readonly definingCell: (name: string) => NotebookDefiningCell | null;
}) {
  const { controller, cell, near, place } = props;
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
  if (cell.outputs.length === 0) return null;
  if (loaded === null) {
    return (
      <div
        style={{
          minHeight: cell.outputs.some((output) => output.mediaTypes.length > 0)
            ? PENDING_FIGURE_HEIGHT
            : undefined,
        }}
      />
    );
  }
  return (
    <SavedOutputs
      outputs={loaded}
      label="figure"
      onReplay={props.onReplay}
      onJumpToCell={place.onJumpToCell}
      definingCell={props.definingCell}
      onAskAgent={
        place.askAboutCell === undefined ? undefined : (text) => place.askAboutCell?.(cell.id, text)
      }
    />
  );
}

export function NotebookCellOutputs(props: {
  readonly controller: NotebookController;
  readonly place: NotebookPlace;
  readonly cell: NotebookCellView;
  readonly near: boolean;
}) {
  const { controller, cell, near, place } = props;
  const liveRun = useStore(controller.store, (state) => state.liveRuns[cell.id]);
  const running = useStore(controller.store, (state) => (state.activity[cell.id] ?? null) !== null);
  const showsRun =
    near &&
    liveRun !== undefined &&
    (running || (cell.run?.execution === liveRun.executionId && cell.outputs.length > 0));
  const replay = place.replay;
  const onReplay =
    replay === undefined || cell.id === replay.firstCodeCell || cell.source.trim() === ""
      ? undefined
      : () => replay.runThrough(cell.id);
  const definingCell = (name: string) => {
    const state = controller.store.getState();
    return notebookDefiningCell({
      order: state.order,
      cells: state.cells,
      targetCellId: cell.id,
      name,
      cellRuns: place.cellRuns ?? new Map(),
      liveSessionGeneration: place.liveSessionGeneration ?? null,
    });
  };
  return showsRun ? (
    <LiveOutputs
      controller={controller}
      place={place}
      cell={cell}
      near={near}
      run={liveRun}
      onReplay={onReplay}
      definingCell={definingCell}
    />
  ) : (
    <StoredOutputs
      controller={controller}
      place={place}
      cell={cell}
      near={near}
      onReplay={onReplay}
      definingCell={definingCell}
    />
  );
}

/** A run from this page keeps its full tools; older runs fall back to what the file stores. */
function LiveOutputs(props: {
  readonly controller: NotebookController;
  readonly place: NotebookPlace;
  readonly cell: NotebookCellView;
  readonly near: boolean;
  readonly run: { readonly sessionId: string; readonly executionId: string };
  readonly onReplay: (() => void) | undefined;
  readonly definingCell: (name: string) => NotebookDefiningCell | null;
}) {
  const { environmentId, cwd, threadRef } = props.place;
  const live = useAtomValue(
    notebookLiveOutput(
      JSON.stringify([environmentId, cwd, props.run.sessionId, props.run.executionId]),
    ),
  );
  if (live === null) {
    return (
      <StoredOutputs
        controller={props.controller}
        place={props.place}
        cell={props.cell}
        near={props.near}
        onReplay={props.onReplay}
        definingCell={props.definingCell}
      />
    );
  }
  return (
    <div className="px-3 py-2">
      <ComputeOutputView
        cwd={cwd}
        environmentId={environmentId}
        session={live.session}
        executionId={props.run.executionId as never}
        outputs={live.output.outputs}
        threadRef={threadRef}
        runtimeInspection={props.place.runtimeInspection ?? null}
        {...(props.place.dependencyRecovery === undefined
          ? {}
          : { dependencyRecovery: props.place.dependencyRecovery })}
        notebook={{
          path: props.place.path,
          onReplay: props.onReplay,
          onJumpToCell: props.place.onJumpToCell,
          definingCell: props.definingCell,
        }}
        onAskAgent={
          props.place.askAboutCell === undefined
            ? undefined
            : (text) => props.place.askAboutCell?.(props.cell.id, text)
        }
      />
    </div>
  );
}
