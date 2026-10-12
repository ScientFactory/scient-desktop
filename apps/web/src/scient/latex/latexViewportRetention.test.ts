import { describe, expect, it } from "vite-plus/test";
import { createLatexViewportRetention } from "./latexViewportRetention";

describe("recent reading view retention", () => {
  it("admits idle completions without scrolling and has no fixed page-count eviction", () => {
    const cache = createLatexViewportRetention<number>();
    const completed = new Set(Array.from({ length: 1000 }, (_, index) => index));
    expect(cache.update(new Set([0]), completed, () => 2048, completed)).toEqual(completed);
    expect(cache.update(new Set([999]), completed, () => 2048)).toEqual(completed);
  });
  it("protects read pages from background admission and evicts background first under pressure", () => {
    const cache = createLatexViewportRetention<string>({ maximumEntries: 10, maximumWeight: 6 });
    const current = new Set(["read", "idle1", "idle2", "newRead"]);
    expect(cache.update(new Set(["read"]), current, () => 2, new Set(["idle1", "idle2"]))).toEqual(
      new Set(["read", "idle1", "idle2"]),
    );
    expect(
      cache.update(new Set(["newRead"]), current, () => 2, new Set(["idle1", "idle2"])),
    ).toEqual(new Set(["read", "idle2", "newRead"]));
    expect(cache.update(new Set(), current, () => 3, new Set(["idle1", "idle2"]))).toEqual(
      new Set(["read", "newRead"]),
    );
  });
  it("keeps visited content until memory pressure and refreshes its recency on return", () => {
    const cache = createLatexViewportRetention<string>({ maximumEntries: 2, maximumWeight: 10 });
    const current = new Set(["a", "b", "c"]);
    cache.update(new Set(["a"]), current, () => 2);
    expect(cache.update(new Set(["b"]), current, () => 2)).toEqual(new Set(["a", "b"]));
    // Idle ticks do not age out a page while the reader is elsewhere.
    for (let tick = 0; tick < 100; tick++) cache.update(new Set(["b"]), current, () => 2);
    expect(cache.update(new Set(["a"]), current, () => 2)).toEqual(new Set(["b", "a"]));
    expect(cache.update(new Set(["c"]), current, () => 2)).toEqual(new Set(["a", "c"]));
  });
  it("bounds churn by weight and recency, drops deleted nodes and does not retain oversized views", () => {
    const cache = createLatexViewportRetention<string>({
      maximumEntries: 2,
      maximumWeight: 5,
    });
    const current = new Set(["a", "b", "c", "large"]);
    cache.update(new Set(["a", "b"]), current, () => 2);
    expect(cache.update(new Set(["c"]), current, (item) => (item === "c" ? 3 : 2))).toEqual(
      new Set(["b", "c"]),
    );
    expect(
      cache.update(new Set(["large"]), current, (item) =>
        item === "large" ? 100 : item === "c" ? 3 : 2,
      ),
    ).toEqual(new Set(["b", "c"]));
    expect(cache.update(new Set(), new Set(["c"]), () => 0)).toEqual(new Set(["c"]));
    cache.clear();
    expect(cache.update(new Set(), current, () => 0).size).toBe(0);
  });
});
