import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildScientAwareness,
  SCIENT_AWARENESS_DELIVERY,
  SCIENT_CORE_AWARENESS,
  SCIENT_PREVIEW_AWARENESS,
  SCIENT_SKILLS_AWARENESS,
} from "./ScientAwareness.ts";

const wordCount = (value: string): number => value.trim().split(/\s+/u).length;

describe("Scient awareness", () => {
  it("keeps the always-on identity compact and product-level", () => {
    expect(wordCount(SCIENT_CORE_AWARENESS)).toBeLessThanOrEqual(100);
    expect(SCIENT_CORE_AWARENESS).toContain("project workspace");
    expect(SCIENT_CORE_AWARENESS).toContain("inspect and edit workspace files");
    expect(SCIENT_CORE_AWARENESS).toContain("Scient's Markdown chat");
    expect(SCIENT_CORE_AWARENESS).toContain("diagram declaration first");
    expect(SCIENT_CORE_AWARENESS).toContain("self-contained Plotly figure JSON");
    expect(SCIENT_CORE_AWARENESS).toContain("Do not emit HTML");
    expect(SCIENT_CORE_AWARENESS).toContain("not durable project artifacts");
    expect(SCIENT_CORE_AWARENESS).not.toContain("sources_");
  });

  it("mentions Scient skills only when exact skill access is granted", () => {
    expect(wordCount(SCIENT_SKILLS_AWARENESS)).toBeLessThanOrEqual(50);
    expect(buildScientAwareness(new Set(["skills:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_SKILLS_AWARENESS}`,
    );
    expect(buildScientAwareness(new Set(["preview", "skills:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_PREVIEW_AWARENESS}\n\n${SCIENT_SKILLS_AWARENESS}`,
    );
  });

  it("adds compact browser awareness only for an actually granted preview capability", () => {
    expect(wordCount(SCIENT_PREVIEW_AWARENESS)).toBeLessThanOrEqual(50);
    expect(buildScientAwareness()).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["sources:read"]))).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["preview"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_PREVIEW_AWARENESS}`,
    );
  });

  it("requires an explicit delivery decision for every built-in provider", () => {
    const builtInKinds = BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).toSorted();
    expect(Object.keys(SCIENT_AWARENESS_DELIVERY).toSorted()).toEqual(builtInKinds);
    expect(SCIENT_AWARENESS_DELIVERY.antigravity).toBe("unsupported-no-private-system-seam");
    expect(SCIENT_AWARENESS_DELIVERY.cursor).toBe("unsupported-no-private-system-seam");
  });
});
