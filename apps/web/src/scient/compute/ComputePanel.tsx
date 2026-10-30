import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { CircleAlert, History, LoaderCircle, Play } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";

import type { ComputeContextId } from "./computeContextStore";
import { computeFeedEntries, type ComputeFeedEntry } from "./computeFeedModel";
import type { ComputePanelView } from "./computeFilePresentationStore";
import {
  resolveComputeEmptyResultsState,
  type ComputeEmptyResultsState,
} from "./computePanelPresentation";
import { ComputeResultsFeed } from "./ComputeResultsFeed";
import type { ComputeExecutionSource } from "./ComputeRunEntry";
import { ComputeSavedFileAction } from "./ComputeSavedFileAction";
import { ComputeSessionControls } from "./ComputeSessionControls";
import { ComputeSessionIndicator } from "./ComputeSessionIndicator";
import { ComputeSessionNotices } from "./ComputeSessionNotices";
import {
  ComputeCapacityMenu,
  ComputeSessionStart,
  useComputeSessionStart,
} from "./ComputeSessionStart";
import { ComputeVariablesView } from "./ComputeVariablesView";
import { useComputePanelSessions } from "./useComputePanelSessions";
import { useComputeVariables } from "./useComputeVariables";

function ComputePanelTabs(props: {
  readonly value: ComputePanelView;
  readonly onChange: (view: ComputePanelView) => void;
}) {
  const resultsRef = useRef<HTMLButtonElement>(null);
  const variablesRef = useRef<HTMLButtonElement>(null);
  const tabs: ReadonlyArray<{ value: ComputePanelView; label: string }> = [
    { value: "results", label: "Results" },
    { value: "variables", label: "Variables" },
  ];
  const focus = (view: ComputePanelView) => {
    props.onChange(view);
    (view === "results" ? resultsRef : variablesRef).current?.focus();
  };
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Compute view">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          ref={tab.value === "results" ? resultsRef : variablesRef}
          type="button"
          role="tab"
          tabIndex={props.value === tab.value ? 0 : -1}
          aria-selected={props.value === tab.value}
          className={cn(
            "cursor-pointer rounded-[4px] px-1.5 py-0.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            props.value === tab.value && "text-foreground",
          )}
          onClick={() => props.onChange(tab.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              focus(tab.value === "results" ? "variables" : "results");
            } else if (event.key === "Home") {
              event.preventDefault();
              focus("results");
            } else if (event.key === "End") {
              event.preventDefault();
              focus("variables");
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

const PENDING_LABELS = {
  "loading-history": null,
  "starting-session": "Starting…",
  "stopping-session": "Stopping…",
  running: "Running…",
} as const;

function EmptyComputeResults(props: {
  readonly state: ComputeEmptyResultsState;
  readonly onRun?: () => void;
  readonly runUnavailableReason?: string | null;
}) {
  if (props.state in PENDING_LABELS) {
    return (
      <div
        className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" />
        {PENDING_LABELS[props.state as keyof typeof PENDING_LABELS]}
      </div>
    );
  }
  if (props.state === "idle-file" && props.runUnavailableReason) {
    return (
      <div className="flex min-h-40 items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {props.runUnavailableReason}
      </div>
    );
  }
  return (
    <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
      {props.state === "idle-file" ? (
        <Button size="xs" variant="outline" onClick={props.onRun}>
          <Play /> Run file
        </Button>
      ) : (
        "No runs yet"
      )}
    </div>
  );
}

export function ComputePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly sourcePath?: string;
  readonly focusExecutionId?: string | null;
  readonly onFocusConsumed?: (executionId: string) => void;
  readonly contextId?: ComputeContextId;
  readonly onRetryClose?: () => void;
  readonly onRunSource?: () => void;
  readonly onRevealSource?: (source: Extract<ComputeExecutionSource, { _tag: "document" }>) => void;
  readonly sourceRunUnavailableReason?: string | null;
  readonly panelView?: ComputePanelView;
  readonly onPanelViewChange?: (view: ComputePanelView) => void;
  readonly embedded?: boolean;
  readonly resultPicker?: ReactNode;
}) {
  const [localPanelView, setLocalPanelView] = useState<ComputePanelView>("results");
  const panelView = props.panelView ?? localPanelView;
  const setPanelView = props.onPanelViewChange ?? setLocalPanelView;
  const standalone = !props.embedded;
  const model = useComputePanelSessions({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId: props.contextId,
  });
  const variables = useComputeVariables({
    environmentId: props.environmentId,
    cwd: props.cwd,
    visible: panelView === "variables",
    model,
  });
  const start = useComputeSessionStart({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId: props.contextId,
    model,
  });
  const { contextBinding, selectedSession, liveSession, runtimes, events } = model;

  const entries = computeFeedEntries({
    session: selectedSession,
    executions: model.executions,
    freshSessions: model.freshSessions,
  });
  const emptyResults = (
    <EmptyComputeResults
      state={resolveComputeEmptyResultsState({
        contextLifecycle: contextBinding?.lifecycle ?? null,
        sessionStatus: selectedSession?.status ?? null,
        sessionActivity: selectedSession?.activity ?? null,
        historyPending: model.historyPending,
        focusExecutionPending: props.focusExecutionId != null,
        sourceFile: props.sourcePath !== undefined,
      })}
      runUnavailableReason={props.sourceRunUnavailableReason ?? null}
      {...(props.onRunSource === undefined ? {} : { onRun: props.onRunSource })}
    />
  );
  const dependencyRecoveryFor = (entry: Extract<ComputeFeedEntry, { readonly kind: "run" }>) =>
    props.contextId !== undefined &&
    contextBinding?.parentContextId === undefined &&
    contextBinding?.sessionId === entry.session.sessionId &&
    entry.session.lifetime !== "fresh" &&
    entry.execution.request.generation === entry.session.generation &&
    entry.execution.result?.status === "failed"
      ? {
          contextId: props.contextId,
          onSettled: () => {
            model.refresh();
            runtimes.refresh();
          },
        }
      : undefined;
  const revealSource =
    props.onRevealSource ??
    ((source: Extract<ComputeExecutionSource, { _tag: "document" }>) =>
      useRightPanelStore
        .getState()
        .openFile(
          props.threadRef,
          source.path,
          source.range === null ? undefined : source.range.startLine + 1,
        ));
  const sessionNotices =
    standalone && selectedSession !== null
      ? events.data?.outputs.get(`${selectedSession.sessionId}/@session`)
      : undefined;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Scientific results">
      <header className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {props.resultPicker}
        <ComputePanelTabs value={panelView} onChange={setPanelView} />
        <span className="flex-1" />
        {standalone && selectedSession !== null ? (
          <ComputeSessionIndicator
            sessions={model.contextSessions}
            selected={selectedSession}
            environmentId={props.environmentId}
            cwd={props.cwd}
            onChoose={model.chooseSession}
          />
        ) : null}
        {standalone ? (
          <ComputeCapacityMenu start={start} environmentId={props.environmentId} cwd={props.cwd} />
        ) : null}
        {standalone && props.contextId !== undefined && model.allSessions.length > 1 ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="All sessions"
            title="All sessions"
            onClick={() =>
              useRightPanelStore
                .getState()
                .openScient(props.threadRef, scientComputeSurface({ cwd: props.cwd }))
            }
          >
            <History />
          </Button>
        ) : null}
        {liveSession !== null && model.selectedIsLive ? (
          <>
            {standalone && props.contextId !== undefined ? (
              <ComputeSavedFileAction
                contextId={props.contextId}
                session={liveSession}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                disabled={liveSession.status !== "ready" || contextBinding?.lifecycle !== "live"}
                onSubmitted={(execution) => {
                  model.chooseSession(execution.request.sessionId);
                  setPanelView("results");
                  model.refresh();
                }}
              />
            ) : null}
            <ComputeSessionControls
              environmentId={props.environmentId}
              cwd={props.cwd}
              session={liveSession}
              contextId={props.contextId}
              binding={contextBinding}
              onSettled={model.refresh}
            />
          </>
        ) : standalone &&
          props.contextId !== undefined &&
          model.contextSessions.length > 0 &&
          start.selectedRuntime !== null ? (
          <Button size="xs" variant="outline" disabled={start.disabled} onClick={start.start}>
            {start.starting ? <LoaderCircle className="animate-spin" /> : <Play />}
            New session
          </Button>
        ) : null}
      </header>

      {contextBinding?.lifecycle === "close-failed" ? (
        <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {contextBinding.closeError ?? "Couldn't stop this session"}
          </span>
          {props.onRetryClose ? (
            <Button size="xs" variant="outline" onClick={props.onRetryClose}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {panelView === "variables" ? (
        <ComputeVariablesView
          snapshot={variables.snapshot}
          loading={variables.loading}
          error={variables.error}
          available={variables.available}
          hasLiveSession={liveSession !== null}
          busy={liveSession?.activity === "busy"}
          selectedIsLive={model.selectedIsLive}
          onShowLive={() => {
            if (liveSession !== null) model.chooseSession(liveSession.sessionId);
          }}
          onRefresh={variables.refresh}
        />
      ) : selectedSession !== null || entries.length > 0 ? (
        <ComputeResultsFeed
          key={selectedSession?.sessionId ?? "fresh"}
          environmentId={props.environmentId}
          cwd={props.cwd}
          threadRef={props.threadRef}
          entries={entries}
          events={events.data}
          rehydrationToken={model.rehydrationToken}
          includeSourcePath={standalone}
          runtimeInspection={runtimes.isSuccess && !runtimes.isPending ? runtimes.data : null}
          dependencyRecoveryFor={dependencyRecoveryFor}
          onRevealSource={revealSource}
          followRequest={props.focusExecutionId ?? null}
          {...(props.onFocusConsumed === undefined
            ? {}
            : { onFollowRequestConsumed: props.onFocusConsumed })}
          lead={
            selectedSession !== null &&
            sessionNotices !== undefined &&
            sessionNotices.outputs.length > 0 ? (
              <ComputeSessionNotices
                cwd={props.cwd}
                environmentId={props.environmentId}
                live={sessionNotices}
                rehydrationToken={model.rehydrationToken}
                session={selectedSession}
                threadRef={props.threadRef}
              />
            ) : null
          }
          empty={emptyResults}
        />
      ) : props.embedded ? (
        emptyResults
      ) : props.contextId === undefined ? (
        <p className="p-6 text-center text-xs text-muted-foreground">No runs yet</p>
      ) : (
        <ComputeSessionStart
          start={start}
          environmentId={props.environmentId}
          runtimesPending={runtimes.isPending}
        />
      )}
    </section>
  );
}
