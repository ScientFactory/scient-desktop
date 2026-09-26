import { describe, expect, it } from "vite-plus/test";

import { planLatexVisualPagination } from "./latexVisualPagination";

const options = {
  pageHeight: 1000,
  pageGap: 32,
  marginTop: 100,
  marginBottom: 100,
};

describe("visual LaTeX pagination", () => {
  it("moves a complete block to the next printable page", () => {
    const plan = planLatexVisualPagination(
      [
        { top: 100, bottom: 780 },
        { top: 800, bottom: 950 },
      ],
      options,
    );

    expect(plan.pageCount).toBe(2);
    expect(plan.placements[1]).toMatchObject({ page: 1, offset: 332 });
  });

  it("moves a block out of the bottom margin and inter-page gap", () => {
    const plan = planLatexVisualPagination(
      [
        { top: 100, bottom: 860 },
        { top: 920, bottom: 980 },
      ],
      options,
    );

    expect(plan.pageCount).toBe(2);
    expect(plan.placements[1]).toMatchObject({ page: 1, offset: 212 });
  });

  it("turns an explicit LaTeX break into a new sheet", () => {
    const plan = planLatexVisualPagination(
      [
        { top: 100, bottom: 240 },
        { top: 260, bottom: 260, explicitBreak: true },
        { top: 280, bottom: 380 },
      ],
      options,
    );

    expect(plan.pageCount).toBe(2);
    expect(plan.placements[1]).toMatchObject({ page: 1, offset: 872 });
    expect(plan.placements[2]).toMatchObject({ page: 1 });
  });

  it("does not manufacture a blank page for a break at the page start", () => {
    const plan = planLatexVisualPagination(
      [
        { top: 100, bottom: 100, explicitBreak: true },
        { top: 120, bottom: 220 },
      ],
      options,
    );

    expect(plan.pageCount).toBe(1);
    expect(plan.placements[0]?.offset).toBe(0);
  });
});
