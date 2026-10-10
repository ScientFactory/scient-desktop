import { useEffect, useState } from "react";

// One observer per scroll viewport serves row bodies and their live-data leases.
const pools = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    subscribers: Map<Element, Set<(visible: boolean) => void>>;
  }
>();

export function observeSidebarRow(element: Element, notify: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    notify(true);
    return () => {};
  }
  const root = element.closest('[data-slot="scroll-area-viewport"]');
  let pool = pools.get(root);
  if (!pool) {
    const subscribers = new Map<Element, Set<(visible: boolean) => void>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const callback of subscribers.get(entry.target) ?? []) {
            callback(entry.isIntersecting);
          }
        }
      },
      { root, rootMargin: "160px 0px" },
    );
    pool = { observer, subscribers };
    pools.set(root, pool);
  }
  let subscribers = pool.subscribers.get(element);
  if (!subscribers) {
    subscribers = new Set();
    pool.subscribers.set(element, subscribers);
    pool.observer.observe(element);
  }
  subscribers.add(notify);
  const ownedPool = pool;
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      ownedPool.observer.unobserve(element);
      ownedPool.subscribers.delete(element);
    }
    if (ownedPool.subscribers.size === 0) {
      ownedPool.observer.disconnect();
      pools.delete(root);
    }
  };
}

/** Visibility is independent of selection so a departing selection can release its body. */
export function useSidebarRowVisibility() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  useEffect(() => {
    if (!element) return;
    return observeSidebarRow(element, setIsNearViewport);
  }, [element]);
  return { isNearViewport, rowRef: setElement };
}
