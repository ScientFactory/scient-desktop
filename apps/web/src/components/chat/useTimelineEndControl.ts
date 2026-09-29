import { Debouncer } from "@tanstack/react-pacer";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { endTransition } from "./readerScrollPolicy";

/** How long the reader must stay away from the end before the Scroll to end control shows. */
export const END_CONTROL_SHOW_DELAY_MS = 150;

/**
 * The Scroll to end control and its unread count. Only transitions across
 * the end count: scroll and size events repeat while the reader stays put,
 * and must neither restart the control's delay nor reopen a composer the
 * reader collapsed. Showing is debounced so the control doesn't flash during
 * thread switches; hiding is immediate.
 */
export function useTimelineEndControl({
  isAtEndRef,
  onReachedEnd,
}: {
  /** Whether the reader is at the end; shared with the timeline's other readers. */
  isAtEndRef: RefObject<boolean>;
  /** Runs once each time the reader arrives at the end. */
  onReachedEnd: () => void;
}) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  const onReachedEndRef = useRef(onReachedEnd);
  useLayoutEffect(() => {
    onReachedEndRef.current = onReachedEnd;
  });
  const showDebouncer = useRef<Debouncer<() => void> | null>(null);
  showDebouncer.current ??= new Debouncer(() => setShowScrollToBottom(true), {
    wait: END_CONTROL_SHOW_DELAY_MS,
  });

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      const transition = endTransition(isAtEndRef.current, isAtEnd);
      if (transition === null) return;
      isAtEndRef.current = isAtEnd;
      if (transition === "reached") {
        onReachedEndRef.current();
        showDebouncer.current?.cancel();
        setShowScrollToBottom(false);
        setUnreadBelowCount(0);
      } else {
        showDebouncer.current?.maybeExecute();
      }
    },
    [isAtEndRef],
  );

  /** A thread returned to mid-history shows the control right away. */
  const resetForThread = useCallback(
    (savedAtEnd: boolean) => {
      isAtEndRef.current = savedAtEnd;
      showDebouncer.current?.cancel();
      setShowScrollToBottom(!savedAtEnd);
      setUnreadBelowCount(0);
    },
    [isAtEndRef],
  );

  return {
    showScrollToBottom,
    unreadBelowCount,
    setUnreadBelowCount,
    onIsAtEndChange,
    resetForThread,
  };
}
