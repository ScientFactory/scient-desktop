import { useStableCallback } from "~/hooks/useStableCallback";
import type { ComputeOutputProjection } from "@t3tools/client-runtime/state/compute";
import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeRuntimeInspection,
  type ComputeSessionRecord,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { LoaderCircle, MessageSquarePlus, Square } from "lucide-react";
import { askInChatAboutCompute } from "./computeAskInChat";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useEnvironmentQuery } from "~/state/query";
import { formatDateTimeTimestamp } from "~/timestampFormat";

import type { ComputeContextId } from "./computeContextStore";
import { ComputeOutputView } from "./ComputeOutputView";
import {
  computeExecutionStatusLabel,
  computeRunDurationLabel,
  computeSourceLabel,
  mergeComputeOutputs,
} from "./computeResultPresentation";
import { reportComputeFailure } from "./ComputeSessionControls";

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
function ConsoleCode({ code }: { readonly code: string }) {
  const [open, setOpen] = useState(false);
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
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}

/** One run in a Results feed: what ran, how it went, and everything it printed or displayed. */
export function ComputeRunEntry(props: ComputeRunEntryProps) {
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
  const cancelExecution = useAtomCommand(computeEnvironment.cancelExecution, {
    reportFailure: false,
  });
  const terminal =
    execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status);
  const outputs = mergeComputeOutputs(persisted.data?.outputs ?? [], props.live?.outputs ?? []);

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
      reportComputeFailure("Unable to cancel this run", result);
    }
  };

  const source = execution.request.source;
  const status = execution.result?.status ?? null;
  const failed = status === "failed" || status === "lost";
  const label = computeSourceLabel(source, { includePath: props.includeSourcePath });
  const reveal =
    source._tag === "document" && props.onRevealSource !== undefined
      ? () => props.onRevealSource?.(source)
      : null;
  const duration = computeRunDurationLabel(execution.result);
  const when = [formatDateTimeTimestamp(execution.request.submittedAt, timestampFormat), duration]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="group/run min-w-0 px-3 py-2" aria-label={`${label} run`}>
      <header className="flex min-h-5 items-start gap-1.5 text-[11px] text-muted-foreground">
        {source._tag === "console" ? (
          <ConsoleCode code={execution.request.code} />
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
        {props.fresh ? <span className="shrink-0 text-muted-foreground/70">Fresh</span> : null}
        {execution.request.actor?._tag === "agent" ? (
          <span className="shrink-0 text-muted-foreground/70">Agent</span>
        ) : null}
        {source._tag === "console" ? null : <span className="flex-1" />}
        {terminal ? (
          <span className="opacity-0 transition-opacity group-hover/run:opacity-100 focus-within:opacity-100">
            <ScientTooltip content="Ask in chat">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Ask in chat"
                onClick={() =>
                  askInChatAboutCompute({
                    threadRef: props.threadRef,
                    what: source._tag === "document" ? `${label} of ${source.path}` : label,
                    submittedAt: execution.request.submittedAt,
                  })
                }
              >
                <MessageSquarePlus className="size-3" />
              </Button>
            </ScientTooltip>
          </span>
        ) : null}
        {!terminal ? (
          <>
            {status === "queued" ? (
              <span className="shrink-0">{computeExecutionStatusLabel(execution.result)}</span>
            ) : (
              <LoaderCircle className="size-3 shrink-0 animate-spin" aria-label="Running" />
            )}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Cancel run"
              onClick={() => void cancel()}
            >
              <Square className="size-3" />
            </Button>
          </>
        ) : status !== "succeeded" && !outputs.some((output) => output._tag === "diagnostic") ? (
          <span className={cn("shrink-0", failed && "text-destructive")}>
            {computeExecutionStatusLabel(execution.result)}
          </span>
        ) : null}
      </header>
      {execution.result?.failureReason ? (
        <p className="mt-1 text-xs text-destructive">{execution.result.failureReason}</p>
      ) : null}
      {outputs.length === 0 && persisted.error ? (
        <p className="text-xs text-destructive">Couldn&apos;t load this run&apos;s output</p>
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
          />
        </div>
      )}
    </article>
  );
}
