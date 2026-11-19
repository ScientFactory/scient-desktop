import { useEffect, useSyncExternalStore } from "react";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

const startPages = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const changed = () => {
  for (const listener of listeners) listener();
};

/** Marks the tab as shown in this window while its start page is on screen here. */
export function useShowPreviewStartPage(runtimeTabId: string | null) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells this window's host claim, outside React, that the tab shows here
  useEffect(() => {
    if (runtimeTabId === null) return;
    startPages.set(runtimeTabId, (startPages.get(runtimeTabId) ?? 0) + 1);
    changed();
    return () => {
      const left = (startPages.get(runtimeTabId) ?? 1) - 1;
      if (left > 0) startPages.set(runtimeTabId, left);
      else startPages.delete(runtimeTabId);
      changed();
    };
  }, [runtimeTabId]);
}

/**
 * Whether this window shows the tab: its page, or its start page. A start page counts so the
 * window hosts the tab before its first address; taking it over then would cancel that load.
 */
export function usePreviewTabShownHere(runtimeTabId: string) {
  const page = useBrowserSurfaceStore((state) => {
    const presentation = state.byTabId[runtimeTabId];
    return presentation?.visible === true && presentation.rect !== null;
  });
  const startPage = useSyncExternalStore(subscribe, () => startPages.has(runtimeTabId));
  return page || startPage;
}
