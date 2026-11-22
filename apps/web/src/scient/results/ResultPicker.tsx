import type { ComputeResultScript, ComputeResultValue, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
import { Input } from "~/components/ui/input";
import { m } from "~/i18n/messages";
import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";

export function resultErrorMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

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
  const gt = useGT();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the project's results over the environment connection while the picker is open
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await list({ environmentId: props.environmentId, input: { cwd: props.cwd } });
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
            <div className="flex max-h-80 flex-col overflow-y-auto" role="list">
              {(scripts ?? []).flatMap((script) => [
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
              ])}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
