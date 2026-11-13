import { useEffect, useEffectEvent, useState } from "react";

/** A list read from Scient Cloud when shown; `reload` reads it again after a change. */
export function useCloudList<T>(load: () => Promise<ReadonlyArray<T>>, key: string) {
  const [state, setState] = useState<{ key: string; items: ReadonlyArray<T> | null }>({
    key,
    items: null,
  });
  const [tick, setTick] = useState(0);
  const read = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from Scient Cloud over the network
  useEffect(() => {
    let cancelled = false;
    read().then(
      (next) => {
        if (!cancelled) setState({ key, items: next });
      },
      () => {
        if (!cancelled) setState({ key, items: null });
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reload` bumps `tick` to read the list again.
  }, [key, tick]);
  // Items read under another key (another account) are never shown.
  const items = state.key === key ? state.items : null;
  return { items, reload: () => setTick((value) => value + 1) };
}
