import { describe, expect, it } from "vite-plus/test";
import { createLatexViewportRetention } from "./latexViewportRetention";

describe("recent reading view retention", () => {
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
