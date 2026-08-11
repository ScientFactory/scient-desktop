import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationSessionStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  resolveScientGeneralChatMoveProgress,
  type ScientGeneralChatPendingMove,
} from "./moveState";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Moves the existing conversation after its provider session reaches a real
 * stopped boundary. Projection state drives every transition; no timer or
 * retry loop can race the provider reactor or report success early.
 */
export function useScientGeneralChatMove(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly currentProjectId: ProjectId | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly hasOpenTerminals: boolean;
  readonly onMoved: () => void;
}) {
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [pendingMove, setPendingMove] = useState<ScientGeneralChatPendingMove | null>(null);
  const operationRef = useRef(0);

  useEffect(() => {
    operationRef.current += 1;
    setPendingMove(null);
  }, [input.environmentId, input.threadId]);

  const submitMove = useCallback(
    async (projectId: ProjectId, operation: number) => {
      if (input.environmentId === null || input.threadId === null) return;
      setPendingMove({ projectId, phase: "moving" });
      const moved = await updateMetadata({
        environmentId: input.environmentId,
        input: { threadId: input.threadId, moveToProjectId: projectId },
      });
      if (operationRef.current !== operation) return;
      if (moved._tag === "Failure") {
        setPendingMove(null);
        if (isAtomCommandInterrupted(moved)) return;
        const failure = squashAtomCommandFailure(moved);
        toastManager.add({
          type: "error",
          title: "Could not move chat",
          description: errorMessage(failure),
        });
        return;
      }
      setPendingMove({ projectId, phase: "awaiting-projection" });
    },
    [input.environmentId, input.threadId, updateMetadata],
  );

  useEffect(() => {
    if (
      resolveScientGeneralChatMoveProgress({
        pendingMove,
        sessionStatus: input.sessionStatus,
        currentProjectId: input.currentProjectId,
      }) !== "submit-move" ||
      pendingMove === null
    ) {
      return;
    }
    void submitMove(pendingMove.projectId, operationRef.current);
  }, [input.currentProjectId, input.sessionStatus, pendingMove, submitMove]);

  useEffect(() => {
    if (
      resolveScientGeneralChatMoveProgress({
        pendingMove,
        sessionStatus: input.sessionStatus,
        currentProjectId: input.currentProjectId,
      }) !== "complete"
    ) {
      return;
    }
    input.onMoved();
    toastManager.add({ type: "success", title: "Chat moved to project" });
    setPendingMove(null);
  }, [input.currentProjectId, input.onMoved, input.sessionStatus, pendingMove]);

  const moveToProject = useCallback(
    async (projectId: ProjectId) => {
      if (pendingMove !== null || input.environmentId === null || input.threadId === null) return;
      if (input.hasOpenTerminals) {
        toastManager.add({
          type: "error",
          title: "Close terminals before moving",
          description: "Terminal sessions stay bound to their current workspace.",
        });
        return;
      }
      const environmentId = input.environmentId;
      const threadId = input.threadId;
      const operation = ++operationRef.current;
      try {
        if (input.sessionStatus !== null && input.sessionStatus !== "stopped") {
          setPendingMove({ projectId, phase: "stopping" });
          const stopped = await stopSession({
            environmentId,
            input: { threadId },
          });
          if (stopped._tag === "Failure") {
            setPendingMove(null);
            if (isAtomCommandInterrupted(stopped)) return;
            throw squashAtomCommandFailure(stopped);
          }
          return;
        }
        await submitMove(projectId, operation);
      } catch (cause) {
        setPendingMove(null);
        toastManager.add({
          type: "error",
          title: "Could not move chat",
          description: errorMessage(cause),
        });
      }
    },
    [
      input.environmentId,
      input.sessionStatus,
      input.threadId,
      input.hasOpenTerminals,
      pendingMove,
      stopSession,
      submitMove,
    ],
  );

  return { isMoving: pendingMove !== null, moveToProject } as const;
}
