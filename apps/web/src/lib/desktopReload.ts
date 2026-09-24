import { useEffect, useLayoutEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import {
  usePendingSurfaceDeparture,
  type PendingSurfaceDepartureOptions,
} from "~/scient/fileSurfaces/usePendingSurfaceDeparture";

let beforeReload: ((reload: () => void) => void) | null = null;

/** The chat surface owns pending-file truth while mounted; other routes reload directly. */
export function requestDesktopReload(ignoreCache: boolean): void {
  const reload = () => {
    const nativeReload = window.desktopBridge?.reloadMainWindow;
    if (!nativeReload) {
      window.location.reload();
      return;
    }
    void nativeReload(ignoreCache)
      .then((accepted) => {
        if (!accepted) {
          toastManager.add({ type: "warning", title: "Could not reload the app window" });
        }
      })
      .catch((error: unknown) => {
        console.error("Could not reload the app window.", error);
        toastManager.add({ type: "error", title: "Could not reload the app window" });
      });
  };
  if (beforeReload) beforeReload(reload);
  else reload();
}

/** Reuses the same save barrier that protects file and route departure. */
export function useDesktopReloadGuard(
  pendingSurfaceIds: ReadonlySet<string>,
  options: PendingSurfaceDepartureOptions,
  describeAttention: (id: string) => string | undefined,
): void {
  const currentRef = useRef({ pendingSurfaceIds, options });
  useLayoutEffect(() => {
    currentRef.current = { pendingSurfaceIds, options };
  }, [pendingSurfaceIds, options]);
  const runAfterPendingSave = usePendingSurfaceDeparture(pendingSurfaceIds, {
    ...options,
    onAttention: (id) => {
      options.onAttention?.(id);
      toastManager.add({
        type: "warning",
        title: "Reload paused",
        description:
          describeAttention(id) ??
          "A file needs attention before Scient can reload. Resolve its save notice, then try again.",
      });
    },
  });

  useEffect(() => {
    const handler = (reload: () => void) => {
      const finish = () => {
        const { pendingSurfaceIds, options } = currentRef.current;
        const pending = options.getPendingSurfaceIds?.() ?? pendingSurfaceIds;
        if (pending.size > 0) {
          runAfterPendingSave([...pending], finish);
        } else {
          reload();
        }
      };
      finish();
    };
    beforeReload = handler;
    return () => {
      if (beforeReload === handler) beforeReload = null;
    };
  }, [runAfterPendingSave]);
}
