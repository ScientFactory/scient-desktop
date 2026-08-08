import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useRef, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

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
              message: error instanceof Error ? error.message : "Failed to fork thread.",
            });
          }
          return;
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: origin.environmentId, threadId: forkThreadId },
        });
      } catch (cause) {
        setErrorUpdate({
          threadId: origin.id,
          message: cause instanceof Error ? cause.message : "Failed to open the forked thread.",
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
