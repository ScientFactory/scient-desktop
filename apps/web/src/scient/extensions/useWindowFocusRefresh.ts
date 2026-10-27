import { useEffect, useEffectEvent } from "react";

/**
 * Runs `refresh` whenever the window regains focus: sign-ins, installs and app connections finish
 * in the user's browser or the agent's own UI, and coming back is the only signal Scient gets.
 */
export function useWindowFocusRefresh(refresh: () => void): void {
  const onFocus = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/react-effect-budget -- A window listener is external state; returning from the browser is the only signal that a sign-in or install finished.
  useEffect(() => {
    const listener = () => onFocus();
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
  }, []);
}
