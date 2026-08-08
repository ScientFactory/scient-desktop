import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForStartedServerThread } from "../ChatView.logic";

type ForkOrigin = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
};

type NavigateToThread = (input: {
  readonly to: "/$environmentId/$threadId";
  readonly params: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
}) => Promise<void>;

function userFacingForkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("no ready Git checkpoint")) {
    return "This response has no saved Git checkpoint for a separate worktree. Choose Same workspace or fork from a checkpointed response.";
  }
  if (
    message.includes("not a completed conversation boundary") ||
    message.includes("not a terminal completed response")
  ) {
    return "This response is no longer available as a fork point. Choose another completed response.";
  }
  return "Failed to fork this conversation.";
}

export function useScientThreadFork({
  origin,
  navigate,
}: {
  readonly origin: ForkOrigin | null;
  readonly navigate: NavigateToThread;
}) {
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const [isForking, setIsForking] = useState(false);
  const [errorUpdate, setErrorUpdate] = useState<{
    readonly threadId: ThreadId;
    readonly message: string | null;
  } | null>(null);
  const inFlightRef = useRef(false);

  const forkFromAssistantMessage = useCallback(
    async (sourceAssistantMessageId: MessageId, workspaceMode: "new-worktree" | "local") => {
      if (!origin || inFlightRef.current) return;
      const forkThreadId = newThreadId();
      inFlightRef.current = true;
      setIsForking(true);
      setErrorUpdate({ threadId: origin.id, message: null });
      try {
        const result = await forkThread({
          environmentId: origin.environmentId,
          input: {
            originThreadId: origin.id,
            newThreadId: forkThreadId,
            sourceAssistantMessageId,
            workspaceMode,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setErrorUpdate({
              threadId: origin.id,
              message: userFacingForkError(error),
            });
          }
          return;
        }
        const forkVisible = await waitForStartedServerThread(
          scopeThreadRef(origin.environmentId, forkThreadId),
          5_000,
        );
        if (!forkVisible) {
          setErrorUpdate({
            threadId: origin.id,
            message:
              "The fork was created, but it is not available in the app yet. Open it from the sidebar or try again.",
          });
          return;
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: origin.environmentId, threadId: forkThreadId },
        });
      } catch (cause) {
        setErrorUpdate({
          threadId: origin.id,
          message: userFacingForkError(cause),
        });
      } finally {
        inFlightRef.current = false;
        setIsForking(false);
      }
    },
    [forkThread, navigate, origin],
  );

  return { errorUpdate, isForking, forkFromAssistantMessage } as const;
}
