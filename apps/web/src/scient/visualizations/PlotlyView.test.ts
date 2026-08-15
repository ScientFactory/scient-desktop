import { describe, expect, it } from "vite-plus/test";

import { plotlyResizeChanged } from "./PlotlyView";

describe("Plotly resize policy", () => {
  it("tracks width for inline figures but ignores inline height changes", () => {
    const previous = { height: 320, width: 640 };

    expect(plotlyResizeChanged("inline", previous, { height: 400, width: 640 })).toBe(false);
    expect(plotlyResizeChanged("inline", previous, { height: 320, width: 700 })).toBe(true);
  });

  it("tracks height-only changes for expanded figures", () => {
    expect(
      plotlyResizeChanged("expanded", { height: 500, width: 900 }, { height: 600, width: 900 }),
    ).toBe(true);
  });
});
