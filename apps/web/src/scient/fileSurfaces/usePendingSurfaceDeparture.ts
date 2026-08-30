import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";

export function pendingSurfaceBlocksActivation(input: {
  readonly activeSurfaceId: string | null;
  readonly targetSurfaceId: string;
  readonly pendingSurfaceIds: ReadonlySet<string>;
}): boolean {
  return (
    input.activeSurfaceId !== null &&
    input.activeSurfaceId !== input.targetSurfaceId &&
    input.pendingSurfaceIds.has(input.activeSurfaceId)
  );
}

export function pendingSurfaceBlocksClose(
  surfaceIds: ReadonlyArray<string>,
  pendingSurfaceIds: ReadonlySet<string>,
): boolean {
  return surfaceIds.some((surfaceId) => pendingSurfaceIds.has(surfaceId));
}

interface PendingSurfaceDeparture {
  readonly surfaceIds: ReadonlyArray<string>;
  readonly run: () => void;
}

/**
 * Defers the latest requested action until every affected file surface has
 * confirmed its serial save. A failed or conflicted save stays pending, so the
 * action resumes only after the visible recovery flow succeeds or discards it.
 */
export function usePendingSurfaceDeparture(pendingSurfaceIds: ReadonlySet<string>) {
  const departureRef = useRef<PendingSurfaceDeparture | null>(null);
  const pendingSurfaceIdsRef = useRef(pendingSurfaceIds);
  pendingSurfaceIdsRef.current = pendingSurfaceIds;

  const runAfterPendingSave = useCallback((surfaceIds: ReadonlyArray<string>, run: () => void) => {
    if (!pendingSurfaceBlocksClose(surfaceIds, pendingSurfaceIdsRef.current)) {
      departureRef.current = null;
      run();
      return true;
    }
    departureRef.current = { surfaceIds: [...surfaceIds], run };
    toastManager.add({
      type: "warning",
      title: "Finishing the file save",
      description:
        "Scient will continue automatically when the file is safely saved. Resolve the file notice if saving cannot finish.",
    });
    return false;
  }, []);

  useEffect(() => {
    const departure = departureRef.current;
    if (departure === null || pendingSurfaceBlocksClose(departure.surfaceIds, pendingSurfaceIds)) {
      return;
    }
    departureRef.current = null;
    departure.run();
  }, [pendingSurfaceIds]);

  return runAfterPendingSave;
}

/**
 * Adapts the generic departure lane to a tab-style surface switch. Keeping the
 * policy here leaves the inherited chat shell responsible only for composition.
 */
export function useActivePendingSurfaceDeparture(input: {
  readonly activeSurfaceId: string | null;
  readonly pendingSurfaceIds: ReadonlySet<string>;
}) {
  const runAfterPendingSave = usePendingSurfaceDeparture(input.pendingSurfaceIds);
  const inputRef = useRef(input);
  inputRef.current = input;
  return useCallback(
    (targetSurfaceId: string | null, run: () => void) => {
      const input = inputRef.current;
      const blockedSurfaceIds =
        targetSurfaceId === null
          ? input.activeSurfaceId !== null && input.pendingSurfaceIds.has(input.activeSurfaceId)
            ? [input.activeSurfaceId]
            : []
          : pendingSurfaceBlocksActivation({
                activeSurfaceId: input.activeSurfaceId,
                targetSurfaceId,
                pendingSurfaceIds: input.pendingSurfaceIds,
              })
            ? [input.activeSurfaceId!]
            : [];
      return runAfterPendingSave(blockedSurfaceIds, run);
    },
    [runAfterPendingSave],
  );
}

/** Holds route and window departure while any file surface still owns local bytes. */
export function usePendingSurfaceNavigationBlocker(pendingSurfaceIds: ReadonlySet<string>): void {
  const notifiedRef = useRef(false);
  const navigation = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      pendingSurfaceIds.size > 0 && current.pathname !== next.pathname,
    enableBeforeUnload: () => pendingSurfaceIds.size > 0,
    withResolver: true,
  });

  useEffect(() => {
    if (navigation.status !== "blocked") {
      notifiedRef.current = false;
      return;
    }
    if (pendingSurfaceIds.size === 0) {
      notifiedRef.current = false;
      navigation.proceed();
      return;
    }
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    toastManager.add({
      type: "warning",
      title: "Finishing the file save",
      description:
        "Scient will open the next page automatically when the file is safely saved. Resolve the file notice if saving cannot finish.",
    });
  }, [navigation, pendingSurfaceIds]);
}
