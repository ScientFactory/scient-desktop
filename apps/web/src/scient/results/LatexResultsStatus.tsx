import type {
  ComputeResultFileDigest,
  ComputeResultPlacedFile,
  ComputeResultPlacedScript,
  ComputeResultsPlacementsResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { resultErrorMessage } from "./ResultPicker";
import { resultCauseText } from "./resultState";

const FILE_STATE_TEXT: Record<ComputeResultPlacedFile["state"], string> = {
  current: "matches its run",
  "out-of-date": "out of date",
  edited: "edited after Scient placed it",
  missing: "missing",
};

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** Sent when Insert ▸ Result places files, so the build row shows them at once. */
export const RESULTS_PLACED_EVENT = "scient-latex-results-placed";

/** Files the shown PDF read, or may have; a file it did not read cannot be wrong in it. */
const usedFiles = (script: ComputeResultPlacedScript) =>
  script.files.filter((file) => file.usedByBuild !== false);

/** What a script's placed files need, most urgent first; null when nothing does. */
function scriptAttention(script: ComputeResultPlacedScript): string | null {
  if (script.interrupted) return "interrupted";
  const used = usedFiles(script);
  if (used.length === 0) return null;
  if (used.some((file) => file.state === "missing")) return "missing";
  if (script.summary.causes.length > 0) return "out of date";
  if (script.newer !== null) return "newer run";
  if (used.some((file) => file.state === "edited")) return "edited";
  if (used.some((file) => file.differsFromBuild)) return "rebuild";
  return null;
}

function chipLabel(result: ComputeResultsPlacementsResult): string | null {
  const needs = result.scripts.map(scriptAttention).filter((need) => need !== null);
  if (needs.includes("interrupted")) return "Results update unfinished";
  if (needs.includes("missing")) return "Result files missing";
  if (needs.includes("out of date")) return "Results out of date";
  if (needs.includes("newer run")) return "Newer results";
  if (needs.includes("edited")) return "Results edited";
  if (needs.includes("rebuild")) return "Rebuild for new results";
  return null;
}

/**
 * The build row's word on linked results: whether the files this paper includes from script runs
 * still match their runs and the shown PDF, with Re-run, Update files and Undo update.
 */
export function LatexResultsStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly rootPath: string;
  /** The shown PDF's build: when it finished, and its `.tex` dependencies' digests. */
  readonly build: {
    readonly finishedAtEpochMs: number;
    readonly digests: Readonly<Record<string, string>> | undefined;
  } | null;
}) {
  const placements = useStableCallback(
    useAtomCommand(computeEnvironment.resultsPlacements, { reportFailure: false }),
  );
  const [result, setResult] = useState<ComputeResultsPlacementsResult | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  // Asking again (focus, an action) changes the key, so the same build is checked again.
  const requestKey = JSON.stringify([
    tick,
    props.build?.finishedAtEpochMs ?? null,
    props.build?.digests ?? {},
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the placed results over the environment connection when the build or project changes
  useEffect(() => {
    let cancelled = false;
    const [, finishedAt, digests] = JSON.parse(requestKey) as [
      number,
      number | null,
      Record<string, string>,
    ];
    void (async () => {
      const response = await placements({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          documentPath: props.rootPath,
          build:
            finishedAt === null
              ? null
              : { finishedAt: new Date(finishedAt).toISOString(), digests },
        },
      });
      if (!cancelled && response._tag === "Success") setResult(response.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [placements, props.environmentId, props.cwd, props.rootPath, requestKey]);

  // Scripts and data change in other tabs and programs; look again when the reader comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus and visibility listeners, held while mounted
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(RESULTS_PLACED_EVENT, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(RESULTS_PLACED_EVENT, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (result === null || result.scripts.length === 0) return null;
  const label = chipLabel(result);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={
              label === null ? "scient-latex-chip" : "scient-latex-chip scient-latex-chip-warning"
            }
            data-latex-results=""
          />
        }
      >
        {label === null ? null : (
          <CircleAlert className="scient-latex-chip-icon" aria-hidden="true" />
        )}
        <span className="scient-latex-chip-text">{label ?? "Results current"}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-96">
        <div className="flex flex-col gap-3 text-xs" data-testid="latex-results">
          {result.scripts.map((script) => (
            <ScriptResults
              key={script.summary.scriptPath}
              environmentId={props.environmentId}
              cwd={props.cwd}
              rootPath={props.rootPath}
              script={script}
              onChanged={() => setTick((value) => value + 1)}
            />
          ))}
          {result.coverage === "placed" ? (
            <span className="text-muted-foreground">
              Checked against Scient's record of placed files; build the PDF to check what it used.
            </span>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ScriptResults(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly rootPath: string;
  readonly script: ComputeResultPlacedScript;
  readonly onChanged: () => void;
}) {
  const { script } = props;
  const scriptPath = script.summary.scriptPath;
  const rerun = useAtomCommand(computeEnvironment.resultsRerun, { reportFailure: false });
  const updateFiles = useAtomCommand(computeEnvironment.resultsUpdateFiles, {
    reportFailure: false,
  });
  const undoUpdate = useAtomCommand(computeEnvironment.resultsUndoUpdate, {
    reportFailure: false,
  });
  const canRerun = useAtomValue(
    computeEnvironment.resultsRerun.permissionAtom(props.environmentId),
  );
  const canWrite = useAtomValue(
    computeEnvironment.resultsUpdateFiles.permissionAtom(props.environmentId),
  );
  const [busy, setBusy] = useState<"rerun" | "update" | "undo" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Edited files the user was warned about, as they were then; confirming replaces only those.
  const [edited, setEdited] = useState<ReadonlyArray<ComputeResultFileDigest>>([]);

  const act = (kind: "rerun" | "update" | "undo", run: () => Promise<void>) => {
    setBusy(kind);
    setMessage(null);
    void run().finally(() => {
      setBusy(null);
      props.onChanged();
    });
  };

  const runAgain = async () => {
    const response = await rerun({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, scriptPath },
    });
    if (response._tag !== "Success")
      setMessage(resultErrorMessage(response, "The script could not run."));
    else if (response.value._tag === "failed") setMessage(response.value.message);
  };

  const applyUpdate = async (
    toRevision: string,
    replaceEdited: ReadonlyArray<ComputeResultFileDigest>,
  ) => {
    const response = await updateFiles({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        documentPath: props.rootPath,
        scriptPath,
        toRevision,
        replaceEdited,
      },
    });
    if (response._tag !== "Success") {
      setMessage(resultErrorMessage(response, "The files could not be updated."));
      return;
    }
    if (response.value._tag === "refused") {
      setMessage(response.value.message);
      setEdited(response.value.edited);
      return;
    }
    setEdited([]);
  };

  const undo = async () => {
    const response = await undoUpdate({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, documentPath: props.rootPath, scriptPath },
    });
    if (response._tag !== "Success")
      setMessage(resultErrorMessage(response, "The update could not be undone."));
    else if (response.value._tag === "refused") setMessage(response.value.message);
  };

  const causes = script.summary.causes;
  const rebuild = usedFiles(script).some((file) => file.differsFromBuild);
  const missing = script.files.some((file) => file.state === "missing");
  return (
    <div className="flex flex-col gap-1.5" data-results-script={scriptPath}>
      <span className="font-medium text-foreground">{scriptPath}</span>
      {causes.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {causes.map((cause) => (
            <li key={`${cause.kind}:${cause.path}`} className="text-foreground">
              {resultCauseText(cause)}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-0.5 text-muted-foreground">
        {script.files.map((file) => (
          <li key={file.path}>
            {fileName(file.path)} · {FILE_STATE_TEXT[file.state]}
            {file.usedByBuild === false ? " · not in this PDF" : ""}
          </li>
        ))}
      </ul>
      {script.interrupted ? (
        <span className="text-foreground">
          The last update of these files stopped part way. Undo update puts the earlier files back.
        </span>
      ) : null}
      {script.newer === null ? null : (
        <span className="text-foreground">
          {script.updateBlocked ??
            (script.newer.causes.length > 0
              ? "A newer run is ready, but it is out of date too."
              : "A newer run is ready.")}
        </span>
      )}
      {script.changes.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-foreground">
          {script.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      ) : null}
      {rebuild && script.newer === null ? (
        <span className="text-muted-foreground">
          The PDF was built before these files changed. Rebuild to see them.
        </span>
      ) : null}
      {message === null ? null : <span className="text-foreground">{message}</span>}
      <div className="flex flex-wrap gap-1.5">
        {canWrite && !script.interrupted && script.newer === null && missing ? (
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => act("update", () => applyUpdate(script.summary.revision, []))}
          >
            {busy === "update" ? "Restoring…" : "Restore missing files"}
          </Button>
        ) : null}
        {canWrite &&
        !script.interrupted &&
        script.newer !== null &&
        script.updateBlocked === null ? (
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => {
              const toRevision = script.newer?.revision;
              if (toRevision !== undefined) act("update", () => applyUpdate(toRevision, edited));
            }}
          >
            {busy === "update"
              ? "Updating…"
              : edited.length > 0
                ? "Replace edited files"
                : "Update files"}
          </Button>
        ) : null}
        {canRerun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => act("rerun", runAgain)}
          >
            {busy === "rerun" ? "Running…" : `Re-run ${fileName(scriptPath)}`}
          </Button>
        ) : null}
        {canWrite && script.canUndo ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => act("undo", undo)}
          >
            {busy === "undo" ? "Undoing…" : "Undo update"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
