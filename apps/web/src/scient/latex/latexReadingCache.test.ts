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
