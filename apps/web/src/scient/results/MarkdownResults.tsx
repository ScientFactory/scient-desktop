import type {
  ComputeResultResolution,
  ComputeResultSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  formatResultTarget,
  isResultTableOutput,
  parseResultTarget,
  resultCaption,
  resultHasNewer,
  resultReferenceState as resultMarkState,
} from "@t3tools/shared/computeResults";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { computeEnvironment } from "~/state/compute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  type EditorResultReference,
  type ResultMarkState,
  type ResultUpdate,
  resultMarkKey,
} from "../markdownEditor/prosemirror/results";
import type { ScientMarkdownEditorView } from "../markdownEditor/prosemirror/view";
import { ResultPicker, resultErrorMessage, type ResultChoice } from "./ResultPicker";
import { RESULT_STATE_LABEL, resultCauseText } from "./resultState";

export interface MarkdownResultsHandle {
  readonly openCard: (href: string, anchor: HTMLElement, position?: number) => void;
  readonly openPicker: () => void;
}

const REFRESH_DELAY_MS = 400;

const relativeTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** Linked results in a Markdown manuscript: their state marks, their card, and the picker. */
export function MarkdownResults(props: {
  readonly controller: ScientMarkdownEditorView;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly documentPath: string;
  readonly register: (handle: MarkdownResultsHandle) => () => void;
}) {
  const { controller, register } = props;
  const references = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  ).resultReferences;
  const hrefs = [...new Set(references.map((reference) => reference.href))].toSorted();
  const hrefKey = hrefs.join("\n");
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, ComputeResultResolution>>(
    () => new Map(),
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const [card, setCard] = useState<{
    href: string;
    anchor: HTMLElement;
    position?: number | undefined;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const resolveCommand = useAtomCommand(computeEnvironment.resultsResolve, {
    reportFailure: false,
  });
  const resolve = useStableCallback(resolveCommand);

  // Asking again (focus, a card, an action) changes the key, so the same document re-resolves.
  const requestKey = `${refreshTick}\n${hrefKey}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server, after a pause, about the results the document names; a newer request drops the older answer
  useEffect(() => {
    let cancelled = false;
    const requested = requestKey
      .split("\n")
      .slice(1)
      .filter((href) => href.length > 0);
    const timer = globalThis.setTimeout(() => {
      void (async () => {
        const targets = requested.flatMap((href) => {
          const target = parseResultTarget(href);
          return target === null ? [] : [target];
        });
        const result =
          targets.length === 0
            ? null
            : await resolve({
                environmentId: props.environmentId,
                input: { cwd: props.cwd, references: targets },
              });
        if (cancelled || (result !== null && result._tag !== "Success")) return;
        setResolutions(
          new Map(
            result === null
              ? []
              : requested.map((href, index) => [href, result.value.resolutions[index]!] as const),
          ),
        );
      })();
    }, REFRESH_DELAY_MS);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [requestKey, resolve, props.environmentId, props.cwd]);

  // Scripts and data change in other tabs and programs; look again when the reader comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus and visibility listeners, held while mounted
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setRefreshTick((tick) => tick + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the result states to the imperative editor
  useEffect(() => {
    const states = new Map<string, ResultMarkState>();
    for (const reference of references)
      states.set(
        resultMarkKey(reference),
        resultMarkState(reference, resolutions.get(reference.href)),
      );
    controller.setResultMarks(states);
  }, [controller, references, resolutions]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open actions the editor's click and slash handlers call, until unmount
  useEffect(
    () =>
      register({
        openCard: (href, anchor, position) => {
          setCard({ href, anchor, position });
          setRefreshTick((tick) => tick + 1);
        },
        openPicker: () => setPickerOpen(true),
      }),
    [register],
  );

  // Two results can cite the same output; the card is for the one clicked.
  const cardReference =
    card === null
      ? undefined
      : (references.find(
          (reference) =>
            reference.href === card.href &&
            (reference.position === card.position ||
              (reference.kind === "table" && reference.atomPosition === card.position)),
        ) ?? references.find((reference) => reference.href === card.href));
  return (
    <>
      <Popover
        open={card !== null && cardReference !== undefined}
        onOpenChange={(open) => {
          if (!open) setCard(null);
        }}
      >
        {card !== null && cardReference !== undefined ? (
          <PopoverPopup
            ref={cardRef}
            anchor={card.anchor}
            side="bottom"
            align="start"
            // A click in the editor counts as keyboard focus to Chromium; focusing the first button
            // would draw its focus ring. Tab still reaches the buttons.
            initialFocus={cardRef}
            className="w-80"
            padding="none"
          >
            {/* Solid, not glass: the card often sits over the paper's figures, which blur into smudges. */}
            <div className="rounded-[calc(var(--radius-lg)-1px)] bg-popover p-4">
              <ResultCard
                environmentId={props.environmentId}
                cwd={props.cwd}
                documentPath={props.documentPath}
                controller={controller}
                reference={cardReference}
                references={references}
                resolutions={resolutions}
                onChanged={() => setRefreshTick((tick) => tick + 1)}
                onClose={() => setCard(null)}
              />
            </div>
          </PopoverPopup>
        ) : null}
      </Popover>
      {pickerOpen ? (
        <MarkdownResultPicker
          onClose={() => setPickerOpen(false)}
          environmentId={props.environmentId}
          cwd={props.cwd}
          documentPath={props.documentPath}
          controller={controller}
        />
      ) : null}
    </>
  );
}

function SummaryLines({ summary }: { readonly summary: ComputeResultSummary }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>
        From <span className="font-medium text-foreground">{summary.scriptPath}</span>, run{" "}
        {relativeTime(summary.finishedAt)}
        {summary.threadId === undefined ? "" : " by an agent"}
      </span>
      <span>
        {summary.inputTracking === "not-tracked"
          ? "Inputs are not tracked for this language."
          : summary.inputs.length === 0
            ? "Scient saw it read no project files."
            : `Inputs Scient saw it read: ${summary.inputs.join(", ")}${summary.inputsTruncated ? ", and more" : ""}.`}
      </span>
      <span>
        {summary.runtime.version === null ? "" : `${summary.language} ${summary.runtime.version}. `}
        Package changes are not checked.
      </span>
    </div>
  );
}

function ResultCard(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly documentPath: string;
  readonly controller: ScientMarkdownEditorView;
  readonly reference: EditorResultReference;
  readonly references: ReadonlyArray<EditorResultReference>;
  readonly resolutions: ReadonlyMap<string, ComputeResultResolution>;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}) {
  const { reference } = props;
  const resolution = props.resolutions.get(reference.href);
  const state = resultMarkState(reference, resolution);
  const [busy, setBusy] = useState<"update" | "rerun" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rerun = useAtomCommand(computeEnvironment.resultsRerun, { reportFailure: false });
  const placeFigure = useAtomCommand(computeEnvironment.resultsPlaceFigure, {
    reportFailure: false,
  });
  const canPlace = useAtomValue(
    computeEnvironment.resultsPlaceFigure.permissionAtom(props.environmentId),
  );
  const canRerun = useAtomValue(
    computeEnvironment.resultsRerun.permissionAtom(props.environmentId),
  );
  const shown =
    reference.kind === "value"
      ? reference.text
      : reference.kind === "table"
        ? reference.caption || "Table"
        : reference.alt || "Figure";

  if (resolution === undefined || resolution._tag === "unrecorded")
    return (
      <div className="flex flex-col gap-1 p-1 text-xs">
        <span className="font-medium text-foreground">{shown}</span>
        <span className="text-muted-foreground">
          {RESULT_STATE_LABEL.unrecorded}. The document keeps the value it shows.
        </span>
      </div>
    );

  const scriptPath = resolution.summary.scriptPath;
  const editable = props.controller.getSnapshot().editable;

  const applyUpdate = async () => {
    const group = props.references.flatMap((candidate) => {
      const found = props.resolutions.get(candidate.href);
      return found?._tag === "resolved" &&
        found.summary.scriptPath === scriptPath &&
        found.newer !== null &&
        resultHasNewer(candidate, found)
        ? [{ candidate, newer: found.newer }]
        : [];
    });
    // One script's results move to one revision together, or not at all: a mix would put
    // numbers from two different runs side by side.
    const dropped = props.references.filter((candidate) => {
      const found = props.resolutions.get(candidate.href);
      return (
        found?._tag === "resolved" &&
        found.summary.scriptPath === scriptPath &&
        found.newer !== null &&
        !resultHasNewer(candidate, found)
      );
    });
    if (dropped.length > 0) {
      const names = [
        ...new Set(dropped.map((item) => (item.pointer ?? item.output).replace(/^\//u, ""))),
      ];
      setMessage(
        `The newest run of ${scriptPath} has no ${names.join(", ")}. Remove ${names.length === 1 ? "it" : "them"} from the document or have the script write ${names.length === 1 ? "it" : "them"} again, then update.`,
      );
      return;
    }
    const placed = new Map<string, string>();
    for (const { candidate, newer } of group) {
      if (candidate.kind !== "figure" || placed.has(candidate.href)) continue;
      const result = await placeFigure({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          documentPath: props.documentPath,
          revision: newer.summary.revision,
          output: candidate.output,
        },
      });
      if (result._tag !== "Success") {
        setMessage(resultErrorMessage(result, "The new figure could not be copied."));
        return;
      }
      placed.set(candidate.href, result.value.src);
    }
    // Results added or removed during the copies would be left on the old run, so start over.
    const live = props.controller.resultReferences();
    if (
      live.map((reference) => reference.href).join("\n") !==
      props.references.map((reference) => reference.href).join("\n")
    ) {
      setMessage("The document's results changed while updating. Update again.");
      return;
    }
    // Positions are read after the copies, so edits made meanwhile are kept.
    const updates: ResultUpdate[] = [];
    for (const current of live) {
      const match = group.find(({ candidate }) => candidate.href === current.href);
      if (match === undefined) continue;
      const href = formatResultTarget({
        revision: match.newer.summary.revision,
        output: current.output,
        pointer: current.pointer,
      });
      if (current.kind === "value" && match.newer.value !== null)
        updates.push({
          kind: "value",
          position: current.position,
          href,
          text: match.newer.value,
        });
      else if (current.kind === "table" && match.newer.table != null)
        updates.push({
          kind: "table",
          position: current.position,
          captionPosition: current.captionPosition,
          previousHref: current.href,
          href,
          rows: match.newer.table,
        });
      else if (current.kind === "figure" && placed.has(current.href))
        updates.push({
          kind: "figure",
          position: current.position,
          href,
          src: placed.get(current.href)!,
        });
    }
    if (!props.controller.updateResults(updates)) {
      setMessage("Nothing to update.");
      return;
    }
    props.onChanged();
    props.onClose();
  };

  const updateFromScript = () => {
    setBusy("update");
    setMessage(null);
    return applyUpdate().finally(() => setBusy(null));
  };

  const runAgain = async () => {
    const result = await rerun({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, scriptPath },
    });
    if (result._tag !== "Success") {
      setMessage(resultErrorMessage(result, "The script could not run."));
      return;
    }
    if (result.value._tag === "failed") setMessage(result.value.message);
    props.onChanged();
  };

  const rerunScript = () => {
    setBusy("rerun");
    setMessage(null);
    return runAgain().finally(() => setBusy(null));
  };

  const newer = resolution.newer;
  const updateCount = props.references.filter((candidate) => {
    const found = props.resolutions.get(candidate.href);
    return (
      found?._tag === "resolved" &&
      found.summary.scriptPath === scriptPath &&
      resultHasNewer(candidate, found)
    );
  }).length;
  return (
    <div className="flex flex-col gap-2 p-1 text-xs" data-testid="result-card">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{shown}</span>
        <span className="shrink-0 text-muted-foreground" data-result-card-state={state}>
          {RESULT_STATE_LABEL[state]}
        </span>
      </div>
      {reference.kind === "value" && state === "edited" ? (
        <span>The run gave {resolution.value}.</span>
      ) : null}
      {reference.kind === "table" && state === "edited" ? (
        <span>Cells differ from what the run wrote.</span>
      ) : null}
      {resolution.summary.causes.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {resolution.summary.causes.map((cause) => (
            <li key={`${cause.kind}:${cause.path}`}>{resultCauseText(cause)}</li>
          ))}
        </ul>
      ) : (
        <span className="text-muted-foreground">
          No changes in the script or the files Scient saw it read.
        </span>
      )}
      <SummaryLines summary={resolution.summary} />
      {newer !== null && resultHasNewer(reference, resolution) ? (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <span>
            A newer run ({relativeTime(newer.summary.finishedAt)})
            {reference.kind === "value" ? (
              <>
                {" "}
                gives <span className="font-medium text-foreground">{newer.value}</span>
              </>
            ) : reference.kind === "table" ? (
              " has a new table"
            ) : (
              " has a new figure"
            )}
            {newer.summary.causes.length > 0 ? ", but it is out of date too." : "."}
          </span>
        </div>
      ) : null}
      {message === null ? null : <span className="text-destructive-foreground">{message}</span>}
      <div className="flex flex-wrap gap-1.5">
        {editable &&
        reference.kind === "value" &&
        state === "edited" &&
        resolution.value !== null ? (
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => {
              const value = resolution.value;
              if (value === null) return;
              props.controller.updateResults([
                { kind: "value", position: reference.position, href: reference.href, text: value },
              ]);
              props.onChanged();
              props.onClose();
            }}
          >
            Use {resolution.value}
          </Button>
        ) : null}
        {editable &&
        reference.kind === "table" &&
        state === "edited" &&
        resolution.table != null ? (
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => {
              const rows = resolution.table;
              if (rows == null) return;
              props.controller.updateResults([
                {
                  kind: "table",
                  position: reference.position,
                  captionPosition: reference.captionPosition,
                  previousHref: reference.href,
                  href: reference.href,
                  rows,
                },
              ]);
              props.onChanged();
              props.onClose();
            }}
          >
            Use the run's table
          </Button>
        ) : null}
        {editable && canPlace && updateCount > 0 ? (
          <Button size="xs" disabled={busy !== null} onClick={() => void updateFromScript()}>
            {busy === "update"
              ? "Updating…"
              : updateCount === 1
                ? "Update"
                : `Update ${updateCount} results`}
          </Button>
        ) : null}
        {canRerun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void rerunScript()}
          >
            {busy === "rerun" ? "Running…" : `Re-run ${scriptPath.split("/").at(-1)}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Markdown shows PNG, JPEG and SVG figures; PDF figures are for LaTeX papers. */
const MARKDOWN_FIGURE = /\.(?:png|jpe?g|svg)$/iu;

function MarkdownResultPicker(props: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly documentPath: string;
  readonly controller: ScientMarkdownEditorView;
}) {
  const canPlace = useAtomValue(
    computeEnvironment.resultsPlaceFigure.permissionAtom(props.environmentId),
  );
  const placeFigure = useAtomCommand(computeEnvironment.resultsPlaceFigure, {
    reportFailure: false,
  });
  const resolve = useAtomCommand(computeEnvironment.resultsResolve, { reportFailure: false });

  const pick = async (choice: ResultChoice): Promise<string | null> => {
    const revision = choice.script.latest.revision;
    if (choice.kind === "value") {
      props.controller.insertResult({
        kind: "value",
        href: formatResultTarget({
          revision,
          output: choice.value.output,
          pointer: choice.value.pointer,
        }),
        text: choice.value.value,
      });
      return null;
    }
    if (choice.kind === "table") {
      const at = props.controller.insertionPoint();
      const target = { revision, output: choice.output, pointer: null };
      const result = await resolve({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, references: [target] },
      });
      const resolution = result._tag === "Success" ? result.value.resolutions[0] : undefined;
      const rows = resolution?._tag === "resolved" ? resolution.table : null;
      if (rows == null) return `${choice.output} is not a table Scient can show.`;
      props.onClose();
      props.controller.insertResult(
        {
          kind: "table",
          href: formatResultTarget(target),
          caption: resultCaption(choice.output, choice.script.latest.scriptPath),
          rows,
        },
        at,
      );
      return null;
    }
    const at = props.controller.insertionPoint();
    const result = await placeFigure({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, documentPath: props.documentPath, revision, output: choice.output },
    });
    if (result._tag !== "Success")
      return resultErrorMessage(result, "The figure could not be copied.");
    props.onClose();
    props.controller.insertResult(
      {
        kind: "figure",
        href: formatResultTarget({ revision, output: choice.output, pointer: null }),
        src: result.value.src,
        alt: choice.output.replace(/^.*\//u, "").replace(/\.[^.]+$/u, ""),
      },
      at,
    );
    return null;
  };

  return (
    <ResultPicker
      environmentId={props.environmentId}
      cwd={props.cwd}
      figures={(output) => canPlace && MARKDOWN_FIGURE.test(output)}
      tables={isResultTableOutput}
      onPick={pick}
      onClose={props.onClose}
    />
  );
}
