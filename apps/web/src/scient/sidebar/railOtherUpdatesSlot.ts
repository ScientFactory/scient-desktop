import { useSyncExternalStore } from "react";

/**
 * With the icon rail, this app's update sits in the sidebar header and the circle for other
 * updates sits in the rail. The header's update control owns both, so it renders the circle into
 * the rail's slot. The collapsed rail mounts after the sidebar's own, so the latest slot wins.
 */
let slots: ReadonlyArray<HTMLElement> = [];
const listeners = new Set<() => void>();

function publish(next: ReadonlyArray<HTMLElement>): void {
  slots = next;
  for (const listener of listeners) listener();
}

/** A ref callback for a rail element that holds the circle. */
export function registerRailOtherUpdatesSlot(element: HTMLElement | null): (() => void) | void {
  if (!element) return;
  publish([...slots, element]);
  return () => publish(slots.filter((slot) => slot !== element));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRailOtherUpdatesSlot(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => slots.at(-1) ?? null,
    () => null,
  );
}
