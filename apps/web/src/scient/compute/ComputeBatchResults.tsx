import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AnalysisRunId,
  AnalysisSourceRevision,
  ComputeLanguageId,
  resolveScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useCancelComputeBatchRun } from "./useCancelComputeBatchRun";
import { randomUUID } from "~/lib/utils";
import type {
  AnalysisRunSnapshot,
  AnalysisRunSummary,
  AnalysisDiagnostic,
  AnalysisRuntimeKind,
  AnalysisRuntimeProfile,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FolderDown,
  LoaderCircle,
  Play,
  Square,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { analysisEnvironment } from "~/state/analysis";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  analysisOperationReason,
  analysisRunIdToAutoExpand,
  emptyAnalysisRunOutputLabel,
  isTerminalAnalysisRunStatus,
} from "../analysis/analysisRunUiState";
import { AnalysisArtifactStrip } from "../analysis/AnalysisArtifactStrip";
import {
  artifactDisplayStatus,
  runForArtifactDisplay,
} from "../analysis/analysisArtifactPresentation";

export interface ComputeBatchSource {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly sourceRevision: string;
  readonly sourcePending: boolean;
  readonly runtimeKind: AnalysisRuntimeKind;
  readonly runtimeLabel: string;
}

function resultValue<A, E>(result: AsyncResult.AsyncResult<A, E>): A | null {
  return Option.getOrNull(AsyncResult.value(result));
}

function failureMessage(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The analysis operation failed.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function withOccurrenceKeys<A>(
  values: ReadonlyArray<A>,
  keyFor: (value: A) => string,
): ReadonlyArray<{ readonly key: string; readonly value: A }> {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const base = keyFor(value);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}:${occurrence}`, value };
  });
}

function diagnosticFrameKey(frame: AnalysisDiagnostic["frames"][number]): string {
  return [frame.relativePath ?? "external", frame.functionName ?? "", frame.line ?? 0].join(":");
}

function outputSegments(chunks: AnalysisRunSnapshot["receipt"]["output"]) {
  const segments: Array<{
    readonly firstSequence: number;
    readonly stream: AnalysisRunSnapshot["receipt"]["output"][number]["stream"];
    text: string;
  }> = [];
  for (const chunk of chunks) {
    const previous = segments.at(-1);
    if (previous?.stream === chunk.stream) {
      previous.text += chunk.text;
    } else {
      segments.push({ firstSequence: chunk.sequence, stream: chunk.stream, text: chunk.text });
    }
  }
  return segments;
}

function statusLabel(
  run: AnalysisRunSnapshot | AnalysisRunSummary | null,
  runtimeLabel: string,
): string {
  if (!run) return "No runs yet";
  switch (run.receipt.status) {
    case "queued":
      return run.queuePosition ? `Waiting · ${run.queuePosition} in queue` : "Waiting";
    case "starting":
      return run.phase === "launching" ? `Launching ${runtimeLabel}` : `Starting ${runtimeLabel}`;
    case "running":
      if (run.receipt.cancellationRequested) return "Stopping";
      if (run.phase === "capturing") return "Capturing figures";
      if (run.phase === "publishing") return "Publishing figures";
      return "Running";
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
  readonly threadRef: ScopedThreadRef;
  readonly onAskAboutDiagnostic: (
    diagnostic: AnalysisDiagnostic,
    runId: AnalysisRunSnapshot["receipt"]["runId"],
  ) => void;
}) {
  const segments = useMemo(
    () => outputSegments(props.run.receipt.output),
    [props.run.receipt.output],
  );
  const output = (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
      {segments.length > 0
        ? segments.map((segment) => (
            <span
              key={segment.firstSequence}
              className={segment.stream === "stderr" ? "text-destructive" : undefined}
            >
              {segment.text}
            </span>
          ))
        : emptyAnalysisRunOutputLabel(props.run.receipt.status)}
    </pre>
  );
  return (
    <ScrollArea className="max-h-64 min-h-24">
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{statusLabel(props.run, props.runtimeLabel)}</span>
          <ScientTooltip content={props.run.source.cwd}>
            <span className="max-w-[50%] truncate font-mono">{props.run.source.cwd}</span>
          </ScientTooltip>
        </div>
        {props.run.diagnostics.map((diagnostic) => (
          <div
            key={diagnostic.diagnosticId}
            className="space-y-1 rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs"
          >
            <div className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">
                  {diagnostic.code ? `${diagnostic.code}: ` : ""}
                  {diagnostic.message}
                </p>
                {diagnostic.relativePath ? (
                  <button
                    type="button"
                    className="mt-1 font-mono text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() =>
                      useRightPanelStore
                        .getState()
                        .openFile(
                          props.threadRef,
                          diagnostic.relativePath!,
                          diagnostic.line ?? undefined,
                        )
                    }
                  >
                    {diagnostic.relativePath}
                    {diagnostic.line ? `:${diagnostic.line}` : ""}
                  </button>
                ) : null}
                {diagnostic.frames.length > 0 ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">
                      Stack frames
                    </summary>
                    <div className="mt-1 flex flex-col items-start gap-0.5">
                      {withOccurrenceKeys(diagnostic.frames.slice(0, 20), diagnosticFrameKey).map(
                        ({ key, value: frame }) =>
                          frame.relativePath ? (
                            <ScientTooltip
                              key={key}
                              content={`${frame.relativePath}${frame.line ? `:${frame.line}` : ""}`}
                            >
                              <button
                                type="button"
                                className="max-w-full truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                                onClick={() =>
                                  useRightPanelStore
                                    .getState()
                                    .openFile(
                                      props.threadRef,
                                      frame.relativePath!,
                                      frame.line ?? undefined,
                                    )
                                }
                              >
                                {frame.functionName ? `${frame.functionName} · ` : ""}
                                {frame.relativePath}
                                {frame.line ? `:${frame.line}` : ""}
                              </button>
                            </ScientTooltip>
                          ) : (
                            <span key={key} className="font-mono text-[11px] text-muted-foreground">
                              {frame.functionName ?? "External MATLAB frame"}
                              {frame.line ? `:${frame.line}` : ""}
                            </span>
                          ),
                      )}
                    </div>
                  </details>
                ) : null}
                {diagnostic.related.length > 0 ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">
                      {diagnostic.related.length} related cause
                      {diagnostic.related.length === 1 ? "" : "s"}
                    </summary>
                    <div className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                      {withOccurrenceKeys(
                        diagnostic.related,
                        (related) => `${related.code ?? "cause"}:${related.message}`,
                      ).map(({ key, value: related }) => (
                        <div key={key} className="space-y-0.5">
                          <p>
                            {related.code ? `${related.code}: ` : ""}
                            {related.message}
                          </p>
                          {withOccurrenceKeys(related.frames.slice(0, 5), diagnosticFrameKey).map(
                            ({ key: frameKey, value: frame }) =>
                              frame.relativePath ? (
                                <button
                                  key={frameKey}
                                  type="button"
                                  className="block max-w-full truncate font-mono underline-offset-2 hover:underline"
                                  onClick={() =>
                                    useRightPanelStore
                                      .getState()
                                      .openFile(
                                        props.threadRef,
                                        frame.relativePath!,
                                        frame.line ?? undefined,
                                      )
                                  }
                                >
                                  {frame.functionName ? `${frame.functionName} · ` : ""}
                                  {frame.relativePath}
                                  {frame.line ? `:${frame.line}` : ""}
                                </button>
                              ) : null,
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => props.onAskAboutDiagnostic(diagnostic, props.run.receipt.runId)}
              >
                Ask agent
              </Button>
            </div>
          </div>
        ))}
        {props.run.diagnostics.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              Raw {props.runtimeLabel} output
            </summary>
            <div className="pt-2">{output}</div>
          </details>
        ) : (
          output
        )}
        {props.run.receipt.outputTruncated ? (
          <p className="text-xs text-muted-foreground">
            Output was truncated at the run capture limit.
          </p>
        ) : null}
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
  readonly threadRef: ScopedThreadRef;
  readonly onAskAboutDiagnostic: (
    diagnostic: AnalysisDiagnostic,
    runId: AnalysisRunSnapshot["receipt"]["runId"],
  ) => void;
  readonly storageStatus: AnalysisRunSummary["localStorage"]["status"];
}) {
  const runAtom = analysisEnvironment.run({
    environmentId: props.environmentId,
    input: { cwd: props.cwd, runId: props.runId },
  });
  const result = useAtomValue(runAtom);
  const refreshRun = useAtomRefresh(runAtom);
  useEffect(() => refreshRun(), [props.storageStatus, refreshRun]);
  const run = resultValue(result);
  if (run)
    return (
      <RunOutputView
        run={run}
        runtimeLabel={props.runtimeLabel}
        threadRef={props.threadRef}
        onAskAboutDiagnostic={props.onAskAboutDiagnostic}
      />
    );
  if (result._tag === "Failure") {
    return <div className="p-3 text-xs text-destructive">Unable to load this run output.</div>;
  }
  return <div className="p-3 text-xs text-muted-foreground">Loading run output…</div>;
}

function runtimeStatus(profile: AnalysisRuntimeProfile | null, runtimeLabel: string): string {
  if (!profile) return `Checking ${runtimeLabel}…`;
  if (profile.availability === "available") {
    const versionLabel = profile.version ? ` ${profile.version}` : "";
    if (profile.verification?.status === "ready") return `${runtimeLabel}${versionLabel} · Ready`;
    if (profile.verification) {
      const statusLabel = {
        "needs-sign-in": "Sign-in required",
        "license-unavailable": "License unavailable",
        "missing-dependency": "Missing dependency",
        "startup-failed": "Startup failed",
        "timed-out": "Verification timed out",
        unknown: "Status unknown",
      }[profile.verification.status];
      return `${runtimeLabel}${versionLabel} · ${statusLabel}`;
    }
    return `${runtimeLabel}${versionLabel}`;
  }
  return profile.detail ?? `${runtimeLabel} is unavailable.`;
}

const EMPTY_RUNS: ReadonlyArray<AnalysisRunSnapshot> = [];

export interface ComputeBatchRunOptions {
  /** Reserve the identity in the tab owner before sending the start RPC. */
  readonly onRunReserved?: (runId: AnalysisRunSnapshot["receipt"]["runId"]) => boolean;
  readonly onStartRejected?: (runId: AnalysisRunSnapshot["receipt"]["runId"]) => void;
  /** Persist this AnalysisRun ID in the parent owner, independently of the Results mount. */
  readonly runId?: AnalysisRunSnapshot["receipt"]["runId"] | null;
  /** Called before start() resolves so the owner can retain the accepted transport identity. */
  readonly onRunStarted?: (run: AnalysisRunSnapshot) => void;
}

/**
 * Own this hook in the tab lifecycle, keyed by environment, cwd, path and runtime kind.
 * Mounting results never starts a process. Await cancel() before disposing the owner.
 * Cancellation success means the request was accepted, not that the process has exited.
 */
export function useComputeBatchRun(
  source: ComputeBatchSource,
  options: ComputeBatchRunOptions = {},
) {
  const onRunStarted = options.onRunStarted;
  const onRunReserved = options.onRunReserved;
  const onStartRejected = options.onStartRejected;
  const enabled = useEnvironmentSettings(
    source.environmentId,
    (settings) =>
      resolveScientificComputingLanguageSettings(
        settings.scientificComputing,
        ComputeLanguageId.make(source.runtimeKind),
      ).enabled,
  );
  const runtimeAtom = analysisEnvironment.runtimes({
    environmentId: source.environmentId,
    input: { cwd: source.cwd },
  });
  const eventsAtom = analysisEnvironment.runEvents({
    environmentId: source.environmentId,
    input: { cwd: source.cwd, relativePath: source.relativePath },
  });
  const runtimeResult = useAtomValue(runtimeAtom);
  const eventResult = useAtomValue(eventsAtom);
  const refreshRuntime = useAtomRefresh(runtimeAtom);
  const startRun = useAtomCommand(analysisEnvironment.startRun, { reportFailure: false });
  const cancelById = useCancelComputeBatchRun();
  const restoredRun = useEnvironmentQuery(
    options.runId
      ? analysisEnvironment.run({
          environmentId: source.environmentId,
          input: { cwd: source.cwd, runId: options.runId },
        })
      : null,
  ).data;
  const inspection = resultValue(runtimeResult);
  const profile =
    inspection?.runtimes.find((runtime) => runtime.kind === source.runtimeKind) ?? null;
  const streamedRunValue = resultValue(eventResult);
  const streamedRuns = streamedRunValue ?? EMPTY_RUNS;
  const [submittedRun, setSubmittedRun] = useState<AnalysisRunSnapshot | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const pendingStart = useRef<Promise<AnalysisRunSnapshot | null> | null>(null);
  const pendingOwnedRunId = useRef<AnalysisRunSnapshot["receipt"]["runId"] | null>(null);
  const pendingCancel = useRef<Promise<boolean> | null>(null);
  const submittedRunRef = useRef<AnalysisRunSnapshot | null>(null);
  const streamedRunsRef = useRef(streamedRuns);
  useEffect(() => {
    streamedRunsRef.current = streamedRuns;
    const observed = streamedRuns.find(
      (run) => run.receipt.runId === submittedRunRef.current?.receipt.runId,
    );
    if (observed) {
      submittedRunRef.current = observed;
      // Keep a terminal fallback when the bounded subscription later evicts this run.
      if (isTerminalAnalysisRunStatus(observed.receipt.status)) {
        setSubmittedRun((current) =>
          current && !isTerminalAnalysisRunStatus(current.receipt.status) ? observed : current,
        );
      }
    }
  }, [streamedRuns]);
  const runId = options.runId ?? submittedRun?.receipt.runId ?? null;
  const latestSubmittedRun =
    streamedRuns.find((run) => run.receipt.runId === runId) ??
    (restoredRun?.receipt.runId === runId ? restoredRun : null) ??
    (submittedRun?.receipt.runId === runId ? submittedRun : null);
  const activeRun =
    (onRunReserved === undefined
      ? streamedRuns.find((run) => !isTerminalAnalysisRunStatus(run.receipt.status))
      : null) ??
    (latestSubmittedRun && !isTerminalAnalysisRunStatus(latestSubmittedRun.receipt.status)
      ? latestSubmittedRun
      : null);
  const canStart =
    enabled &&
    !source.sourcePending &&
    profile?.availability === "available" &&
    streamedRunValue !== null &&
    (!options.runId || latestSubmittedRun !== null) &&
    !activeRun &&
    !isStarting &&
    !isCancelling;

  const start = useCallback((): Promise<AnalysisRunSnapshot | null> => {
    if (pendingStart.current) return pendingStart.current;
    const submitted = submittedRunRef.current;
    const current =
      streamedRunsRef.current.find((run) => run.receipt.runId === submitted?.receipt.runId) ??
      submitted;
    if (
      !canStart ||
      pendingCancel.current ||
      (current && !isTerminalAnalysisRunStatus(current.receipt.status)) ||
      !profile
    ) {
      return Promise.resolve(null);
    }
    setIsStarting(true);
    const requestedRunId = AnalysisRunId.make(randomUUID());
    if (onRunReserved?.(requestedRunId) === false) {
      setIsStarting(false);
      return Promise.resolve(null);
    }
    pendingOwnedRunId.current = onRunReserved ? requestedRunId : null;
    const promise = (async () => {
      const result = await startRun({
        environmentId: source.environmentId,
        input: {
          runId: requestedRunId,
          cwd: source.cwd,
          relativePath: source.relativePath,
          sourceRevision: AnalysisSourceRevision.make(source.sourceRevision),
          runtimeId: profile.id,
        },
      });
      if (result._tag === "Success") {
        if (onRunReserved !== undefined && result.value.receipt.runId !== requestedRunId) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to confirm batch run",
              description: "The server returned a different run. The requested owner is retained.",
            }),
          );
          return null;
        }
        submittedRunRef.current = result.value;
        setSubmittedRun(result.value);
        onRunStarted?.(result.value);
        return result.value;
      }
      if (!isAtomCommandInterrupted(result)) {
        const reason = analysisOperationReason(result);
        if (
          reason !== null &&
          [
            "invalid-source",
            "source-changed",
            "runtime-invalid",
            "runtime-missing",
            "run-already-active",
          ].includes(reason)
        ) {
          onStartRejected?.(requestedRunId);
        }
        reportFailure(`Unable to run ${source.runtimeLabel} file`, result);
        refreshRuntime();
      }
      return null;
    })()
      .catch(() => {
        // A disconnected response does not prove the server rejected the run.
        // Keep the reserved owner so closing the tab can reconcile/cancel it.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to confirm batch run",
            description:
              "Check the connection before trying again. The run remains owned by this tab.",
          }),
        );
        return null;
      })
      .finally(() => {
        pendingStart.current = null;
        pendingOwnedRunId.current = null;
        setIsStarting(false);
      });
    pendingStart.current = promise;
    return promise;
  }, [
    canStart,
    profile,
    refreshRuntime,
    source.environmentId,
    source.cwd,
    source.relativePath,
    source.sourceRevision,
    source.runtimeLabel,
    startRun,
    onRunStarted,
    onRunReserved,
    onStartRejected,
  ]);

  const cancel = useCallback((): Promise<boolean> => {
    if (pendingCancel.current) return pendingCancel.current;
    setIsCancelling(true);
    const promise = (async () => {
      // The tab has already reserved this identity. Do not wait for a delayed
      // start response before sending Stop; server admission serializes the two.
      const pendingId = pendingOwnedRunId.current;
      if (pendingId !== null) {
        return cancelById({
          environmentId: source.environmentId,
          cwd: source.cwd,
          runId: pendingId,
          waitForExit: true,
        });
      }
      // A tab can close before startRun has returned its run ID.
      const starting = pendingStart.current;
      const started = starting ? await starting : submittedRunRef.current;
      const latest =
        streamedRunsRef.current.find((run) => run.receipt.runId === started?.receipt.runId) ??
        started;
      // The parent's controlled ID may still name the preceding run in this microtask.
      const ownedRunId =
        starting || (latest && !isTerminalAnalysisRunStatus(latest.receipt.status))
          ? started?.receipt.runId
          : options.runId;
      const target = ownedRunId
        ? (streamedRunsRef.current.find((run) => run.receipt.runId === ownedRunId) ??
          (latest?.receipt.runId === ownedRunId
            ? latest
            : restoredRun?.receipt.runId === ownedRunId
              ? restoredRun
              : null))
        : (streamedRunsRef.current.find(
            (run) => !isTerminalAnalysisRunStatus(run.receipt.status),
          ) ?? latest);
      if (
        target &&
        (isTerminalAnalysisRunStatus(target.receipt.status) || target.receipt.cancellationRequested)
      )
        return true;
      const targetId = ownedRunId ?? target?.receipt.runId;
      if (!targetId) return true;
      return cancelById({
        environmentId: source.environmentId,
        cwd: source.cwd,
        runId: targetId,
      });
    })().finally(() => {
      pendingCancel.current = null;
      setIsCancelling(false);
    });
    pendingCancel.current = promise;
    return promise;
  }, [cancelById, source.environmentId, source.cwd, options.runId, restoredRun]);

  return {
    source,
    runtimeResult,
    profile,
    streamedRunValue,
    streamedRuns,
    activeRun,
    submittedRun,
    runId,
    isOwned: options.runId !== undefined || onRunReserved !== undefined,
    restoredRun,
    isStarting,
    isCancelling,
    canStart,
    start,
    cancel,
  };
}

export type ComputeBatchRunModel = ReturnType<typeof useComputeBatchRun>;

export interface ComputeBatchResultsProps {
  readonly model: ComputeBatchRunModel;
  /** The parent toolbar may own Run; stopping an owned batch remains available here. */
  readonly showRunControls?: boolean;
  readonly resultPicker?: ReactNode;
}

function reportFailure(
  title: string,
  result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
) {
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: failureMessage(result) }),
  );
}

export function ComputeBatchResults({
  model,
  showRunControls = false,
  resultPicker,
}: ComputeBatchResultsProps) {
  const props = model.source;
  const { runtimeResult, profile, streamedRunValue, streamedRuns, activeRun } = model;
  const inspection = resultValue(runtimeResult);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadedHistory, setLoadedHistory] = useState<ReadonlyArray<AnalysisRunSummary>>([]);
  const runsAtom = analysisEnvironment.runs({
    environmentId: props.environmentId,
    input: {
      cwd: props.cwd,
      relativePath: props.relativePath,
      limit: 30,
      ...(historyCursor === null ? {} : { cursor: historyCursor }),
    },
  });
  const storageAtom = analysisEnvironment.storage({
    environmentId: props.environmentId,
    input: { cwd: props.cwd },
  });
  const runsResult = useAtomValue(runsAtom);
  const storageResult = useAtomValue(storageAtom);
  const refreshRuns = useAtomRefresh(runsAtom);
  const refreshStorage = useAtomRefresh(storageAtom);
  const cleanupRun = useAtomCommand(analysisEnvironment.cleanupRun, { reportFailure: false });
  const cleanupProject = useAtomCommand(analysisEnvironment.cleanupProject, {
    reportFailure: false,
  });
  const promoteRun = useAtomCommand(analysisEnvironment.promoteRun, { reportFailure: false });
  const [expanded, setExpanded] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [operation, setOperation] = useState<"cleanup-run" | "cleanup-project" | "promote" | null>(
    null,
  );
  const refreshedTerminalRunIdRef = useRef<string | null>(null);
  const observedStreamRunIdsRef = useRef<Set<string> | null>(null);

  const historyPage = resultValue(runsResult);
  const history = loadedHistory;
  const runs = useMemo(() => {
    const byId = new Map<string, AnalysisRunSummary | AnalysisRunSnapshot>(
      history.map((run) => [run.receipt.runId, run]),
    );
    if (model.restoredRun) byId.set(model.restoredRun.receipt.runId, model.restoredRun);
    if (model.submittedRun && !byId.has(model.submittedRun.receipt.runId)) {
      byId.set(model.submittedRun.receipt.runId, model.submittedRun);
    }
    for (const run of streamedRuns) byId.set(run.receipt.runId, run);
    return [...byId.values()].toSorted((left, right) =>
      right.receipt.startedAt.localeCompare(left.receipt.startedAt),
    );
  }, [history, streamedRuns, model.submittedRun, model.restoredRun]);
  const targetRunId = model.isOwned ? model.runId : (selectedRunId ?? model.runId);
  const selectedRun =
    (targetRunId === null
      ? model.isOwned
        ? null
        : runs[0]
      : runs.find((run) => run.receipt.runId === targetRunId)) ?? null;
  const awaitingOwnedRun =
    model.runId !== null && !runs.some((run) => run.receipt.runId === model.runId);
  const selectedLiveRun =
    streamedRuns.find((run) => run.receipt.runId === selectedRun?.receipt.runId) ??
    (model.submittedRun === selectedRun ? model.submittedRun : null) ??
    (model.restoredRun === selectedRun ? model.restoredRun : null);
  const latestTerminalRunId =
    streamedRuns.find((run) => isTerminalAnalysisRunStatus(run.receipt.status))?.receipt.runId ??
    null;
  // A controlled child owns one exact result, including its figures. The legacy
  // history view may retain an older visual during a rerun, but not another child.
  const artifactRun = model.isOwned
    ? selectedRun && selectedRun.artifacts.length > 0
      ? selectedRun
      : null
    : runForArtifactDisplay(runs, selectedRun);
  const artifactStatus = artifactRun
    ? artifactDisplayStatus({
        artifactRun,
        selectedRun,
        activeRun,
        sourceRevision: props.sourceRevision,
      })
    : null;
  const storage = resultValue(storageResult);
  const projectNotInitialized = analysisOperationReason(runsResult) === "project-not-initialized";

  useEffect(() => {
    setHistoryCursor(null);
    setLoadedHistory([]);
  }, [props.cwd, props.relativePath]);

  useEffect(() => {
    if (!historyPage) return;
    setLoadedHistory((current) => {
      if (historyCursor === null) return historyPage.runs;
      const byId = new Map(current.map((run) => [run.receipt.runId, run]));
      for (const run of historyPage.runs) byId.set(run.receipt.runId, run);
      return [...byId.values()].toSorted((left, right) =>
        right.receipt.startedAt.localeCompare(left.receipt.startedAt),
      );
    });
  }, [historyCursor, historyPage]);

  useEffect(() => {
    if (streamedRunValue === null) return;
    // Other tabs may run the same file. Their events do not change this owner's view.
    if (model.runId !== null) return;
    const nextObserved = new Set(streamedRuns.map((run) => run.receipt.runId));
    const previousObserved = observedStreamRunIdsRef.current;
    observedStreamRunIdsRef.current = new Set([...(previousObserved ?? []), ...nextObserved]);
    // Selecting history stays passive; only newly observed runs reopen collapsed output.
    const runIdToExpand = analysisRunIdToAutoExpand(streamedRuns, previousObserved);
    if (!runIdToExpand) return;
    setSelectedRunId(runIdToExpand);
    setExpanded(true);
  }, [streamedRunValue, streamedRuns, model.runId]);

  useEffect(() => {
    if (!latestTerminalRunId || refreshedTerminalRunIdRef.current === latestTerminalRunId) return;
    refreshedTerminalRunIdRef.current = latestTerminalRunId;
    setHistoryCursor(null);
    setLoadedHistory([]);
    refreshRuns();
  }, [latestTerminalRunId, refreshRuns]);

  const handleCleanupRun = async () => {
    if (!selectedRun || selectedRun.localStorage.status !== "retained") return;
    const retained = selectedRun.localStorage.totalBytes;
    if (
      !globalThis.confirm(
        `Remove ${formatBytes(retained)} of local output and artifacts from this run? Its status, diagnostics, hashes, and provenance will remain in history.`,
      )
    ) {
      return;
    }
    setOperation("cleanup-run");
    const result = await cleanupRun({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, runId: selectedRun.receipt.runId },
    });
    setOperation(null);
    if (result._tag === "Success") {
      setHistoryCursor(null);
      setLoadedHistory([]);
      refreshRuns();
      refreshStorage();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Unable to remove local run data", result);
      setHistoryCursor(null);
      setLoadedHistory([]);
      refreshRuns();
      refreshStorage();
    }
  };

  const handleCleanupProject = async () => {
    if (!storage || storage.totalBytes === 0) return;
    if (
      !globalThis.confirm(
        `Remove ${formatBytes(storage.totalBytes)} of retained ${props.runtimeLabel} output and artifacts across ${storage.retainedRunCount} local runs? Run metadata, diagnostics, hashes, and provenance will remain.`,
      )
    ) {
      return;
    }
    setOperation("cleanup-project");
    const result = await cleanupProject({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, expectedRetainedBytes: storage.totalBytes },
    });
    setOperation(null);
    if (result._tag === "Success") {
      setHistoryCursor(null);
      setLoadedHistory([]);
      refreshRuns();
      refreshStorage();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Unable to clean up local analysis data", result);
      setHistoryCursor(null);
      setLoadedHistory([]);
      refreshRuns();
      refreshStorage();
    }
  };

  const handlePromoteRun = async () => {
    if (
      !selectedRun ||
      selectedRun.localStorage.status !== "retained" ||
      !isTerminalAnalysisRunStatus(selectedRun.receipt.status)
    ) {
      return;
    }
    setOperation("promote");
    const result = await promoteRun({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, runId: selectedRun.receipt.runId },
    });
    setOperation(null);
    if (result._tag === "Success") {
      useRightPanelStore.getState().openFile(props.threadRef, result.value.readmeRelativePath);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: result.value.reused ? "Project result already saved" : "Saved result to project",
          description: result.value.directoryRelativePath,
        }),
      );
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Unable to save result to project", result);
    }
  };

  const askAboutDiagnostic = (
    diagnostic: AnalysisDiagnostic,
    runId: AnalysisRunSnapshot["receipt"]["runId"],
  ) => {
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(props.threadRef)?.prompt ?? "";
    const location = diagnostic.relativePath
      ? `${diagnostic.relativePath}${diagnostic.line ? `:${diagnostic.line}` : ""}`
      : props.relativePath;
    const request = `Please diagnose and fix this ${props.runtimeLabel} error in ${location}. Scient analysis run ID: ${runId}; diagnostic ID: ${diagnostic.diagnosticId}.\n\n${diagnostic.code ? `${diagnostic.code}: ` : ""}${diagnostic.message}`;
    store.setPrompt(
      props.threadRef,
      current.trim().length > 0 ? `${current}\n\n${request}` : request,
    );
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Added ${props.runtimeLabel} error to the composer`,
        description: "Review the request, then send it to your agent.",
      }),
    );
  };

  const runtimeReady = profile?.availability === "available";
  const runtimeInspectionPending = inspection === null && runtimeResult._tag !== "Failure";
  const primaryActionIsSetup = !projectNotInitialized && !runtimeReady && !runtimeInspectionPending;
  const primaryActionDisabled = primaryActionIsSetup
    ? operation !== null
    : props.sourcePending ||
      runsResult.waiting ||
      projectNotInitialized ||
      activeRun !== null ||
      operation !== null ||
      !model.canStart;
  const runtimeStatusText =
    runtimeResult._tag === "Failure" && profile === null
      ? `Unable to check ${props.runtimeLabel}`
      : runtimeStatus(profile, props.runtimeLabel);

  const busy = operation !== null || model.isStarting || model.isCancelling;
  const operationStatus = model.isStarting
    ? "Verifying source"
    : model.isCancelling
      ? "Stopping"
      : operation === "promote"
        ? "Saving result to project…"
        : operation
          ? "Removing local data…"
          : null;
  const submittedRunId = model.runId;
  useEffect(() => {
    if (!submittedRunId) return;
    setSelectedRunId(submittedRunId);
    setExpanded(true);
    setHistoryCursor(null);
    refreshRuns();
  }, [submittedRunId, refreshRuns]);
  return (
    <section
      className="shrink-0 border-t border-border bg-muted/20"
      aria-label={`${props.runtimeLabel} batch Results`}
    >
      <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
        {resultPicker}
        {activeRun || model.isStarting || awaitingOwnedRun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={model.isCancelling || activeRun?.receipt.cancellationRequested}
            onClick={() => void model.cancel()}
          >
            {model.isCancelling ? <LoaderCircle className="animate-spin" /> : <Square />}
            Stop
          </Button>
        ) : showRunControls ? (
          <Button
            size="xs"
            disabled={primaryActionDisabled || busy}
            onClick={primaryActionIsSetup ? undefined : () => void model.start()}
            {...(primaryActionIsSetup
              ? {
                  render: (
                    <Link
                      to="/settings/scientific-computing"
                      search={{ environmentId: props.environmentId }}
                    />
                  ),
                }
              : {})}
          >
            {model.isStarting ? (
              <LoaderCircle className="animate-spin" />
            ) : primaryActionIsSetup ? null : (
              <Play />
            )}
            {primaryActionIsSetup
              ? `Set up ${props.runtimeLabel}`
              : props.sourcePending
                ? "Saving…"
                : "Run MATLAB batch"}
          </Button>
        ) : null}
        <ScientTooltip content={runtimeStatusText}>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {activeRun
              ? statusLabel(activeRun, props.runtimeLabel)
              : operationStatus
                ? operationStatus
                : projectNotInitialized
                  ? "Set up this folder as a Scient project to run"
                  : runtimeStatusText}
          </span>
        </ScientTooltip>
        {!model.isOwned && runs.length > 1 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="max-w-44"
                  aria-label={`Local ${props.runtimeLabel} run history`}
                >
                  <span className="truncate">
                    {selectedRun
                      ? `${statusLabel(selectedRun, props.runtimeLabel)} · ${new Date(selectedRun.receipt.startedAt).toLocaleTimeString()}`
                      : "Run history"}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0" />
                </Button>
              }
            />
            <MenuPopup align="end" side="bottom" className="min-w-48">
              <MenuRadioGroup
                value={selectedRun?.receipt.runId ?? ""}
                onValueChange={(runId) => {
                  setSelectedRunId(runId);
                  setExpanded(true);
                }}
              >
                {runs.map((run) => (
                  <MenuRadioItem key={run.receipt.runId} value={run.receipt.runId} size="compact">
                    {statusLabel(run, props.runtimeLabel)} ·{" "}
                    {new Date(run.receipt.startedAt).toLocaleTimeString()}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
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

      {artifactRun && artifactStatus && artifactRun.localStorage.status === "retained" ? (
        <AnalysisArtifactStrip
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          run={artifactRun}
          status={artifactStatus}
        />
      ) : null}

      {selectedRun?.artifactReceipt.status === "failed" ? (
        <div
          className="border-t border-warning/30 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          {selectedRun.artifactReceipt.failureMessage ??
            "The run finished, but Scient could not collect its generated figures."}
        </div>
      ) : null}

      {expanded ? (
        <div className="border-t border-border">
          {projectNotInitialized ? (
            <div className="p-3 text-xs text-muted-foreground">
              Set up this folder as a Scient project before running analysis files. Viewing and
              editing remain available.
            </div>
          ) : !runtimeReady ? (
            <div className="p-3 text-xs text-muted-foreground">
              <Link
                to="/settings/scientific-computing"
                search={{ environmentId: props.environmentId }}
              >
                Open Scientific Computing
              </Link>
            </div>
          ) : null}
          {!projectNotInitialized && selectedLiveRun ? (
            <RunOutputView
              run={selectedLiveRun}
              runtimeLabel={props.runtimeLabel}
              threadRef={props.threadRef}
              onAskAboutDiagnostic={askAboutDiagnostic}
            />
          ) : !projectNotInitialized && selectedRun ? (
            <PersistedRunOutput
              environmentId={props.environmentId}
              cwd={props.cwd}
              runId={selectedRun.receipt.runId}
              runtimeLabel={props.runtimeLabel}
              threadRef={props.threadRef}
              onAskAboutDiagnostic={askAboutDiagnostic}
              storageStatus={selectedRun.localStorage.status}
            />
          ) : !projectNotInitialized && (model.isStarting || awaitingOwnedRun) ? (
            <div role="status" className="p-3 text-xs text-muted-foreground">
              {model.isStarting ? "Starting MATLAB batch…" : "Waiting for this batch run…"}
            </div>
          ) : !projectNotInitialized && runtimeReady ? (
            <div className="p-3 text-xs text-muted-foreground">
              Run {props.runtimeLabel} batch to see output here.
            </div>
          ) : null}
          {!projectNotInitialized && selectedRun?.localStorage.status === "metadata-only" ? (
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              Local output and artifact files were removed. Run metadata, diagnostics, hashes, and
              provenance remain available.
            </div>
          ) : null}
          {!projectNotInitialized &&
          selectedRun?.localStorage.status === "retained" &&
          isTerminalAnalysisRunStatus(selectedRun.receipt.status) ? (
            <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1">
                Keep this run, its receipt, output, and figures with the project.
              </span>
              <Button size="xs" variant="ghost" disabled={busy} onClick={handlePromoteRun}>
                {operation === "promote" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <FolderDown />
                )}
                Save to project
              </Button>
            </div>
          ) : null}
          {!projectNotInitialized && storage && storage.totalBytes > 0 ? (
            <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1">
                Local results use {formatBytes(storage.totalBytes)} across{" "}
                {storage.retainedRunCount}
                {" retained run"}
                {storage.retainedRunCount === 1 ? "" : "s"}.
              </span>
              {selectedRun?.localStorage.status === "retained" &&
              selectedRun.localStorage.totalBytes > 0 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || !isTerminalAnalysisRunStatus(selectedRun.receipt.status)}
                  onClick={handleCleanupRun}
                >
                  {operation === "cleanup-run" ? <LoaderCircle className="animate-spin" /> : null}
                  Remove this run
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || activeRun !== null}
                onClick={handleCleanupProject}
              >
                {operation === "cleanup-project" ? <LoaderCircle className="animate-spin" /> : null}
                Clean up project
              </Button>
            </div>
          ) : null}
          {!projectNotInitialized && historyPage?.hasMore && historyPage.nextCursor ? (
            <div className="border-t border-border p-2 text-center">
              <Button
                size="xs"
                variant="ghost"
                disabled={runsResult.waiting}
                onClick={() => setHistoryCursor(historyPage.nextCursor)}
              >
                {runsResult.waiting ? <LoaderCircle className="animate-spin" /> : null}
                Load older runs
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
