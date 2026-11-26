import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

/** The threads of `environmentId` whose agent is working now. */
function workingThreads(environmentId: EnvironmentId): ReadonlySet<string> {
  const shells = appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom);
  return new Set(
    shells.flatMap((shell) =>
      shell.environmentId === environmentId && threadRuntimeIsActive(shell.runtime)
        ? [shell.id]
        : [],
    ),
  );
}

/**
 * Agents add and change papers during their turns, and the server sends no Library event: the
 * list is read again whenever a turn in this environment ends. Subscribed outside React, so the
 * panel renders only for the read.
 */
export function useRefreshAfterAgentTurns(environmentId: EnvironmentId, refresh: () => void) {
  const onTurnEnded = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the thread store, an external system, for turns that end
  useEffect(() => {
    let working = workingThreads(environmentId);
    return appAtomRegistry.subscribe(environmentThreadShells.quietThreadShellsAtom, () => {
      const next = workingThreads(environmentId);
      const ended = [...working].some((threadId) => !next.has(threadId));
      working = next;
      if (ended) onTurnEnded();
    });
  }, [environmentId]);
}
