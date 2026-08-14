import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { waitForProjectionValue } from "./projectProjection";

function projectionSource<T>(initial: T) {
  let value = initial;
  let listener: ((next: T) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const subscribe = vi.fn((nextListener: (next: T) => void) => {
    listener = nextListener;
    return unsubscribe;
  });

  return {
    read: vi.fn(() => value),
    subscribe,
    unsubscribe,
    publish(next: T) {
      value = next;
      listener?.(next);
    },
  };
}

describe("projection readiness", () => {
  afterEach(() => vi.useRealTimers());

  it("returns immediately when the value is already projected", async () => {
    const source = projectionSource({ id: "project-ready" } as { id: string } | null);

    await expect(waitForProjectionValue(source, (value) => value !== null, 5_000)).resolves.toBe(
      true,
    );
    expect(source.subscribe).not.toHaveBeenCalled();
  });

  it("resolves and unsubscribes when the projection arrives", async () => {
    const source = projectionSource<{ id: string } | null>(null);
    const ready = waitForProjectionValue(source, (value) => value !== null, 5_000);

    source.publish({ id: "project-ready" });

    await expect(ready).resolves.toBe(true);
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });

  it("re-reads after subscribing so a boundary update cannot be missed", async () => {
    const project = { id: "project-ready" };
    let reads = 0;
    const unsubscribe = vi.fn();

    await expect(
      waitForProjectionValue(
        {
          read: () => (++reads === 1 ? null : project),
          subscribe: () => unsubscribe,
        },
        (value) => value !== null,
        5_000,
      ),
    ).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("times out and releases its subscription instead of opening an invalid draft", async () => {
    vi.useFakeTimers();
    const source = projectionSource<{ id: string } | null>(null);
    const ready = waitForProjectionValue(source, (value) => value !== null, 250);

    await vi.advanceTimersByTimeAsync(250);

    await expect(ready).resolves.toBe(false);
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });
});
