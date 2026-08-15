import { describe, expect, it } from "vite-plus/test";

import { plotlyViewportDecision } from "./usePlotlyViewportActivity";

describe("Plotly viewport policy", () => {
  it("activates every figure near the viewport", () => {
    expect(
      plotlyViewportDecision({ everActivated: false, hasWebGl: true, nearViewport: true }),
    ).toBe("activate");
  });

  it("keeps SVG figures mounted and releases only activated WebGL figures", () => {
    expect(
      plotlyViewportDecision({ everActivated: true, hasWebGl: false, nearViewport: false }),
    ).toBe("ignore");
    expect(
      plotlyViewportDecision({ everActivated: false, hasWebGl: true, nearViewport: false }),
    ).toBe("ignore");
    expect(
      plotlyViewportDecision({ everActivated: true, hasWebGl: true, nearViewport: false }),
    ).toBe("schedule-release");
  });
});
