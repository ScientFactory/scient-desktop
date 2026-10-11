import { flushSync } from "react-dom";

type ResizeCallback = (entries: readonly ResizeObserverEntry[]) => void;

interface Subscription {
  readonly callback: ResizeCallback;
  active: boolean;
}

interface Target {
  readonly subscriptions: Set<Subscription>;
  /** Subscribers that joined after the first delivery and still await their initial entry. */
  waiting: Set<Subscription> | null;
  last: ResizeObserverEntry | null;
}

interface ObservationGroup {
  readonly observer: ResizeObserver;
  readonly targets: Map<Element, Target>;
}

const groups = new Map<ResizeObserverBoxOptions, ObservationGroup>();

function sameObservedSize(
  previous: ResizeObserverEntry,
  next: ResizeObserverEntry,
  box: ResizeObserverBoxOptions,
) {
  if (box === "content-box") {
    return (
      previous.contentRect.width === next.contentRect.width &&
      previous.contentRect.height === next.contentRect.height
    );
  }
  const previousSizes =
    box === "border-box" ? previous.borderBoxSize : previous.devicePixelContentBoxSize;
  const nextSizes = box === "border-box" ? next.borderBoxSize : next.devicePixelContentBoxSize;
  return (
    previousSizes.length === nextSizes.length &&
    previousSizes.every(
      (size, index) =>
        size.inlineSize === nextSizes[index]?.inlineSize &&
        size.blockSize === nextSizes[index]?.blockSize,
    )
  );
}

function deliver(
  entries: readonly ResizeObserverEntry[],
  targets: Map<Element, Target>,
  box: ResizeObserverBoxOptions,
) {
  const batches = new Map<Subscription, ResizeObserverEntry[]>();
  for (const entry of entries) {
    const target = targets.get(entry.target);
    if (!target) continue;
    let recipients = target.subscriptions;
    if (target.waiting) {
      // Re-observing for a new subscriber redelivers an unchanged size to everyone else too.
      if (target.last && sameObservedSize(target.last, entry, box)) {
        recipients = target.waiting;
      }
      target.waiting = null;
    }
    target.last = entry;
    for (const subscription of recipients) {
      const batch = batches.get(subscription);
      if (batch) batch.push(entry);
      else batches.set(subscription, [entry]);
    }
  }
  if (batches.size === 0) return;
  flushSync(() => {
    for (const [subscription, batch] of batches) {
      if (!subscription.active) continue;
      try {
        subscription.callback(batch);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  });
}

/**
 * Observes element sizes on one shared ResizeObserver per box. Its callbacks run after
 * layout and before paint, but React commits state set there after the paint,
 * so layout derived from an observed size would land one frame late. Every
 * resize delivered in a frame runs inside one flushSync, so all size-derived
 * state commits in a single render before that paint. A callback gets one call
 * with the entries for all of its targets, starting with an initial one each.
 * The optional box defaults to content-box; different boxes have independent
 * target lifetimes, so disposing one never stops another box's subscription.
 */
export function observeResize(
  elements: Element | readonly Element[],
  callback: ResizeCallback,
  options?: ResizeObserverOptions,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const box = options?.box ?? "content-box";
  let group = groups.get(box);
  if (!group) {
    const targets = new Map<Element, Target>();
    group = { observer: new ResizeObserver((entries) => deliver(entries, targets, box)), targets };
    groups.set(box, group);
  }
  const { observer: shared, targets } = group;
  const subscription: Subscription = { callback, active: true };
  const observed: readonly Element[] = Array.isArray(elements) ? elements : [elements as Element];
  for (const element of observed) {
    const target = targets.get(element);
    if (!target) {
      targets.set(element, { subscriptions: new Set([subscription]), waiting: null, last: null });
      shared.observe(element, { box });
      continue;
    }
    target.subscriptions.add(subscription);
    // An initial entry still pending reaches every subscriber; after it, only
    // observing afresh makes the browser report the current size again.
    if (!target.last) continue;
    (target.waiting ??= new Set()).add(subscription);
    shared.unobserve(element);
    shared.observe(element, { box });
  }
  return () => {
    if (!subscription.active) return;
    subscription.active = false;
    const unobserved = observed.filter((element) => {
      const target = targets.get(element);
      if (!target?.subscriptions.delete(subscription)) return false;
      target.waiting?.delete(subscription);
      return target.subscriptions.size === 0 && targets.delete(element);
    });
    if (targets.size > 0) {
      for (const element of unobserved) shared.unobserve(element);
    } else {
      // A fresh observer next time also picks up a ResizeObserver a test stubbed since.
      shared.disconnect();
      groups.delete(box);
    }
  };
}
