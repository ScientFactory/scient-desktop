import {
  computeNotebookBatchActivity,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeRunHistoryInput,
  type ComputeRunHistoryResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";

export function useComputeRunHistory(
  environmentId: EnvironmentId,
  input: ComputeRunHistoryInput | null,
) {
  const cwd = input?.cwd;
  const history = useEnvironmentQuery(
    input === null ? null : computeEnvironment.runHistory({ environmentId, input }),
  );
  const events = useEnvironmentQuery(
    cwd == null ? null : computeEnvironment.events({ environmentId, input: { cwd } }),
  );
  const reconnect = useStableCallback(() => {
    history.refresh();
    events.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- recover the durable run page after a stream gap
  useEffect(() => {
    if (events.data?.stale) reconnect();
  }, [events.data?.stale, reconnect]);

  const rows = new Map(
    (history.data?.runs ?? []).map((row) => [row.execution.request.executionId, row]),
  );
  const groupedHistory =
    input !== null &&
    input.path === undefined &&
    input.executionId === undefined &&
    input.notebookBatchId === undefined;
  const notebookChanges: string[] = [];
  if (input !== null) {
    const filter = input.filter?.trim().toLowerCase();
    const boundary = input.before;
    for (const [sessionId, executions] of events.data?.executions ?? []) {
      const session = events.data?.sessions.get(sessionId);
      if (session === undefined) continue;
      for (const execution of executions.values()) {
        const { source, executionId: id } = execution.request;
        if (groupedHistory && source._tag === "document" && source.notebookBatch) {
          if (source.notebookBatch.index === 0) notebookChanges.push(source.notebookBatch.id);
          continue;
        }
        const next = history.data?.next;
        const at = execution.request.submittedAt;
        if (
          !rows.has(id) &&
          (boundary !== undefined ||
            (next != null &&
              (at < next.submittedAt || (at === next.submittedAt && id < next.executionId))))
        )
          continue;
        const path = source._tag === "document" ? source.path : undefined;
        if (
          (input.path === undefined || path === input.path) &&
          (!filter || path?.toLowerCase().includes(filter))
        )
          rows.set(id, { session, execution });
      }
    }
  }
  if (groupedHistory) {
    for (const session of events.data?.sessions.values() ?? []) {
      if (session.lastNotebookBatch)
        notebookChanges.push(`${session.lastNotebookBatch.id}:settled`);
    }
  }
  const notebookChangeKey = notebookChanges.toSorted().join("\n");
  const refreshNotebookHistory = useStableCallback(() => history.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read grouped receipts when a notebook batch arrives or settles
  useEffect(() => {
    if (notebookChangeKey) refreshNotebookHistory();
  }, [notebookChangeKey, refreshNotebookHistory]);
  const runs = [...rows.values()].map((row): ComputeRunHistoryResult["runs"][number] => {
    if (!row.notebookBatch || !events.data) return row;
    const session = events.data.sessions.get(row.session.sessionId);
    const settled = session?.lastNotebookBatch;
    if (settled?.id === row.notebookBatch.id) {
      return { ...row, session: session!, notebookBatch: settled };
    }
    const { active: _cachedActive, ...batch } = row.notebookBatch;
    const live = events.data.executions.get(row.session.sessionId);
    if (!live || TERMINAL_COMPUTE_EXECUTION_STATUSES.has(batch.status)) return row;
    const { active, currentCell } = computeNotebookBatchActivity(live.values(), batch.id);
    if (batch.mode === "all") {
      const cell = Math.max(batch.currentCell ?? 0, currentCell);
      if (cell === 0) return row;
      return {
        ...row,
        session: session ?? row.session,
        notebookBatch: {
          ...batch,
          currentCell: cell,
          status:
            (active?.result?.status ?? batch.status) === "interrupting"
              ? "interrupting"
              : "running",
          ...(active === undefined ? {} : { active }),
        },
      };
    }
    const status = active?.result?.status;
    if (active === undefined || status === undefined) return row;
    return {
      ...row,
      session: session ?? row.session,
      notebookBatch: { ...batch, active, status },
    };
  });
  return {
    runs,
    fileRuns: history.data?.fileRuns ?? [],
    next: history.data?.next ?? null,
    error: history.error,
    pending: history.isPending,
    events: events.data,
    rehydrationToken: events.data?.observedGap
      ? `${events.data.observedGap.expected}:${events.data.observedGap.received}`
      : null,
  };
}
