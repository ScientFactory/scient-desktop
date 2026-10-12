import { describe, expect, it } from "vite-plus/test";

import { planLatexVisualPagination } from "./latexVisualPagination";
import { planLatexSourceColumns } from "./latexSourceColumns";

const options = {
  pageHeight: 1000,
  pageGap: 32,
  marginTop: 100,
  marginBottom: 100,
};

describe("source-derived two-column flow", () => {
  const parts = (heights: number[]) =>
    heights.map((height, index) => ({
      position: index * 10 + 1,
      size: 10,
      height,
      marginTop: 0,
      marginBottom: 0,
      keepWithNext: false,
    }));

  it("fills the first column before the second without balancing a short tail", () => {
    const plan = planLatexSourceColumns(parts([400, 400, 100]), 100, options);
    expect(plan.parts.map(({ column, top }) => [column, top])).toEqual([
      [0, 0],
      [0, 400],
      [1, 0],
    ]);
    expect(plan.height).toBe(800);
  });

  it("uses the space below a title in both columns and full height on the next sheet", () => {
    const plan = planLatexSourceColumns(parts([600, 600, 400, 400]), 300, options);
    expect(plan.parts.map(({ page, column, top }) => [page, column, top])).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 832],
      [1, 0, 1232],
    ]);
  });

  it("keeps a heading with its following paragraph at a column boundary", () => {
    const content = parts([750, 30, 100]);
    content[1]!.keepWithNext = true;
    const plan = planLatexSourceColumns(content, 100, options);
    expect(plan.parts.map(({ column, top }) => [column, top])).toEqual([
      [0, 0],
      [1, 0],
      [1, 30],
    ]);
  });

  it("continues a paragraph from the first column bottom into the second", () => {
    const content = parts([650, 200, 100]);
    const plan = planLatexSourceColumns(
      content.map((part, index) => (index === 1 ? { ...part, lineHeight: 20 } : part)),
      100,
      options,
    );
    expect(plan.parts[1]).toMatchObject({ column: 0, top: 0, spanHeight: 800, leadingSpace: 660 });
    expect(plan.parts[2]).toMatchObject({ column: 1, top: 60 });
  });

  it("keeps a planned partial-page region below its title", () => {
    const plan = planLatexVisualPagination(
      [
        { top: 100, bottom: 800 },
        { top: 800, bottom: 1300, flowsAcrossPages: true },
      ],
      options,
    );
    expect(plan.pageCount).toBe(2);
    expect(plan.placements[1]?.offset).toBe(0);
  });

  it("uses vertical fill to place a notice at the second column bottom", () => {
    const content = parts([800, 200, 0, 100]);
    const plan = planLatexSourceColumns(
      content.map((part, index) => (index === 2 ? { ...part, stretch: true } : part)),
      100,
      options,
    );
    expect(plan.parts[2]).toMatchObject({ column: 1, top: 200, height: 500 });
    expect(plan.parts[3]).toMatchObject({ column: 1, top: 700 });
    expect(plan.height).toBe(800);
  });

  it("shares remaining column space between fills while reserving following margins", () => {
    const content = parts([800, 200, 0, 100, 0, 100]);
    const plan = planLatexSourceColumns(
      content.map((part, index) => ({
        ...part,
        stretch: index === 2 || index === 4,
        marginBottom: index === 5 ? 20 : 0,
      })),
      100,
      options,
    );
    expect(plan.parts[2]?.height).toBe(190);
    expect(plan.parts[4]?.height).toBe(190);
    expect(plan.parts[5]).toMatchObject({ column: 1, top: 680 });
    expect(plan.height).toBe(800);
  });

  it("keeps fills at natural size when following content cannot fit the column", () => {
    const content = parts([800, 700, 0, 200]);
    const plan = planLatexSourceColumns(
      content.map((part, index) => (index === 2 ? { ...part, stretch: true } : part)),
      100,
      options,
    );
    expect(plan.parts[2]?.height).toBe(0);
    expect(plan.parts[3]).toMatchObject({ page: 1, column: 0, top: 1032 });
  });
});

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
