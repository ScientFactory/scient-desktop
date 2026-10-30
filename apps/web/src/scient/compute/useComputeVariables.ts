import { useStableCallback } from "~/hooks/useStableCallback";
import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeSessionRecord,
  type ComputeVariableSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";

import type { ComputePanelSessions } from "./useComputePanelSessions";

interface VariableState {
  readonly owner: string;
  readonly snapshot: ComputeVariableSnapshot | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** Reads the live namespace while Variables is showing; results belong to one session generation. */
export function useComputeVariables(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly visible: boolean;
  readonly model: ComputePanelSessions;
}) {
  const { liveSession, selectedIsLive, events, runtimes } = input.model;
  const inspectVariables = useAtomCommand(computeEnvironment.inspectVariables, {
    reportFailure: false,
  });
  const owner = liveSession === null ? "" : `${liveSession.sessionId}:${liveSession.generation}`;
  const [state, setState] = useState<VariableState>({
    owner,
    snapshot: null,
    error: null,
    loading: false,
  });
  const current = state.owner === owner ? state : { owner, snapshot: null, error: null, loading: false };
  const request = useRef<symbol | null>(null);
  const available =
    liveSession !== null &&
    (runtimes.data?.languages
      .find((language) => language.descriptor.languageId === liveSession.languageId)
      ?.descriptor.capabilities.includes("variables") ??
      false);

  const refresh = useStableCallback(async () => {
    const session: ComputeSessionRecord | null = liveSession;
    if (
      !input.visible ||
      session === null ||
      !selectedIsLive ||
      !available ||
      session.status !== "ready" ||
      session.activity !== "idle"
    ) {
      return;
    }
    const token = Symbol(owner);
    request.current = token;
    setState({ ...current, loading: true, error: null });
    const result = await inspectVariables({
      environmentId: input.environmentId,
      input: {
        cwd: input.cwd,
        sessionId: session.sessionId,
        expectedGeneration: session.generation,
      },
    });
    if (request.current !== token) return;
    if (result._tag === "Success") {
      setState({ owner, snapshot: result.value, error: null, loading: false });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState((previous) => ({ ...previous, loading: false }));
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState((previous) => ({
      ...previous,
      loading: false,
      error: error instanceof Error ? error.message : "Couldn't read variables.",
    }));
  });

  const latestTerminal = [...(events.data?.executions.get(liveSession?.sessionId ?? "")?.values() ?? [])]
    .filter(
      (execution) =>
        execution.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
    )
    .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt))
    .at(-1);
  const refreshToken = [
    owner,
    input.visible,
    liveSession?.status,
    liveSession?.activity,
    latestTerminal?.request.executionId ?? "",
    latestTerminal?.result?.finishedAt ?? "",
  ].join(":");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads kernel variables over the environment connection when the namespace may have changed
  useEffect(() => {
    void refresh();
  }, [refreshToken, refresh]);

  return {
    snapshot: current.snapshot,
    error: current.error,
    loading: current.loading,
    available,
    refresh: () => void refresh(),
  };
}
