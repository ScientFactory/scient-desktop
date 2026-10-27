import { useStableCallback } from "~/hooks/useStableCallback";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";

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

export interface PendingSurfaceDepartureOptions {
  readonly quietSurfaceIds?: ReadonlySet<string>;
  readonly attentionSurfaceIds?: ReadonlySet<string>;
  /** Read synchronous persistence truth before React has committed its snapshot. */
  readonly getPendingSurfaceIds?: () => ReadonlySet<string>;
  readonly getAttentionSurfaceIds?: () => ReadonlySet<string>;
  readonly onFlush?: (surfaceIds: ReadonlyArray<string>) => void;
  readonly onAttention?: (surfaceId: string) => void;
}

const EMPTY_OPTIONS: PendingSurfaceDepartureOptions = {};

/**
 * Defers the latest requested action until every affected file surface has
 * confirmed its serial save. A verified attention state cancels the request;
 * resolving a conflict later must not unexpectedly close or navigate away.
 */
export function usePendingSurfaceDeparture(
  pendingSurfaceIds: ReadonlySet<string>,
  options: PendingSurfaceDepartureOptions = EMPTY_OPTIONS,
) {
  const departureRef = useRef<PendingSurfaceDeparture | null>(null);
  const pendingSurfaceIdsRef = useRef(pendingSurfaceIds);
  const optionsRef = useRef(options);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    pendingSurfaceIdsRef.current = pendingSurfaceIds;
    optionsRef.current = options;
  }, [pendingSurfaceIds, options]);

  const clearNotice = useStableCallback(() => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
    if (noticeIdRef.current !== null) toastManager.close(noticeIdRef.current);
    noticeIdRef.current = null;
  });

  const settleDeparture = useStableCallback(
    (pendingSnapshot?: ReadonlySet<string>, attentionSnapshot?: ReadonlySet<string>) => {
      const pendingAtCall =
        pendingSnapshot === undefined ? pendingSurfaceIdsRef.current : pendingSnapshot;
      const attentionAtCall =
        attentionSnapshot === undefined
          ? optionsRef.current.attentionSurfaceIds
          : attentionSnapshot;
      const departure = departureRef.current;
      if (departure === null) return;
      const options = optionsRef.current;
      const pending = options.getPendingSurfaceIds?.() ?? pendingAtCall;
      const attention = options.getAttentionSurfaceIds?.() ?? attentionAtCall;
      // A clean refresh problem stays visible but owns no unpublished bytes.
      // Only attention on a still-pending file may cancel the requested action.
      const attentionId = departure.surfaceIds.find((id) => pending.has(id) && attention?.has(id));
      if (attentionId !== undefined) {
        departureRef.current = null;
        clearNotice();
        options.onAttention?.(attentionId);
        return;
      }
      if (pendingSurfaceBlocksClose(departure.surfaceIds, pending)) return;
      departureRef.current = null;
      clearNotice();
      departure.run();
    },
  );

  const runAfterPendingSave = useStableCallback(
    (surfaceIds: ReadonlyArray<string>, run: () => void) => {
      clearNotice();
      const options = optionsRef.current;
      const pending = options.getPendingSurfaceIds?.() ?? pendingSurfaceIdsRef.current;
      let departed = false;
      departureRef.current = {
        surfaceIds: [...surfaceIds],
        run: () => {
          departed = true;
          run();
        },
      };
      settleDeparture();
      if (departureRef.current === null) return departed;

      options.onFlush?.(surfaceIds);
      settleDeparture();
      if (departureRef.current === null) return departed;
      const quiet = surfaceIds
        .filter((id) => pending.has(id))
        .every((id) => options.quietSurfaceIds?.has(id));
      if (quiet) {
        noticeTimerRef.current = setTimeout(() => {
          noticeTimerRef.current = null;
          settleDeparture();
          if (departureRef.current === null) return;
          noticeIdRef.current = toastManager.add({
            type: "info",
            title: "Finishing your changes",
            description: "Scient will continue when your changes are on disk.",
          });
        }, 1_000);
      } else {
        noticeIdRef.current = toastManager.add({
          type: "warning",
          title: "Finishing the file save",
          description:
            "Scient will continue automatically when the file is safely saved. Resolve the file notice if saving cannot finish.",
        });
      }
      return false;
    },
  );

  useEffect(() => {
    settleDeparture(pendingSurfaceIds, options.attentionSurfaceIds);
  }, [pendingSurfaceIds, options.attentionSurfaceIds, settleDeparture]);

  useEffect(
    () => () => {
      departureRef.current = null;
      clearNotice();
    },
    [clearNotice],
  );

  return runAfterPendingSave;
}

/**
 * Adapts the generic departure lane to a tab-style surface switch. Keeping the
 * policy here leaves the inherited chat shell responsible only for composition.
 */
export function useActivePendingSurfaceDeparture(
  input: PendingSurfaceDepartureOptions & {
    readonly activeSurfaceId: string | null;
    readonly getActiveSurfaceId?: () => string | null;
    readonly pendingSurfaceIds: ReadonlySet<string>;
  },
) {
  const runAfterPendingSave = usePendingSurfaceDeparture(input.pendingSurfaceIds, input);
  const inputRef = useRef(input);
  useLayoutEffect(() => {
    inputRef.current = input;
  }, [input]);
  return useStableCallback((targetSurfaceId: string | null, run: () => void) => {
    const input = inputRef.current;
    const activeSurfaceId = input.getActiveSurfaceId
      ? input.getActiveSurfaceId()
      : input.activeSurfaceId;
    const pendingSurfaceIds = input.getPendingSurfaceIds?.() ?? input.pendingSurfaceIds;
    const blockedSurfaceIds =
      targetSurfaceId === null
        ? activeSurfaceId !== null && pendingSurfaceIds.has(activeSurfaceId)
          ? [activeSurfaceId]
          : []
        : pendingSurfaceBlocksActivation({
              activeSurfaceId,
              targetSurfaceId,
              pendingSurfaceIds,
            })
          ? [activeSurfaceId!]
          : [];
    return runAfterPendingSave(blockedSurfaceIds, run);
  });
}

/** Holds route and window departure while any file surface still owns local bytes. */
export function usePendingSurfaceNavigationBlocker(
  pendingSurfaceIds: ReadonlySet<string>,
  options: PendingSurfaceDepartureOptions = EMPTY_OPTIONS,
): void {
  const notifiedRef = useRef(false);
  const optionsRef = useRef(options);
  const pendingRef = useRef(pendingSurfaceIds);
  useLayoutEffect(() => {
    optionsRef.current = options;
    pendingRef.current = pendingSurfaceIds;
  }, [options, pendingSurfaceIds]);
  const readPending = useStableCallback(
    () => optionsRef.current.getPendingSurfaceIds?.() ?? pendingRef.current,
  );
  const navigation = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      readPending().size > 0 && current.pathname !== next.pathname,
    enableBeforeUnload: () => readPending().size > 0,
    withResolver: true,
  });
  const navigationRef = useRef(navigation);
  useLayoutEffect(() => {
    navigationRef.current = navigation;
  }, [navigation]);
  const depart = usePendingSurfaceDeparture(pendingSurfaceIds, {
    ...options,
    onAttention: (surfaceId) => {
      const current = navigationRef.current;
      if (current.status === "blocked") current.reset();
      optionsRef.current.onAttention?.(surfaceId);
    },
  });

  useEffect(() => {
    if (navigation.status !== "blocked") {
      if (notifiedRef.current) depart([], () => undefined);
      notifiedRef.current = false;
      return;
    }
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    const finish = () => {
      const current = navigationRef.current;
      if (current.status !== "blocked") return;
      // A second surface may become dirty while this departure is waiting.
      const pending = readPending();
      if (pending.size > 0) depart([...pending], finish);
      else current.proceed();
    };
    depart([...readPending()], finish);
  }, [navigation, depart, readPending]);
}
