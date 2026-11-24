import { ComputeExecutionId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { CircleAlert, FileCode, History, LoaderCircle, Play, Plus, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { MenuItem } from "~/components/ui/menu";
import { cn, randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { ComputeVariableTableDialog } from "~/scient/dataTable/ComputeVariableTable";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  ComputeConsoleInput,
  ComputeConsoleLanguage,
  ComputeConsoleLinks,
  useComputeConsoleRun,
} from "./ComputeConsole";
import { computeConsoleHistory, useComputeConsoleStore } from "./computeConsoleStore";
import { usePendingComputeQuote } from "./computeQuoteReveal";
import { createComputeContextId, type ComputeContextId } from "./computeContextStore";
import { computeFeedEntries, type ComputeFeedEntry } from "./computeFeedModel";
import {
  ResultPackageMenu,
  VerifyResultPackageButton,
} from "../results/handoff/resultPackagePalette";
import type { ComputePanelView } from "./computeFilePresentationStore";
import {
  resolveComputeEmptyResultsState,
  type ComputeEmptyResultsState,
} from "./computePanelPresentation";
import { ComputeResultsFeed } from "./ComputeResultsFeed";
import type { ComputeExecutionSource } from "./ComputeRunEntry";
import { ComputeSavedFileAction } from "./ComputeSavedFileAction";
import { ComputeSessionControls, reportComputeFailure } from "./ComputeSessionControls";
import { ComputeSessionIndicator } from "./ComputeSessionIndicator";
import { ComputeSessionNotices } from "./ComputeSessionNotices";
import { computeSourceLanguageForPath } from "./computeSourceLanguage";
import { ComputeCapacityMenu, useComputeSessionStart } from "./ComputeSessionStart";
import { ComputeVariablesView } from "./ComputeVariablesView";
import { useComputePanelSessions } from "./useComputePanelSessions";
import { useComputeRunHistory } from "./useComputeRunHistory";
import { useComputeVariables } from "./useComputeVariables";

function ComputePanelTabs(props: {
  readonly value: ComputePanelView;
  readonly onChange: (view: ComputePanelView) => void;
}) {
  const gt = useGT();
  const resultsRef = useRef<HTMLButtonElement>(null);
  const variablesRef = useRef<HTMLButtonElement>(null);
  const tabs: ReadonlyArray<{ value: ComputePanelView; label: string }> = [
    { value: "results", label: gt("Results", { $context: "tab: run results" }) },
    { value: "variables", label: gt("Variables") },
  ];
  const focus = (view: ComputePanelView) => {
    props.onChange(view);
    (view === "results" ? resultsRef : variablesRef).current?.focus();
  };
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label={gt("Compute view")}>
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

/** `msg()` strings. */
const PENDING_LABELS = {
  "loading-history": null,
  "starting-session": msg("Starting…"),
  "stopping-session": msg("Stopping…"),
  running: msg("Running…"),
} as const;

function EmptyComputeResults(props: {
  readonly state: ComputeEmptyResultsState;
  readonly julia?: boolean;
  readonly onRun?: () => void;
  readonly runUnavailableReason?: string | null;
}) {
  const messages = useMessages();
  if (props.state in PENDING_LABELS) {
    const pending = PENDING_LABELS[props.state as keyof typeof PENDING_LABELS];
    const juliaStarting = props.julia && props.state === "starting-session";
    return (
      <div
        className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" />
        {juliaStarting ? (
          <div>
            <p>
              <T>Setting up Julia (first run can take a few minutes)…</T>
            </p>
            <p>
              <T>Starting the IJulia kernel and waiting for it to respond.</T>
            </p>
          </div>
        ) : pending === null ? null : (
          messages(pending)
        )}
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
          <Play /> <T>Run file</T>
        </Button>
      ) : (
        <T>No runs yet</T>
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
  const gt = useGT();
  const [localPanelView, setLocalPanelView] = useState<ComputePanelView>("results");
  const panelView = props.panelView ?? localPanelView;
  const setPanelView = props.onPanelViewChange ?? setLocalPanelView;
  const standalone = !props.embedded;
  const model = useComputePanelSessions({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId: props.contextId,
    sourcePath: props.sourcePath,
  });
  const variables = useComputeVariables({
    environmentId: props.environmentId,
    cwd: props.cwd,
    visible: panelView === "variables" || (standalone && props.contextId !== undefined),
    model,
  });
  const start = useComputeSessionStart({
    environmentId: props.environmentId,
    cwd: props.cwd,
    contextId: props.contextId,
    model,
  });
  const { contextBinding, selectedSession, liveSession, runtimes, events } = model;
  const revealSessionId = usePendingComputeQuote(props.threadRef, ({ place }) =>
    place._tag === "run" ? place.sessionId : null,
  );
  const revealHere = model.contextSessions.some((session) => session.sessionId === revealSessionId);
  const { chooseSession } = model;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a quote's chip asks for a run in a session this panel may not be showing
  useEffect(() => {
    if (!revealHere || revealSessionId === null) return;
    chooseSession(revealSessionId);
    setPanelView("results");
  }, [chooseSession, revealHere, revealSessionId, setPanelView]);
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [runFileOpen, setRunFileOpen] = useState(false);
  const [followRun, setFollowRun] = useState<string | null>(null);
  const consoleContext = standalone ? props.contextId : undefined;
  const saveNotebook = useAtomCommand(computeEnvironment.saveConsoleNotebook, {
    reportFailure: false,
  });
  const submitExecution = useAtomCommand(computeEnvironment.submitExecution, {
    reportFailure: false,
  });
  /** The failed run's own code, again in its session, followed like any new run. */
  const runAgain = async (entry: Extract<ComputeFeedEntry, { readonly kind: "run" }>) => {
    const executionId = ComputeExecutionId.make(randomUUID());
    const result = await submitExecution({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: entry.session.sessionId,
        executionId,
        expectedGeneration: entry.session.generation,
        code: entry.execution.request.code,
        source: entry.execution.request.source,
      },
    });
    if (result._tag === "Failure") return reportComputeFailure(gt("Unable to run again"), result);
    setPanelView("results");
    setFollowRun(executionId);
  };
  const runConsole = useComputeConsoleRun({
    environmentId: props.environmentId,
    cwd: props.cwd,
    start,
    model,
    onSubmitted: (executionId) => {
      setPanelView("results");
      setFollowRun(executionId);
    },
  });

  const allEntries = computeFeedEntries({
    session: selectedSession,
    executions: model.executions,
    freshSessions: model.freshSessions,
  });
  // A script sharing a Console's session shows its own runs; the Console shows them all.
  const entries =
    contextBinding?.borrowed === true
      ? allEntries.filter(
          (entry) =>
            entry.kind === "run" &&
            entry.execution.request.source._tag === "document" &&
            entry.execution.request.source.path === props.sourcePath,
        )
      : allEntries;
  const fileHistory = useComputeRunHistory(
    props.environmentId,
    props.sourcePath === undefined ? null : { cwd: props.cwd, path: props.sourcePath, limit: 200 },
  );
  const visibleRunIds = new Set(entries.map((entry) => entry.key));
  const agentEntries = fileHistory.runs.flatMap(({ execution, session }) =>
    execution.request.actor !== undefined &&
    !visibleRunIds.has(execution.request.executionId) &&
    !model.freshSessions.some((fresh) => fresh.sessionId === session.sessionId)
      ? [
          {
            kind: "run",
            key: execution.request.executionId,
            execution,
            session,
          } satisfies ComputeFeedEntry,
        ]
      : [],
  );
  const results = [...entries];
  for (const entry of agentEntries.toSorted((left, right) =>
    left.execution.request.submittedAt.localeCompare(right.execution.request.submittedAt),
  )) {
    const index = results.findIndex(
      (current) =>
        (current.kind === "run" || current.kind === "fresh") &&
        (current.kind === "run"
          ? current.execution.request.submittedAt
          : current.session.createdAt
        ).localeCompare(entry.execution.request.submittedAt) > 0,
    );
    results.splice(index < 0 ? results.length : index, 0, entry);
  }
  const hasWork = selectedSession !== null || entries.length > 0;
  const consoleLanguage =
    selectedSession?.languageId ?? start.selectedRuntime?.language.descriptor.languageId ?? null;
  const consoleHistory = computeConsoleHistory(model.executions);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the tab strip, which has no session query, which language this Console runs
  useEffect(() => {
    if (consoleContext !== undefined && consoleLanguage !== null) {
      useComputeConsoleStore.getState().setLanguage(consoleContext, consoleLanguage);
    }
  }, [consoleContext, consoleLanguage]);
  const saveAsNotebook = async () => {
    if (selectedSession === null) return;
    const saved = await saveNotebook({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, sessionId: selectedSession.sessionId },
    });
    if (saved._tag === "Success") {
      useRightPanelStore.getState().openFile(props.threadRef, saved.value.relativePath);
    } else if (!isAtomCommandInterrupted(saved)) {
      reportComputeFailure(gt("Unable to save as notebook"), saved);
    }
  };
  const emptyResults = (
    <EmptyComputeResults
      state={resolveComputeEmptyResultsState({
        contextLifecycle: contextBinding?.lifecycle ?? null,
        sessionStatus: selectedSession?.status ?? null,
        sessionActivity: selectedSession?.activity ?? null,
        historyPending: model.historyPending || fileHistory.pending,
        focusExecutionPending: props.focusExecutionId != null,
        sourceFile: props.sourcePath !== undefined,
      })}
      runUnavailableReason={props.sourceRunUnavailableReason ?? null}
      julia={
        (selectedSession?.languageId ??
          (props.sourcePath === undefined
            ? undefined
            : computeSourceLanguageForPath(props.sourcePath)?.languageId)) === "julia"
      }
      {...(props.onRunSource === undefined ? {} : { onRun: props.onRunSource })}
    />
  );
  /** A later run of the same code that succeeded means this failure is already dealt with. */
  const fixedLater = (entry: Extract<ComputeFeedEntry, { readonly kind: "run" }>) =>
    allEntries.some(
      (other) =>
        other.kind === "run" &&
        other.session.sessionId === entry.session.sessionId &&
        other.execution.request.code === entry.execution.request.code &&
        other.execution.request.submittedAt > entry.execution.request.submittedAt &&
        other.execution.result?.status === "succeeded",
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
          runAgain: () => void runAgain(entry),
          resolved: fixedLater(entry),
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
    <section
      className="@container flex min-h-0 flex-1 flex-col bg-background"
      aria-label={gt("Scientific results")}
    >
      {selectedSession?.closedAt != null && selectedSession.lostReason !== null ? (
        <p className="shrink-0 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          {selectedSession.lostReason}
        </p>
      ) : null}
      <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2">
        {props.resultPicker}
        {consoleContext === undefined ? (
          <ResultPackageMenu environmentId={props.environmentId} cwd={props.cwd} />
        ) : hasWork ? (
          <VerifyResultPackageButton environmentId={props.environmentId} cwd={props.cwd} />
        ) : null}
        {consoleContext === undefined ? (
          <ComputePanelTabs value={panelView} onChange={setPanelView} />
        ) : null}
        <span className="flex-1" />
        {consoleContext !== undefined ? (
          <>
            {variables.available && (variables.snapshot?.variables.length ?? 0) > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                aria-pressed={panelView === "variables"}
                onClick={() => setPanelView(panelView === "variables" ? "results" : "variables")}
              >
                {variables.snapshot?.truncated
                  ? gt("Variables {count}+", {
                      count: variables.snapshot.variables.length,
                    })
                  : gt("Variables {count}", {
                      count: variables.snapshot?.variables.length ?? 0,
                    })}
              </Button>
            ) : null}
            {consoleHistory.length > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label={gt("Save as notebook")}
                onClick={() => void saveAsNotebook()}
              >
                <span>
                  <T>
                    Save<span className="@max-[24rem]:hidden"> as notebook</span>
                  </T>
                </span>
              </Button>
            ) : null}
          </>
        ) : null}
        {standalone && consoleContext === undefined && selectedSession !== null ? (
          <ComputeSessionIndicator
            sessions={model.contextSessions}
            selected={selectedSession}
            environmentId={props.environmentId}
            cwd={props.cwd}
            onChoose={model.chooseSession}
          />
        ) : null}
        {standalone && (consoleContext === undefined || hasWork) ? (
          <ComputeCapacityMenu start={start} environmentId={props.environmentId} cwd={props.cwd} />
        ) : null}
        {consoleContext !== undefined ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              focus="edge"
              aria-label={gt("Compute history")}
              title={gt("Compute history")}
              onClick={() =>
                useRightPanelStore
                  .getState()
                  .openScient(props.threadRef, scientComputeSurface({ cwd: props.cwd }))
              }
            >
              <History aria-hidden />
            </Button>
            <Button
              size="xs"
              variant="outline"
              focus="edge"
              onClick={() =>
                useRightPanelStore
                  .getState()
                  .openScient(
                    props.threadRef,
                    scientComputeSurface({ cwd: props.cwd, contextId: createComputeContextId() }),
                  )
              }
            >
              <Plus aria-hidden />
              <T>New console</T>
            </Button>
          </>
        ) : null}
        {liveSession !== null && model.selectedIsLive ? (
          <>
            {consoleContext !== undefined ? (
              <ComputeSavedFileAction
                contextId={consoleContext}
                session={liveSession}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                open={runFileOpen}
                onOpenChange={setRunFileOpen}
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
              embedded={props.embedded}
              {...(consoleContext === undefined
                ? {}
                : {
                    menuItems: (
                      <MenuItem
                        disabled={
                          liveSession.status !== "ready" || contextBinding?.lifecycle !== "live"
                        }
                        onClick={() => setRunFileOpen(true)}
                      >
                        <FileCode />
                        <T>Run file…</T>
                      </MenuItem>
                    ),
                  })}
            />
          </>
        ) : null}
      </header>

      {contextBinding?.lifecycle === "close-failed" ? (
        <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {contextBinding.closeError ?? gt("Couldn't stop this session")}
          </span>
          {props.onRetryClose ? (
            <Button size="xs" variant="outline" onClick={props.onRetryClose}>
              <T>Retry</T>
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
          {...(variables.tables ? { onOpenTable: setOpenTable } : {})}
        />
      ) : selectedSession !== null || results.length > 0 ? (
        <ComputeResultsFeed
          key={selectedSession?.sessionId ?? "fresh"}
          environmentId={props.environmentId}
          cwd={props.cwd}
          threadRef={props.threadRef}
          entries={results}
          events={events.data}
          rehydrationToken={model.rehydrationToken}
          includeSourcePath={standalone}
          {...(liveSession !== null && model.selectedIsLive
            ? { interruptControlledSessionId: liveSession.sessionId }
            : {})}
          runtimeInspection={runtimes.isSuccess && !runtimes.isPending ? runtimes.data : null}
          dependencyRecoveryFor={dependencyRecoveryFor}
          onRevealSource={revealSource}
          followRequest={props.focusExecutionId ?? followRun}
          onFollowRequestConsumed={(request) => {
            setFollowRun(null);
            props.onFocusConsumed?.(request);
          }}
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
        <p className="p-6 text-center text-xs text-muted-foreground">
          <T>No runs yet</T>
        </p>
      ) : null}
      {consoleContext !== undefined ? (
        runtimes.isPending && start.readyRuntimes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : start.readyRuntimes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4">
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/settings/scientific-computing"
                  search={{ environmentId: props.environmentId }}
                />
              }
            >
              <Settings2 /> {gt("Scientific Computing")}
            </Button>
          </div>
        ) : (
          <div
            className={
              hasWork
                ? "shrink-0 px-3 pb-3 pt-2"
                : "flex min-h-0 flex-1 flex-col justify-center px-3 pb-14"
            }
          >
            <ComputeConsoleInput
              contextId={consoleContext}
              language={consoleLanguage ?? "python"}
              languageName={start.selectedRuntime?.language.descriptor.displayName ?? "code"}
              history={consoleHistory}
              disabled={
                start.starting ||
                liveSession?.status === "starting" ||
                (liveSession === null && start.selectedRuntime === null)
              }
              onRun={runConsole}
              footer={
                <ComputeConsoleLanguage
                  start={start}
                  session={selectedSession}
                  live={liveSession !== null}
                  hasWork={hasWork}
                  cwd={props.cwd}
                  threadRef={props.threadRef}
                />
              }
            />
            {hasWork ? null : (
              <>
                <ComputeConsoleLinks
                  environmentId={props.environmentId}
                  cwd={props.cwd}
                  threadRef={props.threadRef}
                  languageId={consoleLanguage}
                />
                {start.capacityBlocked ? (
                  <div className="mt-3 flex justify-center">
                    <ComputeCapacityMenu
                      start={start}
                      environmentId={props.environmentId}
                      cwd={props.cwd}
                    />
                  </div>
                ) : null}
              </>
            )}
          </div>
        )
      ) : null}
      {liveSession !== null ? (
        <ComputeVariableTableDialog
          environmentId={props.environmentId}
          cwd={props.cwd}
          sessionId={liveSession.sessionId}
          generation={liveSession.generation}
          name={openTable}
          onClose={() => setOpenTable(null)}
        />
      ) : null}
    </section>
  );
}
