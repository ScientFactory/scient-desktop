import { useEffect, useRef } from "react";
import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";

/** Each changed deep-link target opens once, when its task becomes available. */
export function useScheduledTaskLink(
  targetId: ScheduledTaskId | undefined,
  availableId: ScheduledTaskId | undefined,
  onOpen: () => void,
  environmentId?: EnvironmentId,
) {
  const intent = useRef({ environmentId, targetId, opened: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the deep-linked task once when its target becomes available
  useEffect(() => {
    if (intent.current.targetId !== targetId || intent.current.environmentId !== environmentId) {
      intent.current = { environmentId, targetId, opened: false };
    }
    if (targetId !== undefined && availableId === targetId && !intent.current.opened) {
      intent.current.opened = true;
      onOpen();
    }
  }, [environmentId, targetId, availableId, onOpen]);
}
