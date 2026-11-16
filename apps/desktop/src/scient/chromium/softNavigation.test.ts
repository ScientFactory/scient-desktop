import { describe, expect, it } from "@effect/vitest";

import { disableFeaturesWithSoftNavigation } from "./softNavigation.ts";

describe("disableFeaturesWithSoftNavigation", () => {
  it("adds the feature and keeps features already disabled", () => {
    expect(disableFeaturesWithSoftNavigation(null)).toBe("SoftNavigationDetection");
    expect(disableFeaturesWithSoftNavigation("WaylandWpColorManagerV1")).toBe(
      "WaylandWpColorManagerV1,SoftNavigationDetection",
    );
    expect(disableFeaturesWithSoftNavigation("A,SoftNavigationDetection")).toBeNull();
  });
});
