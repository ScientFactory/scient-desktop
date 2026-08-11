import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export const SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED = false;
export const SCIENT_GENERAL_CHAT_EXPANDED_STORAGE_KEY = "scient:sidebar:general-chat-expanded";

export function shouldRevealScientGeneralChat(input: {
  readonly previousActiveKey: string | null;
  readonly activeKey: string | null;
}): boolean {
  return input.activeKey !== null && input.activeKey !== input.previousActiveKey;
}

/** Persists disclosure preference and reveals a newly active General Chat once. */
export function useScientGeneralChatDisclosure(activeKey: string | null) {
  const [expanded, setExpanded] = useLocalStorage(
    SCIENT_GENERAL_CHAT_EXPANDED_STORAGE_KEY,
    SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED,
    Schema.Boolean,
  );
  const previousActiveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      shouldRevealScientGeneralChat({
        previousActiveKey: previousActiveKeyRef.current,
        activeKey,
      })
    ) {
      setExpanded(true);
    }
    previousActiveKeyRef.current = activeKey;
  }, [activeKey, setExpanded]);

  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  return { expanded, toggle } as const;
}
