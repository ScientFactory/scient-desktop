import { useStableCallback } from "~/hooks/useStableCallback";
import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeExecutionRecord,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";

import { mergeComputeSessionRecords } from "./computeContextCoordinator";
import { useComputeContextStore, type ComputeContextId } from "./computeContextStore";

/** The server keeps every run; one feed reads at most this many of a session's newest. */
const FEED_EXECUTION_LIMIT = 200;

/**
 * Session truth for one Results surface: durable queries reconciled with the live stream. A
 * file tab sees its bound session and its Run fresh children; project history may pick any.
 */
export function useComputePanelSessions(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly contextId: ComputeContextId | undefined;
  readonly sourcePath: string | undefined;
}) {
  const [chosenSessionId, setChosenSessionId] = useState<string | null>(null);
  const contextBinding = useComputeContextStore((state) =>
    input.contextId === undefined ? null : (state.bindings[input.contextId] ?? null),
  );
  const freshSessionIds = useComputeContextStore((state) =>
    input.contextId === undefined
      ? ""
      : Object.values(state.bindings)
          .flatMap((binding) =>
            binding.parentContextId === input.contextId &&
            binding.batchRunId === undefined &&
            binding.sessionId !== null
              ? [binding.sessionId]
              : [],
          )
          .join("\n"),
  );
  const runtimes = useEnvironmentQuery(
    computeEnvironment.runtimes({
      environmentId: input.environmentId,
      input: { cwd: input.cwd, refresh: false },
    }),
  );
  const sessions = useEnvironmentQuery(
    computeEnvironment.sessions({ environmentId: input.environmentId, input: { cwd: input.cwd } }),
  );
  const events = useEnvironmentQuery(
    computeEnvironment.events({ environmentId: input.environmentId, input: { cwd: input.cwd } }),
  );
  const boundSessionId = contextBinding?.sessionId ?? null;
  const exactSession = useEnvironmentQuery(
    boundSessionId === null
      ? null
      : computeEnvironment.session({
          environmentId: input.environmentId,
          input: { cwd: input.cwd, sessionId: boundSessionId },
        }),
  );

  const allSessions = mergeComputeSessionRecords(
    sessions.data ?? [],
    exactSession.data === null ? [] : [exactSession.data],
    events.data?.sessions.values() ?? [],
  ).toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.sessionId.localeCompare(left.sessionId),
  );
  const contextSessions =
    input.contextId === undefined
      ? allSessions
      : allSessions.filter((session) => session.sessionId === boundSessionId);
  const freshSessions = allSessions.filter((session) =>
    freshSessionIds.split("\n").includes(session.sessionId),
  );
  const ownedSession = contextSessions[0];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the owned session in the compute-context store registry when the session binding changes
  useEffect(() => {
    if (input.contextId !== undefined && ownedSession !== undefined) {
      useComputeContextStore.getState().observeSession(input.contextId, ownedSession);
    }
  }, [input.contextId, ownedSession]);

  const chosenSession = contextSessions.find((session) => session.sessionId === chosenSessionId);
  const liveSession =
    chosenSession !== undefined && !TERMINAL_COMPUTE_SESSION_STATUSES.has(chosenSession.status)
      ? chosenSession
      : (contextSessions.find(
          (session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
        ) ?? null);
  const selectedSession = chosenSession ?? liveSession ?? contextSessions[0] ?? null;
  const selectedIsLive =
    liveSession !== null && selectedSession?.sessionId === liveSession.sessionId;

  const executionsQuery = useEnvironmentQuery(
    selectedSession === null
      ? null
      : computeEnvironment.executions({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            sessionId: selectedSession.sessionId,
            limit: FEED_EXECUTION_LIMIT,
          },
        }),
  );
  const executions = (() => {
    if (selectedSession === null) return [];
    const byId = new Map<string, ComputeExecutionRecord>();
    for (const execution of executionsQuery.data ?? []) {
      byId.set(execution.request.executionId, execution);
    }
    for (const execution of events.data?.executions.get(selectedSession.sessionId)?.values() ??
      []) {
      byId.set(execution.request.executionId, execution);
    }
    return [...byId.values()].filter(
      (execution) =>
        input.sourcePath === undefined ||
        (execution.request.source._tag === "document" &&
          execution.request.source.path === input.sourcePath),
    );
  })();

  const refresh = useStableCallback(() => {
    sessions.refresh();
    executionsQuery.refresh();
    events.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes session, execution, and event queries when the events subscription reports staleness
  useEffect(() => {
    if (events.data?.stale) refresh();
  }, [events.data?.stale, refresh]);

  const observedTerminalRef = useRef<Set<string> | null>(null);
  const terminalKey = executions
    .flatMap((execution) =>
      execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
        ? [execution.request.executionId]
        : [],
    )
    .join("\n");
  const observeTerminal = useStableCallback((key: string) => {
    const terminal = new Set(key === "" ? [] : key.split("\n"));
    const observed = observedTerminalRef.current;
    observedTerminalRef.current = terminal;
    if (observed === null || [...terminal].every((id) => observed.has(id))) return;
    sessions.refresh();
    executionsQuery.refresh();
    refreshProjectFiles(input.environmentId, input.cwd);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes durable history and the workspace tree once after a run newly settles
  useEffect(() => {
    observeTerminal(terminalKey);
  }, [terminalKey, observeTerminal]);

  const rehydrationToken = events.data?.observedGap
    ? `${events.data.observedGap.expected}:${events.data.observedGap.received}`
    : null;

  return {
    runtimes,
    sessions,
    events,
    contextBinding,
    allSessions,
    contextSessions,
    freshSessions,
    liveSession,
    selectedSession,
    selectedIsLive,
    chooseSession: setChosenSessionId,
    executions,
    historyPending: sessions.isPending || exactSession.isPending || executionsQuery.isPending,
    rehydrationToken,
    refresh,
    refreshExecutions: executionsQuery.refresh,
  };
}

export type ComputePanelSessions = ReturnType<typeof useComputePanelSessions>;
