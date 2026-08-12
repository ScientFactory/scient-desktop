import { describe, expect, it } from "vite-plus/test";

import { normalizeSourcesLabScenario } from "./state";

describe("normalizeSourcesLabScenario", () => {
  it.each(["imported", "recent-import", "warning", "empty"] as const)(
    "keeps the registered %s scenario",
    (scenario) => {
      expect(normalizeSourcesLabScenario(scenario)).toBe(scenario);
    },
  );

  it("falls back to the representative imported state", () => {
    expect(normalizeSourcesLabScenario(null)).toBe("imported");
    expect(normalizeSourcesLabScenario("unknown")).toBe("imported");
  });
});
