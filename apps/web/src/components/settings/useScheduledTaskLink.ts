import { useEffect, useRef } from "react";
import type { ScheduledTaskId } from "@t3tools/contracts";

/** Each changed deep-link target opens once, when its task becomes available. */
export function useScheduledTaskLink(
  targetId: ScheduledTaskId | undefined,
  availableId: ScheduledTaskId | undefined,
  onOpen: () => void,
) {
  const intent = useRef({ targetId, opened: false });
  useEffect(() => {
    if (intent.current.targetId !== targetId) intent.current = { targetId, opened: false };
    if (targetId !== undefined && availableId === targetId && !intent.current.opened) {
      intent.current.opened = true;
      onOpen();
    }
  }, [targetId, availableId, onOpen]);
}
