import { useStableCallback } from "~/hooks/useStableCallback";
import type { ComputeOutputProjection } from "@t3tools/client-runtime/state/compute";
import {
  computeNotebookCellNotRun,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeRuntimeInspection,
  type ComputeResultsPublicationResult,
  type ComputeSessionRecord,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages } from "gt-react";
import { ChevronRight, LoaderCircle, MessageSquarePlus, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useEnvironmentQuery } from "~/state/query";
import { formatReceiptDateTime } from "~/timestampFormat";

import type { ComputeContextId } from "./computeContextStore";
import { ComputeOutputView } from "./ComputeOutputView";
import { computeRunAttributes, useAskAboutCompute } from "./ComputeQuoteActions";
import {
  finishComputeQuoteReveal,
  showComputeQuote,
  usePendingComputeQuote,
} from "./computeQuoteReveal";
import {
  computeExecutionStatusLabel,
  computeRunDurationLabel,
  computeSourceLabel,
  mergeComputeOutputs,
} from "./computeResultPresentation";
import { reportComputeFailure } from "./ComputeSessionControls";

function RunPublication({ result }: { readonly result: ComputeResultsPublicationResult }) {
  const gt = useGT();
  if (result._tag === "unavailable") return null;
  if (result._tag === "failed")
    return (
      <p role="alert" className="mt-1 text-xs text-destructive">
        {result.message}
      </p>
    );
  const counts = result.counts;
  const items =
    counts === undefined
      ? []
      : [
          counts.values > 0
            ? gt("{count, plural, one {# value} other {# values}}", { count: counts.values })
            : null,
          counts.tables > 0
            ? gt("{count, plural, one {# table} other {# tables}}", { count: counts.tables })
            : null,
          counts.figures > 0
            ? gt("{count, plural, one {# figure} other {# figures}}", { count: counts.figures })
            : null,
          counts.files > 0
            ? gt("{count, plural, one {# other file} other {# other files}}", {
                count: counts.files,
              })
            : null,
        ].filter((item) => item !== null);
  return (
    <p role="status" className="mt-1 text-xs text-muted-foreground">
      {items.length === 0
        ? gt("Results saved.")
        : gt("Saved {items}.", {
            items: new Intl.ListFormat(undefined, { style: "long", type: "conjunction" }).format(
              items,
            ),
          })}
    </p>
  );
}

export type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

export interface ComputeRunEntryProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly session: ComputeSessionRecord;
  readonly execution: ComputeExecutionRecord;
  readonly live: ComputeOutputProjection | undefined;
  readonly rehydrationToken: string | null;
  /** The newest run: its figures may follow later runs in an open viewer. */
  readonly newest: boolean;
  readonly historyDetail?: boolean;
  readonly codePreview?: string;
  readonly codeInitiallyOpen?: boolean;
  readonly interruptControlledSessionId?: string;
  readonly fresh: boolean;
  readonly includeSourcePath: boolean;
  readonly runtimeInspection: ComputeRuntimeInspection | null;
  readonly dependencyRecovery?: {
    readonly contextId: ComputeContextId;
    readonly onSettled: () => void;
  };
  readonly onRevealSource?: (source: Extract<ComputeExecutionSource, { _tag: "document" }>) => void;
}

const CONSOLE_CODE_LINES = 12;

/** What was typed at the Console; a long paste folds so the results stay in view. */
function ConsoleCode(props: {
  readonly code: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const { code, open } = props;
  const lines = code.split("\n");
  const long = lines.length > CONSOLE_CODE_LINES;
  return (
    <div className="min-w-0 flex-1">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground">
        {long && !open ? lines.slice(0, CONSOLE_CODE_LINES).join("\n") : code}
      </pre>
      {long ? (
        <button
          type="button"
          className="cursor-pointer text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
          onClick={props.onToggle}
        >
          {open ? gt("Show less") : gt("Show all {count} lines", { count: lines.length })}
        </button>
      ) : null}
    </div>
  );
}

export function ComputeRunStop(
  props: Pick<ComputeRunEntryProps, "environmentId" | "cwd" | "session" | "execution"> & {
    readonly labeled?: boolean;
  },
) {
  const gt = useGT();
  const { session, execution } = props;
  const status = execution.result?.status;
  const cancelExecution = useAtomCommand(computeEnvironment.cancelExecution, {
    reportFailure: false,
  });
  const cancel = async () => {
    const result = await cancelExecution({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: session.sessionId,
        executionId: execution.request.executionId,
        expectedGeneration: session.generation,
      },
    });
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      reportComputeFailure(gt("Unable to cancel this run"), result);
    }
  };

  if (
    status === undefined ||
    TERMINAL_COMPUTE_EXECUTION_STATUSES.has(status) ||
    session.generation !== execution.request.generation
  )
    return null;
  return (
    <ComputeStopButton
      labeled={props.labeled ?? false}
      stopping={status === "interrupting"}
      onStop={cancel}
    />
  );
}

export function ComputeStopButton(props: {
  readonly labeled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<unknown>;
}) {
  const gt = useGT();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size={props.labeled ? "compact" : "icon-xs"}
      variant={props.labeled ? "ghost-destructive" : "ghost-muted"}
      focus="edge"
      aria-label={gt("Stop run")}
      disabled={props.stopping || pending}
      onClick={() => {
        setPending(true);
        void props.onStop().finally(() => setPending(false));
      }}
    >
      <Square className="size-3" aria-hidden />
      {props.labeled ? <T>Stop</T> : null}
    </Button>
  );
}

/** One run in a Results feed: what ran, how it went, and everything it printed or displayed. */
export function ComputeRunEntry(props: ComputeRunEntryProps) {
  const gt = useGT();
  const messages = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { execution, session } = props;
  const persisted = useEnvironmentQuery(
    computeEnvironment.outputs({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: session.sessionId,
        executionId: execution.request.executionId,
      },
    }),
  );
  const ask = useAskAboutCompute({ threadRef: props.threadRef, cwd: props.cwd });
  const article = useRef<HTMLElement>(null);
  const [codeOpen, setCodeOpen] = useState(props.codeInitiallyOpen ?? false);
  const revealing = usePendingComputeQuote(props.threadRef, (citation) =>
    citation.place._tag === "run" && citation.place.executionId === execution.request.executionId
      ? citation
      : null,
  );
  // A quote from the folded part of a long paste opens it.
  if (revealing !== null && !codeOpen && execution.request.code.includes(revealing.text)) {
    setCodeOpen(true);
  }
  const outputsSettled = !persisted.isPending;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a quote's chip brings this run into view once its output is on the page to find the quote in
  useEffect(() => {
    const source = article.current;
    if (revealing === null || !outputsSettled || source === null) return;
    const scroller = source.closest<HTMLElement>("[data-assistant-citation-viewport]");
    if (scroller !== null) showComputeQuote({ source, scroller, citation: revealing });
    finishComputeQuoteReveal(revealing);
  }, [revealing, outputsSettled]);
  const terminal =
    execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status);
  const status = execution.result?.status ?? null;
  const retainedOutputs = mergeComputeOutputs(
    persisted.data?.outputs ?? [],
    props.live?.outputs ?? [],
  );
  const outputs =
    status === "cancelled"
      ? retainedOutputs.filter((output) => output._tag !== "diagnostic")
      : retainedOutputs;
  // The kernel's own error says why, so the run's reason would only repeat it.
  const explained = outputs.some((output) => output._tag === "diagnostic");

  const refreshOutputs = useStableCallback(() => persisted.refresh());
  const terminalRefreshed = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- confirms durable output truth over the environment connection once a run reaches a terminal state
  useEffect(() => {
    if (!terminal) {
      terminalRefreshed.current = false;
      return;
    }
    if (terminalRefreshed.current) return;
    terminalRefreshed.current = true;
    refreshOutputs();
  }, [terminal, refreshOutputs]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads outputs over the environment connection once per observed rehydration gap token
  useEffect(() => {
    if (props.rehydrationToken !== null) refreshOutputs();
  }, [props.rehydrationToken, refreshOutputs]);

  const source = execution.request.source;
  const publication = useEnvironmentQuery(
    props.fresh &&
      status === "succeeded" &&
      source._tag === "document" &&
      source.origin === "file" &&
      source.bufferState === "saved"
      ? computeEnvironment.resultsPublication({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: session.sessionId,
            executionId: execution.request.executionId,
            scriptPath: source.path,
          },
        })
      : null,
  ).data;
  const actor = execution.request.actor;
  const hasSessionInterrupt =
    session.sessionId === props.interruptControlledSessionId &&
    session.activeExecutionId === execution.request.executionId &&
    session.activity === "busy";
  const failed = status === "failed" || status === "lost";
  const label = computeSourceLabel(source, { includePath: props.includeSourcePath }, messages);
  const quotePlace = {
    sessionId: session.sessionId,
    executionId: execution.request.executionId,
    path: source._tag === "document" ? source.path : null,
  };
  const reveal =
    source._tag === "document" && props.onRevealSource !== undefined
      ? () => props.onRevealSource?.(source)
      : null;
  const duration = computeRunDurationLabel(execution.result);
  const when = [formatReceiptDateTime(execution.request.submittedAt, timestampFormat), duration]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      ref={article}
      {...computeRunAttributes(quotePlace)}
      className={cn("group/run min-w-0", !props.historyDetail && "px-3 py-2")}
      aria-label={gt("{label} run", { label })}
    >
      <header
        hidden={props.historyDetail}
        className={cn(
          !props.historyDetail && "flex",
          "min-h-5 items-start gap-1.5 text-[11px] text-muted-foreground",
        )}
      >
        {source._tag === "console" ? (
          <ConsoleCode
            code={execution.request.code}
            open={codeOpen}
            onToggle={() => setCodeOpen((current) => !current)}
          />
        ) : (
          <ScientTooltip content={when}>
            {reveal === null ? (
              <span className="min-w-0 truncate">{label}</span>
            ) : (
              <button
                type="button"
                className="min-w-0 cursor-pointer truncate rounded-[4px] outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={reveal}
              >
                {label}
              </button>
            )}
          </ScientTooltip>
        )}
        {props.fresh ? (
          <span className="shrink-0 text-muted-foreground/70">
            {gt("Fresh", { $context: "a run in a fresh session" })}
          </span>
        ) : null}
        {actor ? (
          <Link
            className="shrink-0 hover:underline"
            to="/$environmentId/$threadId"
            params={{ environmentId: props.environmentId, threadId: actor.threadId }}
          >
            <T>Agent</T>
          </Link>
        ) : null}
        {source._tag === "console" ? null : <span className="flex-1" />}
        {terminal && ask !== null ? (
          <span className="opacity-0 transition-opacity group-hover/run:opacity-100 focus-within:opacity-100">
            <ScientTooltip content={gt("Ask in chat")}>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Ask in chat")}
                onClick={() => {
                  if (article.current === null) return;
                  ask({
                    source: article.current,
                    place: { _tag: "run", ...quotePlace },
                    text: execution.request.code.trim() || label,
                  });
                }}
              >
                <MessageSquarePlus className="size-3" />
              </Button>
            </ScientTooltip>
          </span>
        ) : null}
        {!terminal ? (
          <>
            {status === "queued" ? (
              <span className="shrink-0">
                {computeExecutionStatusLabel(execution.result, messages)}
              </span>
            ) : (
              <LoaderCircle className="size-3 shrink-0 animate-spin" aria-label={gt("Running")} />
            )}
            {hasSessionInterrupt ? null : (
              <ComputeRunStop
                environmentId={props.environmentId}
                cwd={props.cwd}
                session={session}
                execution={execution}
              />
            )}
          </>
        ) : status !== "succeeded" && !explained ? (
          <span className={cn("shrink-0", failed && "text-destructive")}>
            {computeNotebookCellNotRun(execution)
              ? gt("Not run")
              : computeExecutionStatusLabel(execution.result, messages)}
          </span>
        ) : null}
      </header>
      {publication === null ? null : <RunPublication result={publication} />}
      {status !== "cancelled" && execution.result?.failureReason && !explained ? (
        <p className="mt-1 text-xs text-destructive">{execution.result.failureReason}</p>
      ) : null}
      {outputs.length === 0 && persisted.error ? (
        <p className="text-xs text-destructive">
          <T>Couldn&apos;t load this run&apos;s output</T>
        </p>
      ) : (
        <div className="mt-1 empty:hidden">
          <ComputeOutputView
            {...(props.dependencyRecovery === undefined
              ? {}
              : { dependencyRecovery: props.dependencyRecovery })}
            runtimeInspection={props.runtimeInspection}
            allowFigureFollowing={props.newest}
            cwd={props.cwd}
            environmentId={props.environmentId}
            session={session}
            executionId={execution.request.executionId}
            executionGeneration={execution.request.generation}
            outputs={outputs}
            {...(persisted.data === null
              ? {}
              : { corruptLineCount: persisted.data.corruptLineCount })}
            clipped={persisted.data === null && (props.live?.clipped ?? false)}
            threadRef={props.threadRef}
            source={source}
            onAskAgent={
              ask === null
                ? undefined
                : (text) => {
                    if (article.current === null) return;
                    ask({ source: article.current, place: { _tag: "run", ...quotePlace }, text });
                  }
            }
          />
        </div>
      )}
      {props.historyDetail &&
      execution.request.code.trim() &&
      (execution.request.code.trim() !== props.codePreview || revealing !== null) ? (
        <Collapsible open={codeOpen} onOpenChange={setCodeOpen} className="mt-2">
          <CollapsibleTrigger render={<Button size="compact" variant="ghost-muted" focus="edge" />}>
            <ChevronRight aria-hidden className={cn("size-3.5", codeOpen && "rotate-90")} />
            <T>Code</T>
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
              {execution.request.code}
            </pre>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </article>
  );
}
