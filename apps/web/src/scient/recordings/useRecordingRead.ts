import { useEffect, useEffectEvent, useState } from "react";

type ReadState<T> = { key: string; refresh: number; data?: T; isError: boolean };

export function useRecordingRead<T>(
  key: string,
  read: (signal: AbortSignal) => Promise<T>,
  interval?: number,
  refresh = 0,
) {
  const [state, setState] = useState<ReadState<T>>();
  const readCurrent = useEffectEvent(read);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the mounted request and polling timer.
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchNext = async () => {
      try {
        const data = await readCurrent(controller.signal);
        if (!controller.signal.aborted) setState({ key, refresh, data, isError: false });
      } catch {
        if (!controller.signal.aborted) {
          setState((current) => ({
            ...(current?.key === key ? current : undefined),
            key,
            refresh,
            isError: true,
          }));
        }
      }
      if (!controller.signal.aborted && interval !== undefined)
        timer = setTimeout(fetchNext, interval);
    };
    void fetchNext();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, interval, refresh]);
  return state?.key === key ? state : { data: undefined, isError: false };
}
