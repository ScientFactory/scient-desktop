import { expect, it } from "vite-plus/test";
import { createLatexReadingCacheBudget } from "./latexReadingCache";

it("shares byte pressure across geometry and formulas while protecting reading results", () => {
  const budget = createLatexReadingCacheBudget(1024);
  const formulas = budget.cache<string>("math");
  const geometry = budget.cache<number>("geometry");
  formulas.put("read", "markup", 100, true);
  geometry.put("old", 1, 100);
  formulas.put("new", "later", 100);
  expect(formulas.get("read")).toBe("markup");
  expect(geometry.get("old")).toBeUndefined();
  expect(formulas.get("new")).toBe("later");
  expect(budget.statistics().bytes).toBeLessThanOrEqual(1024);
  geometry.put("oversized", 2, 2048);
  expect(geometry.get("oversized")).toBeUndefined();
  formulas.delete("new");
  expect(budget.statistics().entries).toBe(1);
});

it("retains more than 512 small reusable results without a timer expiry", () => {
  const budget = createLatexReadingCacheBudget(1024 * 1024);
  const cache = budget.cache<number>("formula");
  for (let index = 0; index < 1000; index++) cache.put(String(index), index, 16);
  expect(cache.get("0")).toBe(0);
  expect(cache.get("999")).toBe(999);
  expect(budget.statistics().entries).toBe(1000);
  expect(budget.statistics().bytes).toBeLessThanOrEqual(1024 * 1024);
});

it("pauses background admission at capacity and resumes when retained bytes are released", () => {
  const budget = createLatexReadingCacheBudget(900);
  const cache = budget.cache<string>("math");
  expect(cache.put("first", "a", 100, false, "available")).toBe(true);
  expect(cache.put("second", "b", 100, false, "available")).toBe(true);
  for (let attempt = 0; attempt < 1000; attempt++)
    expect(cache.put("later", "c", 100, false, "available")).toBe(false);
  expect(cache.peek("first")).toBe("a");
  expect(cache.peek("second")).toBe("b");
  expect(budget.statistics().evictions).toBe(0);
  expect(budget.statistics().rejections).toBe(1000);
  cache.delete("first");
  expect(cache.put("later", "c", 100, false, "available")).toBe(true);
  expect(budget.statistics().peakBytes).toBeLessThanOrEqual(900);
});

it("keeps background-first LRU ordering without promoting a readiness peek", () => {
  const budget = createLatexReadingCacheBudget(1100);
  const cache = budget.cache<number>("g");
  cache.put("a", 1, 50);
  cache.put("b", 2, 50);
  cache.put("c", 3, 50);
  cache.peek("a");
  cache.get("b", true);
  cache.put("d", 4, 50, true);
  expect(cache.peek("a")).toBeUndefined();
  expect(cache.peek("b")).toBe(2);
  expect(cache.peek("c")).toBe(3);
  expect(cache.peek("d")).toBe(4);
  expect(budget.statistics().bytes).toBeLessThanOrEqual(1100);
});

it("distinguishes an uncacheable result from temporary capacity pressure", () => {
  const budget = createLatexReadingCacheBudget(1000);
  const cache = budget.cache<string>("math");
  expect(cache.canRetain("huge", 2000)).toBe(false);
  expect(cache.canRetain("x".repeat(600), 0)).toBe(false);
  expect(cache.put("x".repeat(600), "fallback", 0, false, "available")).toBe(false);
  expect(cache.put("huge", "oversized", 2000, false, "available")).toBe(false);
  expect(budget.statistics().capacityRejections).toBe(0);
  expect(cache.put("small", "usable", 50, false, "available")).toBe(true);
});
