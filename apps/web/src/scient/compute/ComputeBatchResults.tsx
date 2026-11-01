import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AnalysisRunId, AnalysisSourceRevision } from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import { formatTimestamp } from "~/timestampFormat";
import { useCancelComputeBatchRun } from "./useCancelComputeBatchRun";
import { cn, randomUUID } from "~/lib/utils";
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
  CircleAlert,
  Ellipsis,
  FolderDown,
  LoaderCircle,
  Play,
  Square,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
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
import { splitRunOutputLinks } from "./computeRunOutputLinks";

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

/** Enough of a failed run for an agent to start from; it can read the rest by the run's ID. */
const MAXIMUM_ASKED_OUTPUT = 4000;

type RunAlternative = NonNullable<AnalysisRuntimeProfile["alternatives"]>[number];

/** A run that did not finish well says why, and what can be done about it. */
function RunOutcome(props: {
  readonly run: AnalysisRunSnapshot;
  readonly runtimeLabel: string;
  readonly alternative: RunAlternative | null;
  readonly canRetry: boolean;
  readonly onTryWith: (alternative: RunAlternative) => void;
  readonly onAsk: (run: AnalysisRunSnapshot) => void;
}) {
  const { run } = props;
  const failed = run.receipt.status === "failed";
  if (!failed && run.receipt.status !== "cancelled" && run.receipt.status !== "lost") return null;
  // A diagnostic already offers the same help for the error it describes.
  const offersHelp = failed && run.diagnostics.length === 0;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-1.5">
      <span className={cn("min-w-40 flex-1 text-xs", failed && "text-destructive")}>
        {run.receipt.failureMessage ?? statusLabel(run, props.runtimeLabel)}
      </span>
      {offersHelp && props.alternative !== null ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!props.canRetry}
          onClick={() => props.onTryWith(props.alternative!)}
        >
          Try with {props.alternative.label}
        </Button>
      ) : null}
      {offersHelp ? (
        <Button size="xs" variant="outline" onClick={() => props.onAsk(run)}>
          Ask agent
        </Button>
      ) : null}
    </div>
  );
}

function RunOutputView(props: {
  readonly run: AnalysisRunSnapshot;
  readonly runtimeLabel: string;
  readonly threadRef: ScopedThreadRef;
  readonly alternative: RunAlternative | null;
  readonly canRetry: boolean;
  readonly onTryWith: (alternative: RunAlternative) => void;
  readonly onAskAboutRun: (run: AnalysisRunSnapshot) => void;
  readonly onRevealCode?: (() => void) | undefined;
  readonly onAskAboutDiagnostic: (
    diagnostic: AnalysisDiagnostic,
    runId: AnalysisRunSnapshot["receipt"]["runId"],
  ) => void;
}) {
  const segments = outputSegments(props.run.receipt.output);
  const { cwd, relativePath } = props.run.source;
  const open = (path: string, line?: number) => {
    if (path === relativePath) props.onRevealCode?.();
    useRightPanelStore.getState().openFile(props.threadRef, path, line);
  };
  const output = (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
      {segments.length > 0
        ? segments.map((segment) => (
            <span
              key={segment.firstSequence}
              className={segment.stream === "stderr" ? "text-destructive" : undefined}
            >
              {withOccurrenceKeys(
                splitRunOutputLinks(segment.text, { cwd, relativePath }),
                (piece) => piece.text,
              ).map(({ key, value: piece }) =>
                piece.link === undefined ? (
                  <span key={key}>{piece.text}</span>
                ) : (
                  <button
                    key={key}
                    type="button"
                    className="cursor-pointer text-start underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    onClick={() => open(piece.link!.relativePath, piece.link!.line)}
                  >
                    {piece.text}
                  </button>
                ),
              )}
            </span>
          ))
        : emptyAnalysisRunOutputLabel(props.run.receipt.status)}
    </pre>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunOutcome
        run={props.run}
        runtimeLabel={props.runtimeLabel}
        alternative={props.alternative}
        canRetry={props.canRetry}
        onTryWith={props.onTryWith}
        onAsk={props.onAskAboutRun}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {props.run.writtenFiles !== undefined && props.run.writtenFiles.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="text-muted-foreground">Wrote</span>
              {props.run.writtenFiles.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="cursor-pointer font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
                  onClick={() => open(path)}
                >
                  {path}
                </button>
              ))}
            </div>
          ) : null}
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
                              <span
                                key={key}
                                className="font-mono text-[11px] text-muted-foreground"
                              >
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
        </div>
      </ScrollArea>
    </div>
  );
}

function PersistedRunOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly runId: AnalysisRunSnapshot["receipt"]["runId"];
  readonly runtimeLabel: string;
  readonly threadRef: ScopedThreadRef;
  readonly alternative: RunAlternative | null;
  readonly canRetry: boolean;
  readonly onTryWith: (alternative: RunAlternative) => void;
  readonly onAskAboutRun: (run: AnalysisRunSnapshot) => void;
  readonly onRevealCode?: (() => void) | undefined;
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
  const refreshStorageRun = useStableCallback(
    (refresh: () => void, _storageStatus: AnalysisRunSummary["localStorage"]["status"]) =>
      refresh(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads run storage state over the environment connection when the storage-status subscription changes
  useEffect(
    () => refreshStorageRun(refreshRun, props.storageStatus),
    [props.storageStatus, refreshRun, refreshStorageRun],
  );
  const run = resultValue(result);
  if (run)
    return (
      <RunOutputView
        run={run}
        runtimeLabel={props.runtimeLabel}
        threadRef={props.threadRef}
        alternative={props.alternative}
        canRetry={props.canRetry}
        onTryWith={props.onTryWith}
        onAskAboutRun={props.onAskAboutRun}
        onRevealCode={props.onRevealCode}
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the bounded run-stream subscription, keeping a terminal fallback once the stream evicts the run
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
    !source.sourcePending &&
    profile?.availability === "available" &&
    streamedRunValue !== null &&
    (!options.runId || latestSubmittedRun !== null) &&
    !activeRun &&
    !isStarting &&
    !isCancelling;

  const start = (alternative?: {
    readonly executablePath: string;
  }): Promise<AnalysisRunSnapshot | null> => {
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
          ...(alternative === undefined ? {} : { executablePath: alternative.executablePath }),
        },
      });
      if (result._tag === "Success") {
        if (onRunReserved !== undefined && result.value.receipt.runId !== requestedRunId) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to confirm this run",
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
            "project-not-initialized",
            "source-changed",
            "runtime-invalid",
            "runtime-missing",
            "runtime-queue-full",
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
            title: "Unable to confirm this run",
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
  };

  const cancel = (): Promise<boolean> => {
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
  };

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
  /** Chooses between this file's session and its runs. Without one, its runs are listed here. */
  readonly resultPicker?: ReactNode;
  /** A line in this file was opened from the output, so the code has to be in view. */
  readonly onRevealCode?: () => void;
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
  onRevealCode,
}: ComputeBatchResultsProps) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [operation, setOperation] = useState<"cleanup-run" | "cleanup-project" | "promote" | null>(
    null,
  );
  const refreshedTerminalRunIdRef = useRef<string | null>(null);
  const observedStreamRunIdsRef = useRef<Set<string> | null>(null);

  const historyPage = resultValue(runsResult);
  const history = loadedHistory;
  const runs = (() => {
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
  })();
  const targetRunId = selectedRunId ?? model.runId;
  // With nothing asked for, the file's latest run shows, including one from before this tab.
  const selectedRun =
    (targetRunId === null ? runs[0] : runs.find((run) => run.receipt.runId === targetRunId)) ??
    null;
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

  const [previousHistoryContext, setPreviousHistoryContext] = useState({
    cwd: props.cwd,
    relativePath: props.relativePath,
  });
  if (
    previousHistoryContext.cwd !== props.cwd ||
    previousHistoryContext.relativePath !== props.relativePath
  ) {
    setPreviousHistoryContext({ cwd: props.cwd, relativePath: props.relativePath });
    setHistoryCursor(null);
    setLoadedHistory([]);
  }

  const [previousHistoryPage, setPreviousHistoryPage] = useState<{
    page: typeof historyPage;
    cursor: typeof historyCursor;
  } | null>(null);
  if (previousHistoryPage?.page !== historyPage || previousHistoryPage?.cursor !== historyCursor) {
    setPreviousHistoryPage({ page: historyPage, cursor: historyCursor });
    if (historyPage)
      setLoadedHistory((current) => {
        if (historyCursor === null) return historyPage.runs;
        const byId = new Map(current.map((run) => [run.receipt.runId, run]));
        for (const run of historyPage.runs) byId.set(run.receipt.runId, run);
        return [...byId.values()].toSorted((left, right) =>
          right.receipt.startedAt.localeCompare(left.receipt.startedAt),
        );
      });
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- auto-expands output for runs newly observed on the run-stream subscription
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
  }, [streamedRunValue, streamedRuns, model.runId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets and reloads run history from the environment when a new terminal run appears in the stream
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
    const location = diagnostic.relativePath
      ? `${diagnostic.relativePath}${diagnostic.line ? `:${diagnostic.line}` : ""}`
      : props.relativePath;
    askAgent(
      `Please diagnose and fix this ${props.runtimeLabel} error in ${location}. Scient analysis run ID: ${runId}; diagnostic ID: ${diagnostic.diagnosticId}.\n\n${diagnostic.code ? `${diagnostic.code}: ` : ""}${diagnostic.message}`,
    );
  };

  const askAboutRun = (run: AnalysisRunSnapshot) => {
    const output = outputSegments(run.receipt.output)
      .map((segment) => segment.text)
      .join("");
    askAgent(
      `Please diagnose and fix this ${props.runtimeLabel} failure in ${props.relativePath}. Scient analysis run ID: ${run.receipt.runId}.\n\n${run.receipt.failureMessage ?? ""}\n\n${output.slice(-MAXIMUM_ASKED_OUTPUT)}`.trim(),
    );
  };

  const askAgent = (request: string) => {
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(props.threadRef)?.prompt ?? "";
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
  const [previousSubmittedRunId, setPreviousSubmittedRunId] = useState<string | null>(null);
  if (previousSubmittedRunId !== submittedRunId) {
    setPreviousSubmittedRunId(submittedRunId);
    if (submittedRunId) {
      setSelectedRunId(submittedRunId);
      setHistoryCursor(null);
    }
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the run list over the environment connection when a submitted run id arrives
  useEffect(() => {
    if (submittedRunId) refreshRuns();
  }, [submittedRunId, refreshRuns]);
  const shownRuntime = selectedRun?.runtime ?? profile;
  const shownRuntimeText =
    selectedRun === null
      ? runtimeStatusText
      : `${shownRuntime?.label ?? props.runtimeLabel}${shownRuntime?.version ? ` ${shownRuntime.version}` : ""}`;
  const alternatives = profile?.alternatives ?? [];
  // A version says what is different; a bare program name only says where it is.
  const alternative =
    alternatives.find(
      (candidate) =>
        candidate.version !== null && candidate.version !== selectedRun?.runtime.version,
    ) ??
    alternatives.find(
      (candidate) => candidate.executablePath !== selectedRun?.runtime.executablePath,
    ) ??
    null;
  const outputProps = {
    runtimeLabel: props.runtimeLabel,
    threadRef: props.threadRef,
    alternative,
    canRetry: model.canStart,
    onTryWith: (candidate: RunAlternative) => void model.start(candidate),
    onAskAboutRun: askAboutRun,
    onRevealCode,
    onAskAboutDiagnostic: askAboutDiagnostic,
  };
  const removable =
    selectedRun?.localStorage.status === "retained" && selectedRun.localStorage.totalBytes > 0;
  const finished =
    selectedRun?.localStorage.status === "retained" &&
    isTerminalAnalysisRunStatus(selectedRun.receipt.status);
  const showHistory = resultPicker === undefined && (runs.length > 1 || historyPage?.hasMore);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label={`${props.runtimeLabel} results`}
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1">
        {resultPicker}
        {showHistory ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="max-w-44"
                  aria-label={`${props.runtimeLabel} runs of this file`}
                >
                  <span className="truncate">
                    {selectedRun
                      ? formatTimestamp(selectedRun.receipt.startedAt, timestampFormat)
                      : "Runs"}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </Button>
              }
            />
            <MenuPopup align="start" side="bottom" className="max-h-64 min-w-48 overflow-y-auto">
              <MenuRadioGroup
                value={selectedRun?.receipt.runId ?? ""}
                onValueChange={(runId) => setSelectedRunId(runId)}
              >
                {runs.map((run) => (
                  <MenuRadioItem key={run.receipt.runId} value={run.receipt.runId} size="compact">
                    {statusLabel(run, props.runtimeLabel)} ·{" "}
                    {formatTimestamp(run.receipt.startedAt, timestampFormat)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {historyPage?.hasMore && historyPage.nextCursor ? (
                <MenuItem
                  disabled={runsResult.waiting}
                  onClick={() => setHistoryCursor(historyPage.nextCursor)}
                >
                  Load older runs
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
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
                : `Run ${props.runtimeLabel}`}
          </Button>
        ) : null}
        <ScientTooltip content={selectedRun?.source.cwd ?? runtimeStatusText}>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {activeRun
              ? statusLabel(activeRun, props.runtimeLabel)
              : operationStatus
                ? operationStatus
                : projectNotInitialized
                  ? "Add this folder to Scient to run it"
                  : shownRuntimeText}
          </span>
        </ScientTooltip>
        {!projectNotInitialized && (finished || (storage && storage.totalBytes > 0)) ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost-muted" aria-label="More run actions">
                  {operation === null ? <Ellipsis /> : <LoaderCircle className="animate-spin" />}
                </Button>
              }
            />
            <MenuPopup align="end" side="bottom" className="min-w-48">
              {finished ? (
                <MenuItem disabled={busy} onClick={handlePromoteRun}>
                  <FolderDown />
                  Save to project
                </MenuItem>
              ) : null}
              {removable ? (
                <MenuItem
                  disabled={busy || !isTerminalAnalysisRunStatus(selectedRun.receipt.status)}
                  onClick={handleCleanupRun}
                >
                  Remove this run
                </MenuItem>
              ) : null}
              {storage && storage.totalBytes > 0 ? (
                <MenuItem disabled={busy || activeRun !== null} onClick={handleCleanupProject}>
                  Clean up project ({formatBytes(storage.totalBytes)})
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
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
          className="border-b border-warning/30 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          {selectedRun.artifactReceipt.failureMessage ??
            "The run finished, but Scient could not collect its generated figures."}
        </div>
      ) : null}

      {projectNotInitialized ? (
        <div className="p-3 text-xs text-muted-foreground">
          Add this folder to Scient to run its files. Viewing and editing remain available.
        </div>
      ) : !runtimeReady && selectedRun === null ? (
        <div className="p-3 text-xs text-muted-foreground">
          <Link to="/settings/scientific-computing" search={{ environmentId: props.environmentId }}>
            Open Scientific Computing
          </Link>
        </div>
      ) : null}
      {!projectNotInitialized && selectedRun?.localStorage.status === "metadata-only" ? (
        <div className="border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          This run's saved output was removed.
        </div>
      ) : null}
      {!projectNotInitialized && selectedLiveRun ? (
        <RunOutputView run={selectedLiveRun} {...outputProps} />
      ) : !projectNotInitialized && selectedRun ? (
        <PersistedRunOutput
          environmentId={props.environmentId}
          cwd={props.cwd}
          runId={selectedRun.receipt.runId}
          storageStatus={selectedRun.localStorage.status}
          {...outputProps}
        />
      ) : !projectNotInitialized && (model.isStarting || awaitingOwnedRun) ? (
        <div role="status" className="p-3 text-xs text-muted-foreground">
          {model.isStarting ? `Starting ${props.runtimeLabel}…` : "Waiting for this run…"}
        </div>
      ) : !projectNotInitialized && runtimeReady ? (
        <div className="p-3 text-xs text-muted-foreground">Run this file to see output here.</div>
      ) : null}
    </section>
  );
}
import { useStableCallback } from "~/hooks/useStableCallback";
