import {
  AnalysisRunId,
  ComputeExecutionId,
  ComputeSessionId,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ChevronRight, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { WorkLogButton, WorkLogDetails } from "~/components/chat/WorkLog";
import { RelativeTime } from "~/components/RelativeTime";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatReceiptDateTime } from "~/timestampFormat";
import { computeEnvironment } from "~/state/compute";
import { analysisEnvironment } from "~/state/analysis";
import { useEnvironmentQuery } from "~/state/query";

import { ComputeOutputBlock } from "./ComputeOutputBlock";
import { ComputeRunParameters } from "./ComputeTruncatedText";
import { RunOutputView } from "./ComputeBatchResults";
import { openComputeHistoryRun } from "./computeHistoryFocus";
import { ComputeRunEntry } from "./ComputeRunEntry";
import { computeSourceLanguageForId } from "./computeSourceLanguage";
import { computeExecutionStatusLabel } from "./computeResultPresentation";
import { computeToolRunStatus, readComputeToolActivity } from "./computeToolRunProjection";

export function ComputeToolWorkRow(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
  readonly timestamp: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly icon: ReactNode;
  readonly failed?: boolean;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { item } = props;
  const activity = readComputeToolActivity(item.input, item.output);
  const status = computeToolRunStatus(props.failed ? "failed" : item.status, activity.status);
  const label = item.toolName?.endsWith("scient_compute_output")
    ? gt("Read Compute output")
    : activity.file
      ? gt("Ran {file}", { file: activity.file })
      : item.toolName?.endsWith("scient_compute_run_file")
        ? gt("Ran a project file")
        : gt("Ran {language}", { language: computeLanguageLabel(activity.language) });
  const outcome =
    status === null ? null : computeExecutionStatusLabel({ status, queuePosition: null }, messages);
  const busy = status === "running" || status === "submitting" || status === "interrupting";
  const failed = status === "failed" || status === "lost";
  return (
    <>
      <WorkLogButton
        surface="disclosure"
        aria-expanded={props.expanded}
        icon={props.icon}
        onClick={props.onToggle}
        label={
          <span className="block min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{label}</span>
              {outcome !== null ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
                    status === "succeeded" && "sr-only",
                  )}
                >
                  {failed ? (
                    <CircleAlert className="size-3.5 text-destructive" aria-hidden />
                  ) : null}
                  {busy ? <Spinner size="xs" role="presentation" aria-hidden /> : null}
                  {outcome}
                </span>
              ) : null}
            </span>
            <ComputeRunParameters parameters={activity.parameters} />
          </span>
        }
        trailing={
          <span className="flex shrink-0 items-center gap-2 pe-2 text-xs text-muted-foreground tabular-nums">
            <RelativeTime timestamp={props.timestamp} />
            <ChevronRight aria-hidden className={cn("size-3.5", props.expanded && "rotate-90")} />
          </span>
        }
      />
      {props.expanded ? <WorkLogDetails kind="panel">{props.children}</WorkLogDetails> : null}
    </>
  );
}

function computeLanguageLabel(language: string | undefined) {
  const id = language?.toLowerCase() ?? "python";
  const normalized = id === "py" ? "python" : id === "jl" ? "julia" : id;
  return computeSourceLanguageForId(normalized).displayName;
}

export function ComputeToolActivity(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly outputPending?: boolean;
  readonly createdAt?: string | undefined;
  readonly images?: ReactNode;
}) {
  const { threadRef, cwd } = props;
  const { environmentId } = threadRef;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const activity = readComputeToolActivity(props.input, props.output);
  const row = useEnvironmentQuery(
    cwd &&
      activity.session &&
      activity.run &&
      activity.session.length <= 128 &&
      activity.run.length <= 128
      ? computeEnvironment.runHistory({
          environmentId,
          input: {
            cwd,
            limit: 1,
            sessionId: ComputeSessionId.make(activity.session),
            executionId: ComputeExecutionId.make(activity.run),
          },
        })
      : null,
  );
  const file = useEnvironmentQuery(
    cwd && activity.file && activity.run && !activity.session && activity.run.length <= 128
      ? analysisEnvironment.run({
          environmentId,
          input: { cwd, runId: AnalysisRunId.make(activity.run) },
        })
      : null,
  );
  const run = row.data?.runs[0];
  const events = useEnvironmentQuery(
    cwd && run ? computeEnvironment.events({ environmentId, input: { cwd } }) : null,
  );
  const fileRun = file.data;
  if (cwd && (run || fileRun)) {
    const executionId = run?.execution.request.executionId;
    const sessionId = run?.session.sessionId;
    const execution =
      executionId && sessionId
        ? (events.data?.executions.get(sessionId)?.get(executionId) ?? run?.execution)
        : undefined;
    const submittedAt = execution?.request.submittedAt ?? fileRun?.receipt.startedAt;
    const target =
      executionId && sessionId
        ? { threadRef, cwd, sessionId, executionId }
        : fileRun
          ? { threadRef, cwd, fileRunId: fileRun.receipt.runId }
          : null;
    return (
      <div className="ms-7 space-y-2 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {submittedAt ? (
            <time dateTime={submittedAt} className="text-xs text-muted-foreground tabular-nums">
              {formatReceiptDateTime(submittedAt, timestampFormat)}
            </time>
          ) : null}
          {target ? (
            <Button
              variant="ghost-muted"
              focus="edge"
              size="compact"
              onClick={() => openComputeHistoryRun(target)}
            >
              <T>Open in Compute history</T>
            </Button>
          ) : null}
        </div>
        {run && execution ? (
          <ComputeRunEntry
            cwd={cwd}
            environmentId={environmentId}
            threadRef={threadRef}
            session={run.session}
            execution={execution}
            live={events.data?.outputs.get(`${sessionId}/${executionId}`)}
            rehydrationToken={null}
            newest={false}
            fresh={run.session.lifetime === "fresh"}
            includeSourcePath
            runtimeInspection={null}
            historyDetail
            codeInitiallyOpen
          />
        ) : fileRun ? (
          <RunOutputView run={fileRun} runtimeLabel={fileRun.runtime.label} threadRef={threadRef} />
        ) : null}
      </div>
    );
  }
  const output =
    activity.output ?? (props.status === "failed" ? activity.failureReason : undefined);
  return (
    <div className="ms-7 space-y-2 py-2 text-xs">
      {props.createdAt ? (
        <time dateTime={props.createdAt} className="block text-muted-foreground tabular-nums">
          {formatReceiptDateTime(props.createdAt, timestampFormat)}
        </time>
      ) : null}
      <p className="text-muted-foreground">
        {props.outputPending || row.isPending || file.isPending ? (
          <T>Loading run…</T>
        ) : (
          <T>Run details unavailable</T>
        )}
      </p>
      {output ? (
        <ComputeOutputBlock copy={() => ({ text: output })}>
          <pre className="whitespace-pre-wrap break-words font-mono">{output}</pre>
        </ComputeOutputBlock>
      ) : null}
      {props.images}
      {activity.code ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">
          {activity.code}
        </pre>
      ) : null}
    </div>
  );
}
