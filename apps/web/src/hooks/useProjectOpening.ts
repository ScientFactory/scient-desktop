import { useLayoutEffect, useRef, useState } from "react";
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mounted state and drops an un-handed-off attempt ref on unmount
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!active.current?.handedOff) active.current = null;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending attempt when the picker closes without a navigation handoff
  useLayoutEffect(() => {
    if (!open && !active.current?.handedOff) {
      active.current = null;
      setPending(false);
    }
  }, [open]);

  const run = async (
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
    let operationFailure: { error: unknown } | null = null;
    try {
      {
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
        }
      }
    } catch (error) {
      operationFailure = { error };
    }

    if (active.current === attempt) {
      active.current = null;
      if (mounted.current) setPending(false);
    }

    if (operationFailure !== null) throw operationFailure.error;
  };
  return { pending, run };
}
