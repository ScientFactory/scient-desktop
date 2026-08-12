import { describe, expect, it } from "vite-plus/test";

import {
  matlabLabScenarioDefinition,
  normalizeMatlabLabScenario,
  normalizeSourcesLabScenario,
  normalizeUxLabControlPosition,
  normalizeUxLabJourney,
} from "./state";

describe("normalizeUxLabJourney", () => {
  it.each(["zotero-sources", "matlab-run-file"] as const)(
    "keeps the registered %s journey",
    (journey) => {
      expect(normalizeUxLabJourney(journey)).toBe(journey);
    },
  );

  it("falls back to Zotero for older saved lab state", () => {
    expect(normalizeUxLabJourney(null)).toBe("zotero-sources");
    expect(normalizeUxLabJourney("unknown")).toBe("zotero-sources");
  });
});

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

describe("MATLAB lab scenarios", () => {
  it.each(["success", "failure", "long-running"] as const)(
    "keeps the registered %s scenario",
    (scenario) => {
      expect(normalizeMatlabLabScenario(scenario)).toBe(scenario);
    },
  );

  it("falls back to the successful run and resolves its real fixture", () => {
    expect(normalizeMatlabLabScenario("unknown")).toBe("success");
    expect(matlabLabScenarioDefinition("success").relativePath).toBe(
      "ux-lab-fixtures/matlab/cohort_analysis.m",
    );
  });
});
