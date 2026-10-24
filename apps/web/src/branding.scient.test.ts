import { describe, expect, it } from "vite-plus/test";

import { resolveServerBackedAppStageLabel } from "./branding.logic";

describe("branding logic", () => {
  it("identifies a Beta server explicitly", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.6.23-beta.20261010.1",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Beta");
  });
});
