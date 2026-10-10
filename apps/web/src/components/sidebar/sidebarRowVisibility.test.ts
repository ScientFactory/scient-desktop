import { afterEach, expect, it, vi } from "vite-plus/test";
import { observeSidebarRow } from "./sidebarRowVisibility";

afterEach(() => vi.unstubAllGlobals());

it("shares an observer across many rows and releases the viewport after its last row", () => {
  const root = {} as Element;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  const callbacks: IntersectionObserverCallback[] = [];
  const constructor = vi.fn(function (callback: IntersectionObserverCallback) {
    callbacks.push(callback);
    return { observe, unobserve, disconnect };
  });
  vi.stubGlobal("IntersectionObserver", constructor);
  const rows = Array.from({ length: 1560 }, () => ({ closest: () => root }) as unknown as Element);
  const notified = vi.fn();
  const releases = rows.map((row) => observeSidebarRow(row, notified));
  expect(constructor).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1560);
  callbacks[0]!(
    [{ target: rows[800], isIntersecting: true }] as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  );
  expect(notified).toHaveBeenCalledExactlyOnceWith(true);
  releases.slice(0, -1).forEach((release) => release());
  expect(disconnect).not.toHaveBeenCalled();
  releases.at(-1)!();
  expect(unobserve).toHaveBeenCalledTimes(1560);
  expect(disconnect).toHaveBeenCalledTimes(1);
  const releaseAgain = observeSidebarRow(rows[0]!, notified);
  expect(constructor).toHaveBeenCalledTimes(2);
  releaseAgain();
});

it("renders the full row when intersection observation is unavailable", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const notify = vi.fn();
  observeSidebarRow({} as Element, notify)();
  expect(notify).toHaveBeenCalledExactlyOnceWith(true);
});
