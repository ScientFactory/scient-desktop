import type { ComputeSubscriptionState } from "@t3tools/client-runtime/state/compute";
import {
  computeNotebookCellNotRun,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  ThreadId,
  type ComputeCitation,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
  type ComputeRunHistoryInput,
  type ComputeRunHistoryResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { Bot, ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  disclosureRowSurface,
} from "~/components/ui/collapsible";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useQuietThreadShell } from "~/state/entities";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { formatReceiptDateTime } from "~/timestampFormat";

import type { ComputeHistoryFocus } from "./computeHistoryFocus";
import { isTerminalAnalysisRunStatus } from "../analysis/analysisRunUiState";
import { PersistedRunOutput } from "./ComputeBatchResults";
import { ComputeRunParameters, ComputeTruncatedText } from "./ComputeTruncatedText";
import { useCancelComputeBatchRun } from "./useCancelComputeBatchRun";
import type { ComputeFeedEntry } from "./computeFeedModel";
import { ComputeQuoteActions, computeRunPlace } from "./ComputeQuoteActions";
import { usePendingComputeQuote } from "./computeQuoteReveal";
import {
  ComputeRunEntry,
  ComputeRunStop,
  ComputeStopButton,
  type ComputeRunEntryProps,
} from "./ComputeRunEntry";
import { computeExecutionStatusLabel } from "./computeResultPresentation";

const FEED_PAGE = 30;
const FOLLOW_SLACK = 32;

type SharedRunProps = Omit<
  ComputeRunEntryProps,
  "session" | "execution" | "live" | "newest" | "fresh" | "dependencyRecovery"
>;

function liveOutputs(
  events: ComputeSubscriptionState | null,
  session: ComputeSessionRecord,
  execution: ComputeExecutionRecord,
) {
  return events?.outputs.get(`${session.sessionId}/${execution.request.executionId}`);
}

/** A Run fresh session's runs, read from its own history. */
function ComputeFreshEntry(
  props: SharedRunProps & {
    readonly session: ComputeSessionRecord;
    readonly events: ComputeSubscriptionState | null;
    readonly newest: boolean;
  },
) {
  const { session, events, newest, ...shared } = props;
  const executions = useEnvironmentQuery(
    computeEnvironment.executions({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, sessionId: session.sessionId, limit: 10 },
    }),
  );
  const byId = new Map<string, ComputeExecutionRecord>();
  for (const execution of executions.data ?? []) byId.set(execution.request.executionId, execution);
  for (const execution of events?.executions.get(session.sessionId)?.values() ?? []) {
    byId.set(execution.request.executionId, execution);
  }
  return [...byId.values()]
    .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt))
    .map((execution) => (
      <ComputeRunEntry
        key={execution.request.executionId}
        {...shared}
        session={session}
        execution={execution}
        live={liveOutputs(events, session, execution)}
        newest={newest}
        fresh
      />
    ));
}

function AgentRunLink(props: { readonly environmentId: EnvironmentId; readonly actor: string }) {
  const gt = useGT();
  const threadRef = { environmentId: props.environmentId, threadId: ThreadId.make(props.actor) };
  const thread = useQuietThreadShell(threadRef);
  if (!thread)
    return (
      <ScientTooltip content={gt("Agent thread unavailable")}>
        <span
          role="img"
          aria-label={gt("Agent thread unavailable")}
          className="grid size-7 shrink-0 place-items-center text-muted-foreground"
        >
          <Bot aria-hidden className="size-3.5" />
        </span>
      </ScientTooltip>
    );
  return (
    <ScientTooltip content={thread.title}>
      <Button
        variant="ghost-muted"
        size="icon-compact"
        focus="edge"
        aria-label={gt("Open agent thread: {title}", { title: thread.title })}
        render={<Link to="/$environmentId/$threadId" params={threadRef} />}
      >
        <Bot aria-hidden />
      </Button>
    </ScientTooltip>
  );
}

function ComputeHistoryEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly metadata?: ReactNode;
  readonly detailLanguage?: string | undefined;
  readonly parameters?: Readonly<Record<string, string>> | undefined;
  readonly outcome: string;
  readonly status: string;
  readonly submittedAt?: string;
  readonly actor?: string | undefined;
  readonly reveal?: ComputeCitation | null;
  readonly focusRun?: ComputeHistoryFocus | null;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const timeId = useId();
  const when = props.submittedAt ? formatReceiptDateTime(props.submittedAt, timestampFormat) : null;
  const request = props.reveal ?? props.focusRun;
  const [open, setOpen] = useState(request != null);
  const [seenRequest, setSeenRequest] = useState(request);
  if (request !== seenRequest) {
    setSeenRequest(request);
    if (request != null) setOpen(true);
  }
  const trigger = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a direct navigation scrolls the newly opened run into view
  useLayoutEffect(() => {
    if (props.focusRun) trigger.current?.scrollIntoView({ block: "nearest" });
  }, [props.focusRun]);
  const failed = props.status === "failed" || props.status === "lost";
  const busy = ["running", "submitting", "starting", "interrupting"].includes(props.status);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-open={open || undefined}
        className={cn(
          disclosureRowSurface,
          "group/history-row grid min-h-11 min-w-0 items-center",
          when
            ? "grid-cols-[minmax(0,1fr)_auto_5rem_1.375rem]"
            : "grid-cols-[minmax(0,1fr)_auto_0rem_1.375rem]",
        )}
      >
        <CollapsibleTrigger
          ref={trigger}
          variant="row"
          className="col-span-full row-start-1 grid min-h-11 min-w-0 grid-cols-subgrid items-center py-1 text-start"
          aria-describedby={when ? timeId : undefined}
        >
          <span className="min-w-0 ps-2 pe-1.5">
            <ComputeTruncatedText text={props.label} className="text-sm font-medium" />
            <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
              {props.metadata ? <span className="truncate">{props.metadata}</span> : null}
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1",
                  props.status === "succeeded" && "sr-only",
                )}
              >
                {props.metadata && props.status !== "succeeded" ? <span aria-hidden>·</span> : null}
                {failed ? (
                  <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
                ) : null}
                {busy ? <Spinner size="xs" aria-hidden role="presentation" /> : null}
                <span className="break-words">{props.outcome}</span>
              </span>
              {props.parameters && Object.keys(props.parameters).length > 0 ? (
                <span className="flex min-w-0 basis-24 flex-1 items-center gap-1">
                  <span aria-hidden>·</span>
                  <ComputeRunParameters parameters={props.parameters} />
                </span>
              ) : null}
            </span>
          </span>
          {props.submittedAt && when ? (
            <ScientTooltip content={when}>
              <time
                dateTime={props.submittedAt}
                className="col-start-3 truncate ps-1 pe-1.5 text-end text-xs text-muted-foreground tabular-nums"
              >
                <RelativeTime timestamp={props.submittedAt} />
              </time>
            </ScientTooltip>
          ) : null}
          <ChevronRight
            className="invisible col-start-4 size-3.5 text-muted-foreground group-hover/history-row:visible group-focus-within/history-row:visible group-data-open/history-row:visible group-data-open/history-row:rotate-90"
            aria-hidden
          />
        </CollapsibleTrigger>
        {when ? (
          <span id={timeId} className="sr-only">
            {when}
          </span>
        ) : null}
        {props.actor || props.actions ? (
          <span className="z-10 col-start-2 row-start-1 flex items-center gap-0.5">
            {props.actor ? (
              <AgentRunLink environmentId={props.environmentId} actor={props.actor} />
            ) : null}
            {props.actions}
          </span>
        ) : null}
      </div>
      <CollapsiblePanel animate={false}>
        <div className="px-2 py-2">
          {when || props.detailLanguage ? (
            <p className="mb-2 text-xs text-muted-foreground tabular-nums">
              {[props.detailLanguage, when].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {props.children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function firstCodeLine(code: string) {
  return code.trim().split("\n", 1)[0]?.slice(0, 120) ?? "";
}

function firstSnippetLine(code: string, language: string) {
  const lineComment = language === "sql" ? "--" : language === "matlab" ? "%" : "#";
  const blockComments = language === "julia";
  let juliaCommentDepth = 0;
  for (const rawLine of code.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (blockComments) {
      while (juliaCommentDepth > 0 || line.startsWith("#=")) {
        const delimiter = /#=|=#/u.exec(line);
        if (!delimiter) {
          line = "";
          break;
        }
        juliaCommentDepth += delimiter[0] === "#=" ? 1 : -1;
        line = line.slice(delimiter.index + 2).trimStart();
      }
    }
    if (line && !line.startsWith(lineComment) && !/^#(?:\s*(?:%%|In\[)|#\s*----)/u.test(line)) {
      return line.slice(0, 120);
    }
  }
  return "";
}

function FileHistoryStop(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly run: Extract<ComputeFeedEntry, { kind: "batch" }>["run"];
}) {
  const cancel = useCancelComputeBatchRun();
  return (
    <ComputeStopButton
      labeled
      stopping={props.run.receipt.cancellationRequested}
      onStop={() =>
        cancel({
          environmentId: props.environmentId,
          cwd: props.cwd,
          runId: props.run.receipt.runId,
        })
      }
    />
  );
}

function NotebookBatchCells(
  props: SharedRunProps & {
    readonly session: ComputeSessionRecord;
    readonly batchId: NonNullable<ComputeRunHistoryInput["notebookBatchId"]>;
    readonly batchStatus: string;
    readonly focusRun?: ComputeHistoryFocus | null;
    readonly quotedRun?: ComputeRunHistoryResult["runs"][number] | undefined;
    readonly events: ComputeSubscriptionState | null;
  },
) {
  const { batchId, batchStatus, session, events, quotedRun, focusRun, ...shared } = props;
  const gt = useGT();
  const messages = useMessages();
  const [pages, setPages] = useState<ReadonlyArray<NonNullable<ComputeRunHistoryInput["before"]>>>(
    [],
  );
  const before = pages.at(-1);
  const page = useEnvironmentQuery(
    computeEnvironment.runHistory({
      environmentId: shared.environmentId,
      input: {
        cwd: shared.cwd,
        limit: 30,
        sessionId: session.sessionId,
        notebookBatchId: batchId,
        ...(before === undefined ? {} : { before }),
      },
    }),
  );
  const refreshCells = useStableCallback(() => page.refresh());
  const previousStatus = useRef(batchStatus);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reread the visible page when its batch settles
  useEffect(() => {
    if (previousStatus.current === batchStatus) return;
    previousStatus.current = batchStatus;
    if (
      batchStatus === "succeeded" ||
      batchStatus === "failed" ||
      batchStatus === "cancelled" ||
      batchStatus === "lost"
    )
      refreshCells();
  }, [batchStatus, refreshCells]);
  const live = events?.executions.get(session.sessionId);
  const quote = usePendingComputeQuote(shared.threadRef, (citation) => citation);
  const quotedId = quote?.place._tag === "run" ? quote.place.executionId : null;
  const rows = page.data?.runs ?? [];
  const visible =
    quotedRun &&
    !rows.some(
      (row) => row.execution.request.executionId === quotedRun.execution.request.executionId,
    )
      ? [...rows, quotedRun].toSorted((left, right) => {
          const indexOf = ({ execution }: typeof left) =>
            execution.request.source._tag === "document"
              ? (execution.request.source.notebookBatch?.index ?? Infinity)
              : Infinity;
          return indexOf(left) - indexOf(right);
        })
      : rows;
  return (
    <div className="flex flex-col gap-0.5">
      {page.isPending ? (
        <p className="px-3 text-xs text-muted-foreground">
          <T>Loading cells…</T>
        </p>
      ) : null}
      {page.error ? (
        <p className="px-3 text-xs text-muted-foreground">
          <T>Couldn&apos;t load cells</T>
        </p>
      ) : null}
      {visible.map((row) => {
        const id = row.execution.request.executionId;
        const execution = live?.get(id) ?? row.execution;
        const source = execution.request.source;
        const index = source._tag === "document" ? source.notebookBatch?.index : undefined;
        const stoppedBeforeStart = computeNotebookCellNotRun(execution);
        const preview = firstCodeLine(execution.request.code);
        return (
          <ComputeHistoryEntry
            key={id}
            reveal={id === quotedId ? quote : null}
            focusRun={
              focusRun && "executionId" in focusRun && id === focusRun.executionId ? focusRun : null
            }
            environmentId={shared.environmentId}
            label={index === undefined ? gt("Cell") : gt("Cell {number}", { number: index + 1 })}
            metadata={preview || undefined}
            status={execution.result?.status ?? "queued"}
            outcome={
              stoppedBeforeStart
                ? gt("Not run")
                : computeExecutionStatusLabel(execution.result, messages)
            }
          >
            <ComputeRunEntry
              {...shared}
              session={session}
              execution={execution}
              live={liveOutputs(events, session, execution)}
              newest={false}
              fresh={session.lifetime === "fresh"}
              {...(preview.length <= 24 ? { codePreview: preview } : {})}
              historyDetail
            />
          </ComputeHistoryEntry>
        );
      })}
      {pages.length > 0 || page.data?.next ? (
        <div className="flex justify-end gap-2 px-3 py-2">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={pages.length === 0}
            onClick={() => setPages((current) => current.slice(0, -1))}
          >
            <T>Previous cells</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={page.data?.next == null}
            onClick={() => {
              const next = page.data?.next;
              if (next != null) setPages((current) => [...current, next]);
            }}
          >
            <T>Next cells</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A session's runs as one cumulative feed, newest last. It follows new output while scrolled to the
 * bottom and stops when the reader scrolls up; a newly submitted run resumes following.
 */
export function ComputeResultsFeed(
  props: SharedRunProps & {
    readonly entries: ReadonlyArray<ComputeFeedEntry>;
    readonly events: ComputeSubscriptionState | null;
    readonly dependencyRecoveryFor: (
      entry: Extract<ComputeFeedEntry, { readonly kind: "run" }>,
    ) => ComputeRunEntryProps["dependencyRecovery"];
    readonly followRequest: string | null;
    readonly projectHistory?: boolean;
    readonly quotedRun?: ComputeRunHistoryResult["runs"][number] | undefined;
    readonly focusRun?: ComputeHistoryFocus | null;
    readonly onFollowRequestConsumed?: (request: string) => void;
    readonly lead?: ReactNode;
    readonly empty: ReactNode;
  },
) {
  const {
    entries,
    events,
    dependencyRecoveryFor,
    followRequest,
    projectHistory,
    quotedRun,
    focusRun,
    onFollowRequestConsumed,
    lead,
    empty,
    ...shared
  } = props;
  const gt = useGT();
  const messages = useMessages();
  const [shown, setShown] = useState(FEED_PAGE);
  const following = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const [quoteViewport, setQuoteViewport] = useState<HTMLDivElement | null>(null);
  const attachViewport = useStableCallback((node: HTMLDivElement | null) => {
    viewport.current = node;
    setQuoteViewport(node);
  });
  const pendingReveal = usePendingComputeQuote(shared.threadRef, (citation) =>
    citation.place._tag === "run" ? citation : null,
  );
  const revealRun = pendingReveal?.place._tag === "run" ? pendingReveal.place.executionId : null;
  const revealIndex = entries.findIndex(
    (entry) => entry.kind === "run" && entry.execution.request.executionId === revealRun,
  );
  // A quote of an older run pages back until that run is on the page.
  if (revealIndex >= 0 && shown < entries.length - revealIndex) {
    setShown(entries.length - revealIndex);
  }
  const visible = projectHistory ? entries : entries.slice(-shown);
  const newestKey = entries.findLast((entry) => entry.kind !== "restart")?.key ?? null;

  // Content and viewport both report; the reader's position decides whether to stay at the end.
  const observe = (content: HTMLDivElement | null) => {
    const node = content?.parentElement;
    if (content == null || node == null) return;
    const onScroll = () => {
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    const stop = observeResize([content, node], () => {
      if (!projectHistory && following.current) node.scrollTop = node.scrollHeight;
    });
    return () => {
      node.removeEventListener("scroll", onScroll);
      stop();
    };
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a submitted run moves the scroll container to the end and reports the request consumed
  useEffect(() => {
    if (followRequest === null) return;
    following.current = true;
    const node = viewport.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
    onFollowRequestConsumed?.(followRequest);
  }, [followRequest, onFollowRequestConsumed]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a quote's chip moves the reader to its run, so the feed stops following the end
  useEffect(() => {
    if (revealRun !== null) following.current = false;
  }, [revealRun]);

  if (entries.length === 0 && lead == null) return <>{empty}</>;
  return (
    <div
      ref={attachViewport}
      data-assistant-citation-viewport=""
      className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto"
    >
      <ComputeQuoteActions
        viewport={quoteViewport}
        threadRef={shared.threadRef}
        cwd={shared.cwd}
        placeOf={computeRunPlace}
      />
      <div
        ref={observe}
        className={
          projectHistory ? "flex flex-col gap-0.5 px-3 pb-2" : "divide-y divide-border/60 pb-2"
        }
      >
        {lead}
        {entries.length > visible.length ? (
          <div className="flex justify-center py-1.5">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                following.current = false;
                setShown((current) => current + FEED_PAGE);
              }}
            >
              <T>Show earlier runs</T>
            </Button>
          </div>
        ) : null}
        {visible.map((entry) => {
          switch (entry.kind) {
            case "restart":
              return (
                <div
                  key={entry.key}
                  role="separator"
                  className="px-3 py-1 text-center text-[11px] text-muted-foreground"
                >
                  <T>Restarted</T>
                </div>
              );
            case "fresh":
              return (
                <ComputeFreshEntry
                  key={entry.key}
                  {...shared}
                  session={entry.session}
                  events={events}
                  newest={entry.key === newestKey}
                />
              );
            case "batch": {
              const { run } = entry;
              const status =
                run.receipt.cancellationRequested &&
                !isTerminalAnalysisRunStatus(run.receipt.status)
                  ? "interrupting"
                  : run.receipt.status;
              return (
                <ComputeHistoryEntry
                  key={entry.key}
                  environmentId={shared.environmentId}
                  label={run.source.relativePath}
                  focusRun={
                    focusRun && "fileRunId" in focusRun && run.receipt.runId === focusRun.fileRunId
                      ? focusRun
                      : null
                  }
                  metadata={run.runtime.label}
                  parameters={run.parameters}
                  status={status}
                  outcome={computeExecutionStatusLabel(
                    {
                      status: status === "starting" ? "submitting" : status,
                      queuePosition: null,
                    },
                    messages,
                  )}
                  actions={
                    !isTerminalAnalysisRunStatus(run.receipt.status) ? (
                      <FileHistoryStop
                        environmentId={shared.environmentId}
                        cwd={shared.cwd}
                        run={run}
                      />
                    ) : null
                  }
                  submittedAt={run.receipt.startedAt}
                  actor={run.agentThreadId}
                >
                  <PersistedRunOutput
                    key={run.receipt.finishedAt ?? "in-flight"}
                    environmentId={shared.environmentId}
                    cwd={shared.cwd}
                    runId={run.receipt.runId}
                    runtimeLabel={run.runtime.label}
                    threadRef={shared.threadRef}
                    storageStatus={run.localStorage.status}
                  />
                </ComputeHistoryEntry>
              );
            }
            case "run": {
              const recovery = dependencyRecoveryFor(entry);
              if (projectHistory) {
                const { source, actor, submittedAt, executionId } = entry.execution.request;
                const batch = entry.notebookBatch;
                const preview =
                  source._tag === "console"
                    ? firstSnippetLine(entry.execution.request.code, entry.session.languageId)
                    : undefined;
                const status = batch?.status ?? entry.execution.result?.status ?? "queued";
                const runningCell =
                  batch?.mode === "all" && status === "running" ? batch.currentCell : undefined;
                const quotedSource = quotedRun?.execution.request.source;
                const quotedCell =
                  batch &&
                  quotedSource?._tag === "document" &&
                  quotedSource.notebookBatch?.id === batch.id
                    ? quotedRun
                    : undefined;
                const shouldReveal =
                  executionId === revealRun ||
                  (quotedCell !== undefined &&
                    quotedCell.execution.request.executionId === revealRun);
                const shouldFocus =
                  focusRun !== null &&
                  focusRun !== undefined &&
                  "executionId" in focusRun &&
                  (executionId === focusRun.executionId ||
                    quotedCell?.execution.request.executionId === focusRun.executionId);
                return (
                  <ComputeHistoryEntry
                    key={entry.key}
                    environmentId={shared.environmentId}
                    focusRun={shouldFocus ? focusRun : null}
                    label={source._tag === "document" ? source.path : preview || gt("Snippet")}
                    metadata={
                      batch
                        ? batch.mode === "all"
                          ? runningCell === undefined
                            ? gt(
                                "Run all · {count, plural, one {# code cell} other {# code cells}}",
                                { count: batch.count },
                              )
                            : gt("Run all")
                          : gt("{count, plural, one {# code cell} other {# code cells}}", {
                              count: batch.count,
                            })
                        : entry.session.label
                    }
                    detailLanguage={batch ? entry.session.label : undefined}
                    parameters={entry.execution.request.parameters}
                    status={status}
                    outcome={
                      batch && runningCell !== undefined
                        ? gt("Running · cell {cell} of {count}", {
                            cell: runningCell,
                            count: batch.count,
                          })
                        : batch?.status === "failed" && batch.failedCell !== undefined
                          ? gt("Failed at cell {cell} of {count} · {notRun} not run", {
                              cell: batch.failedCell,
                              count: batch.count,
                              notRun: batch.notRun ?? 0,
                            })
                          : computeExecutionStatusLabel({ status, queuePosition: null }, messages)
                    }
                    submittedAt={submittedAt}
                    actor={actor?.threadId}
                    reveal={shouldReveal ? pendingReveal : null}
                    actions={
                      batch && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(batch.status) ? null : (
                        <ComputeRunStop
                          {...shared}
                          session={entry.session}
                          execution={batch?.active ?? entry.execution}
                          labeled
                        />
                      )
                    }
                  >
                    {batch ? (
                      <NotebookBatchCells
                        {...shared}
                        session={entry.session}
                        batchId={batch.id}
                        batchStatus={batch.status}
                        focusRun={focusRun ?? null}
                        events={events}
                        quotedRun={quotedCell}
                      />
                    ) : (
                      <ComputeRunEntry
                        {...shared}
                        session={entry.session}
                        execution={entry.execution}
                        live={liveOutputs(events, entry.session, entry.execution)}
                        newest={false}
                        fresh={entry.session.lifetime === "fresh"}
                        {...(preview !== undefined && preview.length <= 24
                          ? { codePreview: preview }
                          : {})}
                        historyDetail
                      />
                    )}
                  </ComputeHistoryEntry>
                );
              }
              return (
                <ComputeRunEntry
                  key={entry.key}
                  {...shared}
                  {...(recovery === undefined ? {} : { dependencyRecovery: recovery })}
                  session={entry.session}
                  execution={entry.execution}
                  live={liveOutputs(events, entry.session, entry.execution)}
                  newest={entry.key === newestKey}
                  fresh={entry.session.lifetime === "fresh"}
                />
              );
            }
          }
        })}
      </div>
    </div>
  );
}
