import { useEffect, useState } from "react";
import { afterChatInputQuiet } from "./inputPriority";

export function useChatPriorityPanelOpen(
  requested: boolean,
  scope: string | null,
  defer: boolean,
): boolean {
  const [released, setReleased] = useState({ scope, requested, defer, open: requested && !defer });
  if (released.scope !== scope || released.requested !== requested || released.defer !== defer) {
    const alreadyOpen = released.scope === scope && released.requested && released.open;
    setReleased({ scope, requested, defer, open: requested && (!defer || alreadyOpen) });
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes panel presentation with input activity while leaving requested state authoritative
  useEffect(() => {
    if (!requested || !defer) return;
    return afterChatInputQuiet(() =>
      setReleased((current) =>
        current.scope === scope && current.requested && current.defer
          ? { ...current, open: true }
          : current,
      ),
    );
  }, [requested, scope, defer]);
  return requested && (!defer || (released.scope === scope && released.open));
}
