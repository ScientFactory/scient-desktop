import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { NewThreadNavigationIntent } from "../lib/newThreadNavigationIntent";

/** Picker-local ownership; the existing router intent still owns navigation. */
export function useProjectOpening(open: boolean, close: () => void) {
  const [pending, setPending] = useState(false);
  const active = useRef<{
    key: string;
    handedOff: boolean;
    intent: NewThreadNavigationIntent;
  } | null>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!active.current?.handedOff) active.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!open && !active.current?.handedOff) {
      active.current = null;
      setPending(false);
    }
  }, [open]);

  const run = useCallback(
    async (
      key: string,
      claim: () => NewThreadNavigationIntent,
      action: (attempt: {
        navigationIntent: NewThreadNavigationIntent;
        handoff: () => void;
      }) => Promise<void>,
      onError: (error: unknown) => void,
    ) => {
      if (!open || !mounted.current) return;
      if (active.current?.key === key && active.current.intent.isCurrent()) return;
      const attempt = { key, handedOff: false, intent: claim() };
      active.current = attempt;
      setPending(true);
      const isCurrent = () => active.current === attempt && attempt.intent.isCurrent();
      try {
        await action({
          navigationIntent: { isCurrent },
          handoff: () => {
            if (!isCurrent() || attempt.handedOff) return;
            // Close before awaiting navigation, but don't cancel our own handoff
            // when the dialog unmounts. Never close it again on async completion.
            attempt.handedOff = true;
            close();
          },
        });
      } catch (error) {
        if (active.current === attempt && (attempt.handedOff || isCurrent())) onError(error);
      } finally {
        if (active.current === attempt) {
          active.current = null;
          if (mounted.current) setPending(false);
        }
      }
    },
    [open, close],
  );
  return { pending, run };
}
