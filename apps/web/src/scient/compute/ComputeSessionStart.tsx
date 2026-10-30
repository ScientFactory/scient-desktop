import {
  ComputeSessionId,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeSessionRecord,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { useComputeConsoleStore } from "./computeConsoleStore";
import { stopComputeContext } from "./computeContextCoordinator";
import {
  computeSessionOwnerLabel,
  ensureComputeContext,
  getComputeContext,
  INITIAL_COMPUTE_CONTEXT_GENERATION,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";
import {
  computeConsoleRuntime,
  defaultComputeRuntime,
  isComputeCapacityReachedError,
  type ComputeReadyRuntime,
} from "./computeFileSurfaceModel";
import { reportComputeFailure } from "./ComputeSessionControls";
import type { ComputePanelSessions } from "./useComputePanelSessions";

/** Starts the session an extra Compute tab owns, including capacity recovery. */
export function useComputeSessionStart(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly contextId: ComputeContextId | undefined;
  readonly model: ComputePanelSessions;
}) {
  const { runtimes, contextBinding, allSessions, selectedSession } = input.model;
  const { contextId } = input;
  const runtimeKey = useComputeConsoleStore((state) =>
    contextId === undefined ? "" : (state.runtimes[contextId] ?? ""),
  );
  const [starting, setStarting] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [capacityBlocked, setCapacityBlocked] = useState(false);
  const [stopping, setStopping] = useState<ComputeSessionId | null>(null);
  const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
  const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });
  const getSession = useAtomQueryRunner(computeEnvironment.session, {
    reportFailure: false,
    refresh: true,
  });

  const languages = runtimes.data?.languages ?? [];
  const readyRuntimes: ReadonlyArray<ComputeReadyRuntime> = languages.flatMap((language) =>
    language.runtimes.flatMap((candidate) =>
      language.enabled && candidate.verification.readiness === "ready"
        ? [
            {
              language,
              candidate,
              key: `${language.descriptor.languageId}:${candidate.profile.executable}`,
            },
          ]
        : [],
    ),
  );
  const selectedRuntime = computeConsoleRuntime({
    ready: readyRuntimes,
    session: selectedSession,
    chosenKey: runtimeKey,
    defaultRuntime: defaultComputeRuntime(languages),
  });
  const canRetry = retryAvailable || (contextBinding?.lifecycle === "starting" && !starting);
  const capacitySessions = allSessions.filter(
    (session) =>
      !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status) &&
      session.sessionId !== contextBinding?.sessionId,
  );

  const confirmFailedStart = async (
    sessionId: ComputeSessionId,
    generation: ComputeSessionRecord["generation"],
  ) => {
    if (input.contextId === undefined) return;
    try {
      const observed = await getSession({
        environmentId: input.environmentId,
        input: { cwd: input.cwd, sessionId },
      });
      if (
        observed._tag !== "Success" ||
        observed.value?.sessionId !== sessionId ||
        observed.value.generation !== generation ||
        !TERMINAL_COMPUTE_SESSION_STATUSES.has(observed.value.status)
      ) {
        return;
      }
      useComputeContextStore
        .getState()
        .markSessionTerminal({ contextId: input.contextId, sessionId, generation });
    } catch {
      // A rejected read is not proof that the independent server startup stopped.
    }
  };

  const start = async (): Promise<ComputeSessionRecord | null> => {
    if (selectedRuntime === null) return null;
    const context =
      input.contextId === undefined
        ? null
        : (getComputeContext(input.contextId) ??
          ensureComputeContext({
            contextId: input.contextId,
            environmentId: input.environmentId,
            cwd: input.cwd,
            ownerKey: `${input.environmentId}:${input.cwd}:${input.contextId}`,
          }));
    if (
      (context?.lifecycle === "starting" && !capacityBlocked && !canRetry) ||
      context?.lifecycle === "live" ||
      context?.lifecycle === "closing" ||
      context?.lifecycle === "close-failed"
    ) {
      return null;
    }
    const fresh = context?.lifecycle === "terminal" || context?.sessionId === null;
    const sessionId = fresh
      ? ComputeSessionId.make(randomUUID())
      : (context?.sessionId ?? ComputeSessionId.make(randomUUID()));
    const generation = fresh
      ? INITIAL_COMPUTE_CONTEXT_GENERATION
      : (context?.generation ?? INITIAL_COMPUTE_CONTEXT_GENERATION);
    if (
      input.contextId !== undefined &&
      !useComputeContextStore
        .getState()
        .reserveSession({ contextId: input.contextId, sessionId, generation })
    ) {
      return null;
    }
    setRetryAvailable(false);
    setStarting(true);
    const result = await startSession({
      environmentId: input.environmentId,
      input: {
        cwd: input.cwd,
        sessionId,
        languageId: selectedRuntime.language.descriptor.languageId,
        executable:
          runtimeKey === "" && selectedSession === null
            ? null
            : selectedRuntime.candidate.profile.executable,
      },
    });
    setStarting(false);
    if (result._tag === "Success") {
      setCapacityBlocked(false);
      if (
        input.contextId !== undefined &&
        !useComputeContextStore.getState().bindSession({
          contextId: input.contextId,
          sessionId: result.value.sessionId,
          generation: result.value.generation,
        })
      ) {
        const current = getComputeContext(input.contextId);
        if (
          current?.sessionId === result.value.sessionId &&
          (current.lifecycle === "closing" || current.lifecycle === "close-failed")
        ) {
          void stopComputeContext({ contextId: input.contextId, stopSession, getSession });
        }
        return null;
      }
      input.model.chooseSession(result.value.sessionId);
      input.model.sessions.refresh();
      return result.value;
    }
    const capacityRejected = isComputeCapacityReachedError(squashAtomCommandFailure(result));
    setRetryAvailable(!capacityRejected);
    setCapacityBlocked(capacityRejected);
    if (capacityRejected && input.contextId !== undefined) {
      useComputeContextStore
        .getState()
        .releasePendingReservation({ contextId: input.contextId, sessionId, generation });
    } else {
      void confirmFailedStart(sessionId, generation);
    }
    if (!isAtomCommandInterrupted(result)) {
      reportComputeFailure("Unable to start compute", result);
      runtimes.refresh();
      input.model.sessions.refresh();
    }
    return null;
  };

  const stopUnused = async (session: ComputeSessionRecord) => {
    if (stopping !== null) return;
    setStopping(session.sessionId);
    const result = await stopSession({
      environmentId: input.environmentId,
      input: {
        cwd: input.cwd,
        sessionId: session.sessionId,
        expectedGeneration: session.generation,
      },
    }).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: `Unable to stop ${session.label}`,
        description: error instanceof Error ? error.message : "The stop request failed.",
      });
      return null;
    });
    setStopping(null);
    if (result === null) return;
    if (result._tag === "Success") {
      for (const binding of Object.values(useComputeContextStore.getState().bindings)) {
        if (
          binding.environmentId === input.environmentId &&
          binding.cwd === input.cwd &&
          binding.sessionId === session.sessionId &&
          binding.generation === session.generation
        ) {
          useComputeContextStore.getState().markSessionTerminal({
            contextId: binding.contextId,
            sessionId: result.value.sessionId,
            generation: result.value.generation,
          });
        }
      }
      input.model.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result))
      reportComputeFailure(`Unable to stop ${session.label}`, result);
  };

  return {
    readyRuntimes,
    selectedRuntime,
    selectRuntime: (runtimeKey: string) => {
      if (contextId !== undefined) {
        useComputeConsoleStore.getState().chooseRuntime(contextId, runtimeKey);
      }
    },
    start,
    starting,
    canRetry,
    capacityBlocked,
    capacitySessions,
    stopping,
    stopUnused: (session: ComputeSessionRecord) => void stopUnused(session),
    disabled:
      starting ||
      selectedRuntime === null ||
      stopping !== null ||
      (contextBinding?.lifecycle === "starting" && !capacityBlocked && !canRetry),
  };
}

export type ComputeSessionStartModel = ReturnType<typeof useComputeSessionStart>;

/** Host capacity is shared; offers to stop another session in this project. */
export function ComputeCapacityMenu(props: {
  readonly start: ComputeSessionStartModel;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  if (!props.start.capacityBlocked) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost-muted" disabled={props.start.stopping !== null} />}
      >
        <span className="font-normal text-warning">Stop a session…</span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-64">
        {props.start.capacitySessions.length === 0 ? (
          <MenuItem disabled>No running sessions in this project</MenuItem>
        ) : (
          props.start.capacitySessions.map((session) => (
            <MenuItem
              key={`${session.sessionId}:${session.generation}`}
              disabled={props.start.stopping !== null}
              onClick={() => props.start.stopUnused(session)}
            >
              Stop {computeSessionOwnerLabel(session, props.environmentId, props.cwd)}
            </MenuItem>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}
