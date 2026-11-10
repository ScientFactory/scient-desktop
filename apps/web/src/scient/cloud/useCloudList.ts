import { useEffect, useEffectEvent, useState } from "react";

/** A list read from Scient Cloud when shown; `reload` reads it again after a change. */
export function useCloudList<T>(load: () => Promise<ReadonlyArray<T>>, key: string) {
  const [items, setItems] = useState<ReadonlyArray<T> | null>(null);
  const [tick, setTick] = useState(0);
  const read = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from Scient Cloud over the network
  useEffect(() => {
    let cancelled = false;
    read().then(
      (next) => {
        if (!cancelled) setItems(next);
      },
      () => {
        if (!cancelled) setItems(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reload` bumps `tick` to read the list again.
  }, [key, tick]);
  return { items, reload: () => setTick((value) => value + 1) };
}
