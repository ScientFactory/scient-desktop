import { describe, expect, it } from "vite-plus/test";

import { stepPreviewZoom } from "./previewZoomSteps.ts";

describe("stepPreviewZoom", () => {
  it("steps from a pinched zoom to the next step on its side, and stops at the ends", () => {
    expect(stepPreviewZoom(1.6, 1)).toBe(1.75);
    expect(stepPreviewZoom(1.6, -1)).toBe(1.5);
    expect(stepPreviewZoom(1.5, 1)).toBe(1.75);
    expect(stepPreviewZoom(5, 1)).toBe(5);
    expect(stepPreviewZoom(0.25, -1)).toBe(0.25);
    expect(stepPreviewZoom(1.6, 0)).toBe(1);
  });
});
