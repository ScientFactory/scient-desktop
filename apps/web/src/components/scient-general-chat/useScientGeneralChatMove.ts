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
import { GENERAL_CHAT_MOVE_SESSION_STOP_PENDING } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

const STOP_RECONCILIATION_ATTEMPTS = 34;
const STOP_RECONCILIATION_DELAY_MS = 150;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function isGeneralChatMoveWaitingForSessionStop(cause: unknown): boolean {
  return errorMessage(cause).includes(GENERAL_CHAT_MOVE_SESSION_STOP_PENDING);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Moves the existing conversation after its provider session reaches a real
 * stopped boundary. The server remains authoritative; retries only bridge the
 * short reactor/projection delay after the stop request is accepted.
 */
export function useScientGeneralChatMove(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
}) {
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [isMoving, setIsMoving] = useState(false);
  const operationRef = useRef(0);

  const moveToProject = useCallback(
    async (projectId: ProjectId) => {
      if (isMoving || input.environmentId === null || input.threadId === null) return;
      const environmentId = input.environmentId;
      const threadId = input.threadId;
      const operation = ++operationRef.current;
      setIsMoving(true);
      try {
        if (input.sessionStatus !== null && input.sessionStatus !== "stopped") {
          const stopped = await stopSession({
            environmentId,
            input: { threadId },
          });
          if (stopped._tag === "Failure") {
            if (isAtomCommandInterrupted(stopped)) return;
            throw squashAtomCommandFailure(stopped);
          }
        }

        for (let attempt = 0; attempt < STOP_RECONCILIATION_ATTEMPTS; attempt += 1) {
          const moved = await updateMetadata({
            environmentId,
            input: { threadId, moveToProjectId: projectId },
          });
          if (moved._tag === "Success") {
            toastManager.add({ type: "success", title: "Chat moved to project" });
            return;
          }
          if (isAtomCommandInterrupted(moved)) return;
          const failure = squashAtomCommandFailure(moved);
          if (
            !isGeneralChatMoveWaitingForSessionStop(failure) ||
            attempt === STOP_RECONCILIATION_ATTEMPTS - 1
          ) {
            throw failure;
          }
          await delay(STOP_RECONCILIATION_DELAY_MS);
        }
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not move chat",
          description: errorMessage(cause),
        });
      } finally {
        if (operationRef.current === operation) setIsMoving(false);
      }
    },
    [
      input.environmentId,
      input.sessionStatus,
      input.threadId,
      isMoving,
      stopSession,
      updateMetadata,
    ],
  );

  return { isMoving, moveToProject } as const;
}
