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
import { LoaderCircle, Square } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
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
  const label = computeSourceLabel(source, { includePath: props.includeSourcePath });
  const reveal =
    source._tag === "document" && props.onRevealSource !== undefined
      ? () => props.onRevealSource?.(source)
      : null;
  const duration = computeRunDurationLabel(execution.result);
  return (
    <article className="min-w-0 px-3 py-2" aria-label={`${label} run`}>
      <header className="flex min-h-6 items-center gap-2 text-[11px] text-muted-foreground">
        {reveal === null ? (
          <span className="min-w-0 truncate font-medium">{label}</span>
        ) : (
          <button
            type="button"
            className="min-w-0 cursor-pointer truncate rounded-[4px] font-medium outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            title={formatDateTimeTimestamp(execution.request.submittedAt, timestampFormat)}
            onClick={reveal}
          >
            {label}
          </button>
        )}
        {props.fresh ? <span>Fresh</span> : null}
        <span className="flex-1" />
        {status !== "succeeded" ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              (status === "failed" || status === "lost") && "text-destructive",
            )}
          >
            {!terminal ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {computeExecutionStatusLabel(execution.result)}
          </span>
        ) : null}
        {duration !== null ? <span className="shrink-0 tabular-nums">{duration}</span> : null}
        {!terminal ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Cancel run"
            onClick={() => void cancel()}
          >
            <Square className="size-3" />
          </Button>
        ) : null}
      </header>
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
