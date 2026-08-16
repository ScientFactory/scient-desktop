import { describe, expect, it } from "vite-plus/test";

import { sourceAddedLabel } from "./sourceLabels";

describe("sourceAddedLabel", () => {
  it("prioritizes the transient just-added state", () => {
    expect(sourceAddedLabel("not-a-date", true)).toBe("Just added");
  });

  it("identifies agent-added sources during the transient state", () => {
    expect(sourceAddedLabel("not-a-date", true, true)).toBe("Just added by an agent");
  });

  it("uses Added today for the current local calendar day", () => {
    expect(sourceAddedLabel(new Date().toISOString(), false)).toBe("Added today");
  });

  it("falls back to a formatted date for older sources", () => {
    expect(sourceAddedLabel("2020-01-02T12:00:00.000Z", false)).toMatch(/^Added /u);
  });
});
