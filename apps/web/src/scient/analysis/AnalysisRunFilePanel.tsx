import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AnalysisSourceRevision } from "@t3tools/contracts";
import type {
  AnalysisRunSnapshot,
  AnalysisRunSummary,
  AnalysisRuntimeKind,
  AnalysisRuntimeProfile,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronDown, ChevronUp, LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { analysisEnvironment } from "~/state/analysis";
import { useAtomCommand } from "~/state/use-atom-command";

import { analysisOperationReason } from "./analysisRunUiState";

interface AnalysisRunFilePanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly sourceRevision: string;
  readonly sourcePending: boolean;
  readonly runtimeKind: AnalysisRuntimeKind;
  readonly runtimeLabel: string;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "lost"]);

function resultValue<A, E>(result: AsyncResult.AsyncResult<A, E>): A | null {
  return Option.getOrNull(AsyncResult.value(result));
}

function failureMessage(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The analysis operation failed.";
}

function statusLabel(
  run: AnalysisRunSnapshot | AnalysisRunSummary | null,
  runtimeLabel: string,
): string {
  if (!run) return "No runs yet";
  switch (run.receipt.status) {
    case "queued":
      return "Queued";
    case "starting":
      return `Starting ${runtimeLabel}`;
    case "running":
      return run.receipt.cancellationRequested ? "Stopping" : "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "lost":
      return "Interrupted when Scient closed";
  }
}

function RunOutputView(props: {
  readonly run: AnalysisRunSnapshot;
  readonly runtimeLabel: string;
}) {
  return (
    <ScrollArea className="max-h-64 min-h-24">
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{statusLabel(props.run, props.runtimeLabel)}</span>
          <span>Runs on this environment</span>
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {props.run.receipt.output.length > 0
            ? props.run.receipt.output.map((chunk) => (
                <span
                  key={`${chunk.sequence}:${chunk.observedAt}`}
                  className={chunk.stream === "stderr" ? "text-destructive" : undefined}
                >
                  {chunk.text}
                </span>
              ))
            : (props.run.receipt.failureMessage ?? "Waiting for output…")}
        </pre>
        {props.run.receipt.failureMessage ? (
          <p className="text-xs text-destructive">{props.run.receipt.failureMessage}</p>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function PersistedRunOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly runId: AnalysisRunSnapshot["receipt"]["runId"];
  readonly runtimeLabel: string;
}) {
  const result = useAtomValue(
    analysisEnvironment.run({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, runId: props.runId },
    }),
  );
  const run = resultValue(result);
  if (run) return <RunOutputView run={run} runtimeLabel={props.runtimeLabel} />;
  if (result._tag === "Failure") {
    return <div className="p-3 text-xs text-destructive">Unable to load this run output.</div>;
  }
  return <div className="p-3 text-xs text-muted-foreground">Loading run output…</div>;
}

function runtimeStatus(profile: AnalysisRuntimeProfile | null, runtimeLabel: string): string {
  if (!profile) return `Checking ${runtimeLabel}…`;
  if (profile.availability === "available") {
    const versionLabel = profile.version ? ` ${profile.version}` : "";
    return profile.executablePath
      ? `${runtimeLabel}${versionLabel} · ${profile.executablePath}`
      : `${runtimeLabel}${versionLabel} ready`;
  }
  return profile.detail ?? `${runtimeLabel} is unavailable.`;
}

export function AnalysisRunFilePanel(props: AnalysisRunFilePanelProps) {
  const runtimeAtom = analysisEnvironment.runtimes({
    environmentId: props.environmentId,
    input: { cwd: props.cwd },
  });
  const runsAtom = analysisEnvironment.runs({
    environmentId: props.environmentId,
    input: { cwd: props.cwd, relativePath: props.relativePath, limit: 30 },
  });
  const eventsAtom = analysisEnvironment.runEvents({
    environmentId: props.environmentId,
    input: { cwd: props.cwd, relativePath: props.relativePath },
  });
  const runtimeResult = useAtomValue(runtimeAtom);
  const runsResult = useAtomValue(runsAtom);
  const eventResult = useAtomValue(eventsAtom);
  const refreshRuntime = useAtomRefresh(runtimeAtom);
  const refreshRuns = useAtomRefresh(runsAtom);
  const startRun = useAtomCommand(analysisEnvironment.startRun, { reportFailure: false });
  const cancelRun = useAtomCommand(analysisEnvironment.cancelRun, { reportFailure: false });
  const configureRuntime = useAtomCommand(analysisEnvironment.configureRuntime, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runtimePath, setRuntimePath] = useState("");
  const [operation, setOperation] = useState<"configure" | "run" | "cancel" | null>(null);

  const inspection = resultValue(runtimeResult);
  const profile =
    inspection?.runtimes.find((runtime) => runtime.kind === props.runtimeKind) ?? null;
  const history = resultValue(runsResult)?.runs ?? [];
  const streamedRuns = resultValue(eventResult) ?? [];
  const latestStreamedRunId = streamedRuns[0]?.receipt.runId ?? null;
  const runs = useMemo(() => {
    const byId = new Map<string, AnalysisRunSummary | AnalysisRunSnapshot>(
      history.map((run) => [run.receipt.runId, run]),
    );
    for (const run of streamedRuns) byId.set(run.receipt.runId, run);
    return [...byId.values()].toSorted((left, right) =>
      right.receipt.startedAt.localeCompare(left.receipt.startedAt),
    );
  }, [history, streamedRuns]);
  const selectedRun = runs.find((run) => run.receipt.runId === selectedRunId) ?? runs[0] ?? null;
  const selectedLiveRun =
    streamedRuns.find((run) => run.receipt.runId === selectedRun?.receipt.runId) ?? null;
  const activeRun = streamedRuns.find((run) => !TERMINAL_STATUSES.has(run.receipt.status)) ?? null;
  const projectNotInitialized = analysisOperationReason(runsResult) === "project-not-initialized";

  useEffect(() => {
    if (profile?.executablePath) setRuntimePath(profile.executablePath);
  }, [profile?.executablePath]);

  useEffect(() => {
    if (latestStreamedRunId) {
      setSelectedRunId(latestStreamedRunId);
      setExpanded(true);
    }
  }, [latestStreamedRunId]);

  const reportFailure = (
    title: string,
    result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
  ) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title, description: failureMessage(result) }),
    );
  };

  const handleRun = async () => {
    if (!profile || profile.availability !== "available") {
      setExpanded(true);
      return;
    }
    setOperation("run");
    const result = await startRun({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        relativePath: props.relativePath,
        sourceRevision: AnalysisSourceRevision.make(props.sourceRevision),
        runtimeId: profile.id,
      },
    });
    setOperation(null);
    if (result._tag === "Success") {
      setSelectedRunId(result.value.receipt.runId);
      setExpanded(true);
      refreshRuns();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure(`Unable to run ${props.runtimeLabel} file`, result);
      refreshRuntime();
    }
  };

  const handleCancel = async () => {
    if (!activeRun) return;
    setOperation("cancel");
    const result = await cancelRun({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, runId: activeRun.receipt.runId },
    });
    setOperation(null);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      reportFailure(`Unable to stop ${props.runtimeLabel}`, result);
    }
  };

  const handleConfigure = async () => {
    setOperation("configure");
    const result = await configureRuntime({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        runtimeKind: props.runtimeKind,
        executablePath: runtimePath.trim() || null,
      },
    });
    setOperation(null);
    if (result._tag === "Success") {
      refreshRuntime();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure(`Unable to configure ${props.runtimeLabel}`, result);
    }
  };

  const runtimeReady = profile?.availability === "available";
  const runDisabled =
    props.sourcePending ||
    runsResult.waiting ||
    projectNotInitialized ||
    activeRun !== null ||
    operation !== null ||
    !runtimeReady;

  return (
    <section
      className="shrink-0 border-t border-border bg-muted/20"
      aria-label={`${props.runtimeLabel} Run File`}
    >
      <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
        {activeRun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={operation !== null || activeRun.receipt.cancellationRequested}
            onClick={handleCancel}
          >
            {operation === "cancel" ? <LoaderCircle className="animate-spin" /> : <Square />}
            Stop
          </Button>
        ) : (
          <Button size="xs" disabled={runDisabled} onClick={handleRun}>
            {operation === "run" ? <LoaderCircle className="animate-spin" /> : <Play />}
            {props.sourcePending ? "Saving…" : "Run file"}
          </Button>
        )}
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={runtimeStatus(profile, props.runtimeLabel)}
        >
          {activeRun
            ? statusLabel(activeRun, props.runtimeLabel)
            : projectNotInitialized
              ? "Set up this folder as a Scient project to run"
              : runtimeStatus(profile, props.runtimeLabel)}
        </span>
        {runs.length > 1 ? (
          <select
            className="max-w-44 rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={selectedRun?.receipt.runId ?? ""}
            onChange={(event) => {
              setSelectedRunId(event.target.value);
              setExpanded(true);
            }}
            aria-label={`Local ${props.runtimeLabel} run history`}
          >
            {runs.map((run) => (
              <option key={run.receipt.runId} value={run.receipt.runId}>
                {statusLabel(run, props.runtimeLabel)} ·{" "}
                {new Date(run.receipt.startedAt).toLocaleTimeString()}
              </option>
            ))}
          </select>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={
            expanded
              ? `Collapse ${props.runtimeLabel} output`
              : `Expand ${props.runtimeLabel} output`
          }
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </div>

      {expanded ? (
        <div className="border-t border-border">
          {projectNotInitialized ? (
            <div className="p-3 text-xs text-muted-foreground">
              Set up this folder as a Scient project before running analysis files. Viewing and
              editing remain available.
            </div>
          ) : !runtimeReady ? (
            <div className="space-y-2 p-3">
              <p className="text-xs text-muted-foreground">
                {runtimeResult._tag === "Failure"
                  ? `Unable to inspect ${props.runtimeLabel} on this environment.`
                  : (profile?.detail ?? `Checking for ${props.runtimeLabel} on this environment.`)}
              </p>
              <div className="flex gap-2">
                <Input
                  size="sm"
                  value={runtimePath}
                  placeholder={`Path to ${props.runtimeLabel} executable`}
                  onValueChange={setRuntimePath}
                  aria-label={`${props.runtimeLabel} executable path`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={operation !== null}
                  onClick={handleConfigure}
                >
                  {operation === "configure" ? <LoaderCircle className="animate-spin" /> : null}
                  Use path
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => refreshRuntime()}
                  aria-label={`Scan for ${props.runtimeLabel} again`}
                >
                  <RotateCcw />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Viewing and editing the file does not require {props.runtimeLabel}. Scient launches
                it only when you press Run file.
              </p>
            </div>
          ) : null}
          {!projectNotInitialized && selectedLiveRun ? (
            <RunOutputView run={selectedLiveRun} runtimeLabel={props.runtimeLabel} />
          ) : !projectNotInitialized && selectedRun ? (
            <PersistedRunOutput
              environmentId={props.environmentId}
              cwd={props.cwd}
              runId={selectedRun.receipt.runId}
              runtimeLabel={props.runtimeLabel}
            />
          ) : !projectNotInitialized && runtimeReady ? (
            <div className="p-3 text-xs text-muted-foreground">
              Run this project-owned source file to stream {props.runtimeLabel} output here.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
