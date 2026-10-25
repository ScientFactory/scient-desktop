import { describe, expect, it } from "vite-plus/test";

import { movePdfPages, pdfMoveDestinations, type PdfEditFrame } from "./pdfPageEdits";

const frame: PdfEditFrame = {
  pages: ["a", "b", "c", "d", "e"].map((id, sourceIndex) => ({
    id,
    sourceId: "base",
    sourceIndex,
    width: 100,
    height: 100,
    rotation: 0,
  })),
  selection: [],
};
/** The resulting page order, or "unchanged" for a step the menu disables. */
const order = (target: readonly string[], boundary: number | null) =>
  boundary === null
    ? "unchanged"
    : movePdfPages(frame, boundary, target)
        .pages.map((page) => page.id)
        .join("");

describe("pdfMoveDestinations", () => {
  it("moves one page to the start, up, down and to the end", () => {
    const steps = pdfMoveDestinations(frame, ["c"]);
    expect(order(["c"], steps.start)).toBe("cabde");
    expect(order(["c"], steps.up)).toBe("acbde");
    expect(order(["c"], steps.down)).toBe("abdce");
    expect(order(["c"], steps.end)).toBe("abdec");
  });

  it("moves a scattered group up or down as one block", () => {
    const steps = pdfMoveDestinations(frame, ["b", "d"]);
    expect(order(["b", "d"], steps.up)).toBe("bdace");
    expect(order(["b", "d"], steps.down)).toBe("acebd");
  });

  it("puts the first moved page at a typed page number", () => {
    const one = pdfMoveDestinations(frame, ["c"]);
    expect(one).toMatchObject({ page: 3, lastPage: 5 });
    expect([1, 2, 3, 4, 5].map((page) => order(["c"], one.toPage(page)))).toEqual([
      "cabde",
      "acbde",
      "abcde",
      "abdce",
      "abdec",
    ]);
    const group = pdfMoveDestinations(frame, ["b", "d"]);
    expect(group).toMatchObject({ page: 2, lastPage: 4 });
    expect([1, 2, 3, 4].map((page) => order(["b", "d"], group.toPage(page)))).toEqual([
      "bdace",
      "abdce",
      "acbde",
      "acebd",
    ]);
    expect([0, 6, 2.5].map(one.toPage)).toEqual([null, null, null]);
  });

  it("offers no step that keeps the order", () => {
    expect(pdfMoveDestinations(frame, ["a"])).toMatchObject({ start: null, up: null });
    expect(pdfMoveDestinations(frame, ["e"])).toMatchObject({ down: null, end: null });
  });
});
