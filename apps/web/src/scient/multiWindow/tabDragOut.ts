import type { DragEndEvent } from "@dnd-kit/core";
import { useEffect, useRef } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface TrackedDrag {
  readonly point: () => Point | null;
  readonly stop: () => void;
}

const outsideWindow = (point: Point) =>
  point.x < 0 || point.y < 0 || point.x >= window.innerWidth || point.y >= window.innerHeight;

function trackPointer(): TrackedDrag {
  let point: Point | null = null;
  const follow = (event: PointerEvent) => {
    point = { x: event.clientX, y: event.clientY };
  };
  window.addEventListener("pointermove", follow, true);
  window.addEventListener("pointerup", follow, true);
  return {
    point: () => point,
    stop: () => {
      window.removeEventListener("pointermove", follow, true);
      window.removeEventListener("pointerup", follow, true);
    },
  };
}

/**
 * Opens a tab dragged out of the app window in a window of its own, where it was dropped.
 * dnd-kit reports only the movement its modifiers allow, which stays in the tab strip, so the
 * pointer is followed here.
 */
export function useTabDragOut(
  surfaces: readonly RightPanelSurface[],
  onOpen:
    | ((surface: RightPanelSurface, options: { readonly atCursor: boolean }) => void)
    | undefined,
) {
  const drag = useRef<TrackedDrag | null>(null);
  const finish = () => {
    const current = drag.current;
    drag.current = null;
    current?.stop();
    return current?.point() ?? null;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes the window pointer listeners of a drag cut short by the tab strip unmounting
  useEffect(
    () => () => {
      drag.current?.stop();
      drag.current = null;
    },
    [],
  );

  return {
    /** The tab strip's drag handlers; a tab dropped inside the window goes to `onDragEnd`. */
    handlers: (onDragEnd: (event: DragEndEvent) => void) => ({
      onDragStart: () => {
        finish();
        if (onOpen) drag.current = trackPointer();
      },
      onDragCancel: () => {
        finish();
      },
      onDragEnd: (event: DragEndEvent) => {
        const point = finish();
        const surface =
          onOpen && point !== null && outsideWindow(point)
            ? surfaces.find((entry) => entry.id === String(event.active.id))
            : undefined;
        if (surface) onOpen?.(surface, { atCursor: true });
        else onDragEnd(event);
      },
    }),
  };
}
