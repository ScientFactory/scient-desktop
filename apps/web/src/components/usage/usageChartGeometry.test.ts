import { describe, expect, it } from "vite-plus/test";

import {
  nearestCurveIndex,
  nearestPeriodIndex,
  placeChartTooltip,
  shapePreservingCurvePath,
  shapePreservingCurveYAtX,
  shapePreservingCurveYRangeBetweenX,
} from "./usageChartGeometry";

describe("shapePreservingCurvePath", () => {
  it("keeps measured points and uses a smooth cubic path", () => {
    const path = shapePreservingCurvePath([
      { x: 0, y: 100 },
      { x: 100, y: 20 },
      { x: 200, y: 80 },
    ]);

    expect(path).toMatch(/^M0\.00,100\.00 C/u);
    expect(path).toContain(" 100.00,20.00");
    expect(path.endsWith(" 200.00,80.00")).toBe(true);
    expect(path).not.toContain("NaN");
  });

  it("renders a single measured point without inventing a segment", () => {
    expect(shapePreservingCurvePath([{ x: 50, y: 25 }])).toBe("M50.00,25.00");
  });

  it("locates the hover anchor on the same continuous curve", () => {
    const points = [
      { x: 0, y: 100 },
      { x: 100, y: 20 },
      { x: 200, y: 80 },
    ];

    expect(shapePreservingCurveYAtX(points, 0)).toBe(100);
    expect(shapePreservingCurveYAtX(points, 50)).toBeGreaterThan(20);
    expect(shapePreservingCurveYAtX(points, 50)).toBeLessThan(100);
    expect(shapePreservingCurveYAtX(points, 100)).toBe(20);
    expect(shapePreservingCurveYAtX(points, 200)).toBe(80);
  });
});

describe("shapePreservingCurveYRangeBetweenX", () => {
  const points = [
    { x: 0, y: 100 },
    { x: 100, y: 20 },
    { x: 200, y: 80 },
  ];

  it("includes interior measured extrema within the horizontal span", () => {
    expect(shapePreservingCurveYRangeBetweenX(points, 50, 150)).toEqual({
      min: 20,
      max: shapePreservingCurveYAtX(points, 50),
    });
  });

  it("normalizes reversed and out-of-bounds spans", () => {
    expect(shapePreservingCurveYRangeBetweenX(points, 250, -50)).toEqual({
      min: 20,
      max: 100,
    });
    expect(shapePreservingCurveYRangeBetweenX(points, 250, 300)).toBeNull();
    expect(shapePreservingCurveYRangeBetweenX([], 0, 100)).toBeNull();
  });
});

describe("nearestCurveIndex", () => {
  it("selects the curve closest to the pointer in rendered pixels", () => {
    expect(nearestCurveIndex({ curveYs: [40, 100], pointerY: 92, previousIndex: null })).toBe(1);
    expect(nearestCurveIndex({ curveYs: [40, 100], pointerY: 45, previousIndex: null })).toBe(0);
  });

  it("keeps the current curve through near-ties and switches once clearly closer", () => {
    expect(nearestCurveIndex({ curveYs: [40, 100], pointerY: 72, previousIndex: 0 })).toBe(0);
    expect(nearestCurveIndex({ curveYs: [40, 100], pointerY: 80, previousIndex: 0 })).toBe(1);
    expect(nearestCurveIndex({ curveYs: [60, 60], pointerY: 60, previousIndex: 1 })).toBe(1);
  });

  it("handles an empty curve set", () => {
    expect(nearestCurveIndex({ curveYs: [], pointerY: 50, previousIndex: null })).toBeNull();
  });
});

describe("nearestPeriodIndex", () => {
  it("selects the nearest real period while the pointer moves continuously", () => {
    expect(nearestPeriodIndex(0, 600, 7)).toBe(0);
    expect(nearestPeriodIndex(49, 600, 7)).toBe(0);
    expect(nearestPeriodIndex(51, 600, 7)).toBe(1);
    expect(nearestPeriodIndex(349, 600, 7)).toBe(3);
    expect(nearestPeriodIndex(351, 600, 7)).toBe(4);
    expect(nearestPeriodIndex(600, 600, 7)).toBe(6);
  });
});

describe("placeChartTooltip", () => {
  const size = {
    tooltipWidth: 180,
    tooltipHeight: 100,
    plotWidth: 600,
  };

  it("places the tooltip diagonally above the tracked point when space allows", () => {
    expect(placeChartTooltip({ ...size, anchorX: 100, anchorY: 150 })).toEqual({
      left: 120,
      top: 30,
    });
  });

  it("keeps the tooltip above a high point even when it overlaps the chart header", () => {
    expect(placeChartTooltip({ ...size, anchorX: 100, anchorY: 10 })).toEqual({
      left: 120,
      top: -110,
    });
  });

  it("flips above-left near the right edge", () => {
    expect(placeChartTooltip({ ...size, anchorX: 580, anchorY: 150 })).toEqual({
      left: 380,
      top: 30,
    });
  });

  it("centers horizontally while remaining above the point in a narrow plot", () => {
    expect(
      placeChartTooltip({
        anchorX: 100,
        anchorY: 150,
        tooltipWidth: 180,
        tooltipHeight: 100,
        plotWidth: 200,
      }),
    ).toEqual({ left: 10, top: 30 });
  });

  it("lifts only when a curve would pass behind the tooltip", () => {
    expect(
      placeChartTooltip({
        ...size,
        anchorX: 100,
        anchorY: 150,
        curveYRanges: [{ min: 70, max: 100 }],
        maxCurveLift: 32,
      }),
    ).toEqual({ left: 120, top: -2 });
    expect(
      placeChartTooltip({
        ...size,
        anchorX: 100,
        anchorY: 150,
        curveYRanges: [{ min: 150, max: 180 }],
        maxCurveLift: 32,
      }),
    ).toEqual({ left: 120, top: 30 });
  });

  it("caps chained curve avoidance at the configured extra lift", () => {
    expect(
      placeChartTooltip({
        ...size,
        anchorX: 100,
        anchorY: 150,
        curveYRanges: [
          { min: 70, max: 100 },
          { min: -20, max: 0 },
        ],
        maxCurveLift: 32,
      }),
    ).toEqual({ left: 120, top: -2 });
  });

  it("supports a wider clearance while releasing a previous curve adjustment", () => {
    expect(
      placeChartTooltip({
        ...size,
        anchorX: 100,
        anchorY: 150,
        curveClearance: 10,
        curveYRanges: [{ min: 142, max: 160 }],
      }),
    ).toEqual({ left: 120, top: 30 });
    expect(
      placeChartTooltip({
        ...size,
        anchorX: 100,
        anchorY: 150,
        curveClearance: 16,
        curveYRanges: [{ min: 142, max: 160 }],
      }),
    ).toEqual({ left: 120, top: 26 });
  });
});
