import { describe, expect, it } from "vite-plus/test";

import { SCIENT_CHART_SERIES_COLORS } from "./chartPalette";

const RED = "#e45756";
const GREEN = "#54a24b";

describe("chart series colours", () => {
  it("keeps red and green out of the same four-series chart", () => {
    const firstFour = SCIENT_CHART_SERIES_COLORS.slice(0, 4);
    expect(firstFour).toContain(RED);
    expect(firstFour).not.toContain(GREEN);
  });

  it("gives every series its own colour", () => {
    expect(new Set(SCIENT_CHART_SERIES_COLORS).size).toBe(SCIENT_CHART_SERIES_COLORS.length);
  });
});
