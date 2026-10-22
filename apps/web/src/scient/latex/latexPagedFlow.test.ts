import { describe, expect, it } from "vite-plus/test";
import { planPagedFlow, type PagedPlan, type PagedUnit } from "./latexPagedFlow";

const dimensions = { height: 100, top: 10, bottom: 10, gap: 20 };
const unit = (height: number, rest: Partial<PagedUnit> = {}): PagedUnit => ({
  key: {},
  height,
  gap: 0,
  ...rest,
});
function plan(units: readonly PagedUnit[], previous?: PagedPlan) {
  const iterator = planPagedFlow(units, dimensions, previous);
  let result = iterator.next();
  while (!result.done) result = iterator.next();
  return result.value;
}

describe("incremental page and column flow", () => {
  it("shrinks elastic display skips before adding a page and replans the same result after an edit", () => {
    const original = [unit(30, { shrink: 10 }), unit(30, { shrink: 10 }), unit(25)];
    const previous = plan(original);
    expect(previous.pages).toBe(1);
    expect(previous.placements.map((part) => part.height)).toEqual([27.5, 27.5, 25]);
    const changed = original.with(2, unit(35));
    expect(plan(changed, previous).placements).toEqual(plan(changed).placements);
    expect(plan(changed).pages).toBe(1);
    expect(plan(original.with(2, unit(45))).pages).toBe(2);
  });
  it("starts a chapter on a fresh page without discarding its content height", () => {
    const result = plan([unit(20), unit(30, { breakBefore: true, keepWithNext: true }), unit(20)]);
    expect(result.placements.map((part) => [part.page, part.top])).toEqual([
      [0, 10],
      [1, 130],
      [1, 160],
    ]);
  });
  it("fills printable space and keeps heading/paragraph lines together", () => {
    const result = plan([unit(50), unit(20, { keepWithNext: true }), unit(20)]);
    expect(result.placements.map((part) => [part.page, part.top])).toEqual([
      [0, 10],
      [1, 130],
      [1, 150],
    ]);
    expect(result.pages).toBe(2);
  });
  it("flows from a full-width title through both columns and later pages", () => {
    const result = plan([
      unit(20),
      unit(0, { columns: 2 }),
      ...Array.from({ length: 7 }, () => unit(20)),
      unit(0, { columns: 1 }),
    ]);
    expect(result.placements.slice(2, 9).map((part) => [part.page, part.column, part.top])).toEqual(
      [
        [0, 0, 30],
        [0, 0, 50],
        [0, 0, 70],
        [0, 1, 30],
        [0, 1, 50],
        [0, 1, 70],
        [1, 0, 130],
      ],
    );
    expect(result.pages).toBe(2);
  });
  it("does not add an empty sheet at the end of a two-column region", () => {
    expect(plan([unit(0, { columns: 2 }), unit(60), unit(60), unit(0, { columns: 1 })]).pages).toBe(
      1,
    );
  });
  it("distinguishes a column break from a page break and ignores an empty initial break", () => {
    const result = plan([
      unit(0, { columns: 2 }),
      unit(0, { break: "page" }),
      unit(20),
      unit(0, { break: "column" }),
      unit(20),
      unit(0, { break: "page" }),
      unit(20),
    ]);
    expect(result.placements.map((part) => [part.page, part.column])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 1],
      [0, 1],
      [1, 0],
      [1, 0],
    ]);
  });
  it("reserves continuation headers and footers and footnotes", () => {
    const result = plan([
      unit(40),
      unit(30, { noteHeight: 15 }),
      unit(20, { continuationHead: 10, continuationFoot: 5 }),
    ]);
    expect(result.placements[1]?.page).toBe(1);
    expect(result.placements[2]?.top).toBe(160);
    const table = plan([unit(60), unit(30, { continuationHead: 10, continuationFoot: 5 })]);
    expect(table.placements[1]?.top).toBe(140);
  });
  it("allocates explicit vertical fill before an authored break", () => {
    const result = plan([
      unit(20),
      unit(0, { stretch: true }),
      unit(10),
      unit(0, { break: "page" }),
      unit(10),
    ]);
    expect(result.placements[1]?.height).toBe(50);
    expect(result.placements[2]?.top).toBe(80);
  });
  it("makes progress past oversized atomic objects", () => {
    const result = plan([unit(250), unit(10)]);
    expect(result.placements[1]!.top).toBeGreaterThanOrEqual(result.placements[0]!.top + 250);
  });
  it("matches a full plan after content, spacing, break and note changes", () => {
    const original = Array.from({ length: 1000 }, () => unit(10));
    const previous = plan(original);
    for (const replacement of [
      unit(30),
      unit(10, { gap: 5 }),
      unit(0, { break: "page" }),
      unit(10, { noteHeight: 15 }),
    ]) {
      const changed = original.with(731, replacement);
      expect(plan(changed, previous).placements).toEqual(plan(changed).placements);
    }
    const changed = original.with(731, unit(10));
    expect(plan(changed, previous).visited).toBeLessThan(5);
    expect(plan(original, previous).visited).toBe(0);
    const inserted = original.toSpliced(731, 0, unit(25));
    expect(plan(inserted, previous).placements).toEqual(plan(inserted).placements);
  });
});
