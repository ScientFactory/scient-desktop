import { describe, expect, it } from "vite-plus/test";

import { normalizeSourcesLabScenario, normalizeUxLabControlPosition } from "./state";

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

describe("normalizeUxLabControlPosition", () => {
  it("restores a finite stored position", () => {
    expect(normalizeUxLabControlPosition('{"x":120,"y":48}')).toEqual({ x: 120, y: 48 });
  });

  it.each([null, "invalid", '{"x":null,"y":48}', '{"x":120,"y":"48"}'])(
    "rejects invalid persisted state: %s",
    (value) => {
      expect(normalizeUxLabControlPosition(value)).toBeNull();
    },
  );
});
