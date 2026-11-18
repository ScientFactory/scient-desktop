import type {
  ComputeResultResolution,
  ComputeResultScript,
  ComputeResultSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatResultTarget,
  parseResultTarget,
  resultHasNewer,
  resultReferenceState as resultMarkState,
} from "@t3tools/shared/computeResults";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { m } from "~/i18n/messages";
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
import { RESULT_STATE_LABEL, resultCauseText } from "./resultState";

export interface MarkdownResultsHandle {
  readonly openCard: (href: string, anchor: HTMLElement) => void;
  readonly openPicker: () => void;
}

const REFRESH_DELAY_MS = 400;

function errorMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

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
  const [card, setCard] = useState<{ href: string; anchor: HTMLElement } | null>(null);
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
        openCard: (href, anchor) => {
          setCard({ href, anchor });
          setRefreshTick((tick) => tick + 1);
        },
        openPicker: () => setPickerOpen(true),
      }),
    [register],
  );

  const cardReference = card === null ? undefined : references.find((r) => r.href === card.href);
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
        <ResultPicker
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
  const gt = useGT();
  const inputs = summary.inputs.join(", ");
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>
        {summary.threadId === undefined ? (
          <T>
            From{" "}
            <span className="font-medium text-foreground">
              <Var>{summary.scriptPath}</Var>
            </span>
            , run <Var>{relativeTime(summary.finishedAt)}</Var>
          </T>
        ) : (
          <T>
            From{" "}
            <span className="font-medium text-foreground">
              <Var>{summary.scriptPath}</Var>
            </span>
            , run <Var>{relativeTime(summary.finishedAt)}</Var> by an agent
          </T>
        )}
      </span>
      <span>
        {summary.inputTracking === "not-tracked"
          ? gt("Inputs are not tracked for this language.")
          : summary.inputs.length === 0
            ? gt("Scient saw it read no project files.")
            : summary.inputsTruncated
              ? gt("Inputs Scient saw it read: {inputs}, and more.", { inputs })
              : gt("Inputs Scient saw it read: {inputs}.", { inputs })}
      </span>
      <span>
        {summary.runtime.version === null
          ? gt("Package changes are not checked.")
          : gt("{language} {version}. Package changes are not checked.", {
              language: summary.language,
              version: summary.runtime.version,
            })}
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
  const gt = useGT();
  const messages = useMessages();
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
  const shown = reference.kind === "value" ? reference.text : reference.alt || gt("Figure");

  if (resolution === undefined || resolution._tag === "unrecorded")
    return (
      <div className="flex flex-col gap-1 p-1 text-xs">
        <span className="font-medium text-foreground">{shown}</span>
        <span className="text-muted-foreground">
          <T>No run record on this computer. The document keeps the value it shows.</T>
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
        gt(
          "{count, plural, =1 {The newest run of {scriptPath} has no {names}. Remove it from the document or have the script write it again, then update.} other {The newest run of {scriptPath} has no {names}. Remove them from the document or have the script write them again, then update.}}",
          { count: names.length, scriptPath, names: names.join(", ") },
        ),
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
        setMessage(errorMessage(result, gt("The new figure could not be copied.")));
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
      setMessage(gt("The document's results changed while updating. Update again."));
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
      else if (current.kind === "figure" && placed.has(current.href))
        updates.push({
          kind: "figure",
          position: current.position,
          href,
          src: placed.get(current.href)!,
        });
    }
    if (!props.controller.updateResults(updates)) {
      setMessage(gt("Nothing to update."));
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
      setMessage(errorMessage(result, gt("The script could not run.")));
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
          {messages(RESULT_STATE_LABEL[state])}
        </span>
      </div>
      {reference.kind === "value" && state === "edited" ? (
        <span>
          <T>
            The run gave <Var>{resolution.value}</Var>.
          </T>
        </span>
      ) : null}
      {resolution.summary.causes.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {resolution.summary.causes.map((cause) => (
            <li key={`${cause.kind}:${cause.path}`}>{resultCauseText(cause, messages)}</li>
          ))}
        </ul>
      ) : (
        <span className="text-muted-foreground">
          <T>No changes in the script or the files Scient saw it read.</T>
        </span>
      )}
      <SummaryLines summary={resolution.summary} />
      {newer !== null && resultHasNewer(reference, resolution) ? (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <span>
            {reference.kind === "value" ? (
              newer.summary.causes.length > 0 ? (
                <T>
                  A newer run (<Var>{relativeTime(newer.summary.finishedAt)}</Var>) gives{" "}
                  <span className="font-medium text-foreground">
                    <Var>{newer.value}</Var>
                  </span>
                  , but it is out of date too.
                </T>
              ) : (
                <T>
                  A newer run (<Var>{relativeTime(newer.summary.finishedAt)}</Var>) gives{" "}
                  <span className="font-medium text-foreground">
                    <Var>{newer.value}</Var>
                  </span>
                  .
                </T>
              )
            ) : newer.summary.causes.length > 0 ? (
              gt("A newer run ({time}) has a new figure, but it is out of date too.", {
                time: relativeTime(newer.summary.finishedAt),
              })
            ) : (
              gt("A newer run ({time}) has a new figure.", {
                time: relativeTime(newer.summary.finishedAt),
              })
            )}
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
            <T>
              Use <Var>{resolution.value}</Var>
            </T>
          </Button>
        ) : null}
        {editable && canPlace && updateCount > 0 ? (
          <Button size="xs" disabled={busy !== null} onClick={() => void updateFromScript()}>
            {busy === "update"
              ? gt("Updating…")
              : gt("{count, plural, =1 {Update} other {Update {count} results}}", {
                  count: updateCount,
                })}
          </Button>
        ) : null}
        {canRerun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void rerunScript()}
          >
            {busy === "rerun"
              ? gt("Running…")
              : gt("Re-run {name}", { name: scriptPath.split("/").at(-1) ?? "" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ResultPicker(props: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly documentPath: string;
  readonly controller: ScientMarkdownEditorView;
}) {
  const gt = useGT();
  const list = useStableCallback(
    useAtomCommand(computeEnvironment.resultsList, { reportFailure: false }),
  );
  const canPlace = useAtomValue(
    computeEnvironment.resultsPlaceFigure.permissionAtom(props.environmentId),
  );
  const placeFigure = useAtomCommand(computeEnvironment.resultsPlaceFigure, {
    reportFailure: false,
  });
  const [scripts, setScripts] = useState<ReadonlyArray<ComputeResultScript> | null>(null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the project's results over the environment connection while the picker is open
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await list({ environmentId: props.environmentId, input: { cwd: props.cwd } });
      if (cancelled) return;
      if (result._tag !== "Success") {
        setMessage(errorMessage(result, m(msg("The results could not be read."))));
        setScripts([]);
        return;
      }
      setScripts(result.value.scripts);
    })();
    return () => {
      cancelled = true;
    };
  }, [list, props.environmentId, props.cwd]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) =>
    needle.length === 0 || text.toLocaleLowerCase().includes(needle);

  const insertFigure = async (script: ComputeResultScript, output: string) => {
    const at = props.controller.insertionPoint();
    const result = await placeFigure({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        documentPath: props.documentPath,
        revision: script.latest.revision,
        output,
      },
    });
    if (result._tag !== "Success") {
      setMessage(errorMessage(result, gt("The figure could not be copied.")));
      return;
    }
    props.onClose();
    props.controller.insertResult(
      {
        kind: "figure",
        href: formatResultTarget({ revision: script.latest.revision, output, pointer: null }),
        src: result.value.src,
        alt: output.replace(/^.*\//u, "").replace(/\.[^.]+$/u, ""),
      },
      at,
    );
  };

  return (
    <Dialog
      modal={false}
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        showBackdrop={false}
        className="w-[min(560px,calc(100vw-32px))]"
        padding="none"
        gap="none"
        finalFocus={false}
      >
        <DialogHeader>
          <DialogTitle>
            <T>Insert a result</T>
          </DialogTitle>
          <DialogDescription>
            <T>Values and figures from scripts run from scratch. Each one stays tied to its run.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2 px-4 pb-4">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={gt("Find a value, figure, or script…")}
              aria-label={gt("Search results")}
            />
            {message === null ? null : (
              <p className="text-xs text-destructive-foreground">{message}</p>
            )}
            {scripts !== null && scripts.length === 0 && message === null ? (
              <p className="text-xs text-muted-foreground">
                <T>
                  No results yet. Have a script write a JSON file of values, or figures, into the
                  folder named by the SCIENT_RESULTS_DIR environment variable, then run it in a
                  fresh session.
                </T>
              </p>
            ) : null}
            <div className="flex max-h-80 flex-col overflow-y-auto" role="list">
              {(scripts ?? []).flatMap((script) => [
                ...script.values
                  .filter((value) =>
                    matches(
                      `${script.latest.scriptPath} ${value.output} ${value.pointer} ${value.value}`,
                    ),
                  )
                  .map((value) => (
                    <button
                      type="button"
                      role="listitem"
                      className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      key={`${script.latest.revision}:${value.output}:${value.pointer}`}
                      onClick={() => {
                        props.onClose();
                        props.controller.insertResult({
                          kind: "value",
                          href: formatResultTarget({
                            revision: script.latest.revision,
                            output: value.output,
                            pointer: value.pointer,
                          }),
                          text: value.value,
                        });
                      }}
                    >
                      <span className="font-medium">{value.value}</span>
                      <span className="text-xs text-muted-foreground">
                        {value.pointer.slice(1).replaceAll("/", " › ")} · {script.latest.scriptPath}
                      </span>
                    </button>
                  )),
                ...(canPlace ? script.figures : [])
                  .filter((figure) => matches(`${script.latest.scriptPath} ${figure}`))
                  .map((figure) => (
                    <button
                      type="button"
                      role="listitem"
                      className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      key={`${script.latest.revision}:${figure}`}
                      onClick={() => void insertFigure(script, figure)}
                    >
                      <span className="font-medium">{figure}</span>
                      <span className="text-xs text-muted-foreground">
                        <T>
                          Figure · <Var>{script.latest.scriptPath}</Var>
                        </T>
                      </span>
                    </button>
                  )),
              ])}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
