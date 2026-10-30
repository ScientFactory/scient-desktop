import type { DragEndEvent } from "@dnd-kit/core";
import { useEffect, useRef } from "react";

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
 * Notices a tab drag that ends outside the app window. dnd-kit reports only the movement its
 * modifiers allow, which stays in the tab strip, so the pointer is followed here.
 */
export function useTabDragOut(onDropOutsideWindow: ((surfaceId: string) => void) | undefined) {
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
    onDragStart: () => {
      finish();
      if (onDropOutsideWindow) drag.current = trackPointer();
    },
    onDragCancel: () => {
      finish();
    },
    /** Opens a tab dropped outside the window elsewhere; true when the strip should not reorder. */
    droppedOutside: (event: DragEndEvent): boolean => {
      const point = finish();
      if (!onDropOutsideWindow || point === null || !outsideWindow(point)) return false;
      onDropOutsideWindow(String(event.active.id));
      return true;
    },
  };
}
