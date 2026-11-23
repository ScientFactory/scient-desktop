import { CompareResultButton } from "./ResultComparison";
import type {
  ComputeResultRevisionId,
  ComputeResultScript,
  ComputeResultValue,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  resultEnvironmentMayDiffer,
  resultInputCoverageIncomplete,
  resultSourceChanged,
} from "@t3tools/shared/computeResults";
import { ResultAttemptStatus } from "./ResultAttemptStatus";
import { resultErrorMessage, resultParameters, resultTime } from "./resultState";
import { msg, T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useEnvironmentQuery } from "~/state/query";
import { Input } from "~/components/ui/input";
import { m } from "~/i18n/messages";
import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { ResultRunEvidence } from "./ResultRunEvidence";

export type ResultChoice =
  | {
      readonly kind: "value";
      readonly script: ComputeResultScript;
      readonly value: ComputeResultValue;
    }
  | { readonly kind: "figure"; readonly script: ComputeResultScript; readonly output: string }
  | { readonly kind: "table"; readonly script: ComputeResultScript; readonly output: string };

const ROW_CLASS =
  "flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

/**
 * The project's latest results, one row per value, figure and table. The editor decides which
 * kinds it takes and what picking one does; a refusal it returns stays in the dialog.
 */
export function ResultPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly figures: (output: string) => boolean;
  readonly tables: (output: string) => boolean;
  readonly onPick: (choice: ResultChoice) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const list = useStableCallback(
    useAtomCommand(computeEnvironment.resultsList, { reportFailure: false }),
  );
  const [scripts, setScripts] = useState<ReadonlyArray<ComputeResultScript> | null>(null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const history = useEnvironmentQuery(
    choosing === null
      ? null
      : computeEnvironment.resultsHistory({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, scriptPath: choosing },
        }),
  );
  const gt = useGT();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the project's results over the environment connection while the picker is open
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await list({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, preferCurrent: true },
      });
      if (cancelled) return;
      if (result._tag !== "Success") {
        setMessage(resultErrorMessage(result, m(msg("The results could not be read."))));
        setScripts([]);
        return;
      }
      setScripts(result.value.scripts);
    })();
    return () => {
      cancelled = true;
    };
  }, [list, props.environmentId, props.cwd]);

  const chooseRevision = async (revision: ComputeResultRevisionId) => {
    setBusy(true);
    setMessage(null);
    const result = await list({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, revision },
    }).catch(() => null);
    setBusy(false);
    if (result === null || result._tag !== "Success") {
      const fallback = gt("The selected revision could not be read.");
      setMessage(result === null ? fallback : resultErrorMessage(result, fallback));
      return;
    }
    const selected = result.value.scripts[0];
    if (selected === undefined) {
      setMessage(gt("The selected revision has no available results."));
      return;
    }
    setScripts(
      (current) =>
        current?.map((script) =>
          script.latest.scriptPath === selected.latest.scriptPath ? selected : script,
        ) ?? null,
    );
  };

  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) =>
    needle.length === 0 || text.toLocaleLowerCase().includes(needle);

  const pick = (choice: ResultChoice) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void props
      .onPick(choice)
      .then((refusal) => {
        if (refusal === null) props.onClose();
        else setMessage(refusal);
      })
      .finally(() => setBusy(false));
  };

  const row = (key: string, title: string, detail: string, choice: ResultChoice) => (
    <button
      type="button"
      role="listitem"
      className={ROW_CLASS}
      key={key}
      disabled={busy}
      onClick={() => pick(choice)}
    >
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );

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
            <T>
              Values, tables and figures from scripts run from scratch. Each one stays tied to its
              run.
            </T>
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
                  No results yet. Have a script write a JSON file of values, CSV tables or figures
                  into the folder named by the SCIENT_RESULTS_DIR environment variable, then run it
                  in a fresh session.
                </T>
              </p>
            ) : null}
            <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
              {(scripts ?? []).map((script) => {
                const rows = [
                  ...script.values
                    .filter((value) =>
                      matches(
                        `${script.latest.scriptPath} ${value.output} ${value.pointer} ${value.value}`,
                      ),
                    )
                    .map((value) =>
                      row(
                        `${script.latest.revision}:${value.output}:${value.pointer}`,
                        value.value,
                        `${value.pointer.slice(1).replaceAll("/", " › ")} · ${script.latest.scriptPath}`,
                        { kind: "value", script, value },
                      ),
                    ),
                  ...(script.tables ?? [])
                    .filter(
                      (table) =>
                        props.tables(table) && matches(`${script.latest.scriptPath} ${table}`),
                    )
                    .map((table) =>
                      row(
                        `${script.latest.revision}:${table}`,
                        table,
                        gt("Table · {path}", { path: script.latest.scriptPath }),
                        { kind: "table", script, output: table },
                      ),
                    ),
                  ...script.figures
                    .filter(
                      (figure) =>
                        props.figures(figure) && matches(`${script.latest.scriptPath} ${figure}`),
                    )
                    .map((figure) =>
                      row(
                        `${script.latest.revision}:${figure}`,
                        figure,
                        gt("Figure · {path}", { path: script.latest.scriptPath }),
                        { kind: "figure", script, output: figure },
                      ),
                    ),
                ];
                if (rows.length === 0 && !matches(script.latest.scriptPath)) return null;
                const stale = resultSourceChanged(script.latest);
                const runTime = resultTime(script.latest.finishedAt);
                return (
                  <section
                    key={script.latest.scriptPath}
                    aria-label={script.latest.scriptPath}
                    className="flex flex-col gap-1"
                  >
                    <div className="px-2.5">
                      <bdi className="break-all text-sm font-medium">
                        {script.latest.scriptPath}
                      </bdi>
                      {script.revisions > 1 ? (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              setChoosing((current) =>
                                current === script.latest.scriptPath
                                  ? null
                                  : script.latest.scriptPath,
                              )
                            }
                          >
                            <T>Choose revision…</T>
                          </Button>
                          <CompareResultButton
                            environmentId={props.environmentId}
                            cwd={props.cwd}
                            summary={script.latest}
                          />
                        </>
                      ) : null}
                      {choosing === script.latest.scriptPath ? (
                        history.error === null && history.data !== null ? (
                          <Select
                            value={script.latest.revision}
                            disabled={busy}
                            onValueChange={(value) => {
                              if (value !== null) void chooseRevision(value);
                            }}
                            items={history.data.revisions.map(
                              ({ revision, finishedAt, parameters }) => ({
                                value: revision,
                                label: [resultTime(finishedAt), resultParameters(parameters)]
                                  .filter(Boolean)
                                  .join(" · "),
                              }),
                            )}
                          >
                            <SelectTrigger size="sm" aria-label={gt("Saved revision")}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {history.data.revisions.map(
                                ({ revision, finishedAt, parameters }) => (
                                  <SelectItem key={revision} value={revision}>
                                    {[resultTime(finishedAt), resultParameters(parameters)]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </SelectItem>
                                ),
                              )}
                            </SelectPopup>
                          </Select>
                        ) : (
                          <span role="status">{history.error ?? gt("Loading revisions…")}</span>
                        )
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {stale
                          ? gt("From an out-of-date run · {time}", { time: runTime })
                          : resultInputCoverageIncomplete(script.latest)
                            ? gt("Freshness partly unknown · {time}", { time: runTime })
                            : gt("Run {time}", { time: runTime })}
                      </p>
                      <ResultRunEvidence summary={script.latest} />
                      {resultEnvironmentMayDiffer(script.latest) ? (
                        <span className="text-xs text-muted-foreground">
                          <T>Environment may differ</T>
                        </span>
                      ) : null}
                      {script.lastAttempt == null ? null : (
                        <ResultAttemptStatus
                          key={script.lastAttempt.finishedAt}
                          environmentId={props.environmentId}
                          cwd={props.cwd}
                          scriptPath={script.latest.scriptPath}
                          attempt={script.lastAttempt}
                        />
                      )}
                    </div>
                    <div role="list">{rows}</div>
                  </section>
                );
              })}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
