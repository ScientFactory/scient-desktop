import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export const SCIENT_QUICK_CHAT_DEFAULT_EXPANDED = false;
// Retain the shipped key so the product rename does not reset the user's disclosure preference.
export const SCIENT_QUICK_CHAT_EXPANDED_STORAGE_KEY = "scient:sidebar:general-chat-expanded";

export function shouldRevealScientQuickChat(input: {
  readonly previousActiveKey: string | null;
  readonly activeKey: string | null;
}): boolean {
  return input.activeKey !== null && input.activeKey !== input.previousActiveKey;
}

/** Persists disclosure preference and reveals a newly active Quick Chat once. */
export function useScientQuickChatDisclosure(activeKey: string | null) {
  const [expanded, setExpanded] = useLocalStorage(
    SCIENT_QUICK_CHAT_EXPANDED_STORAGE_KEY,
    SCIENT_QUICK_CHAT_DEFAULT_EXPANDED,
    Schema.Boolean,
  );
  const previousActiveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      shouldRevealScientQuickChat({
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
