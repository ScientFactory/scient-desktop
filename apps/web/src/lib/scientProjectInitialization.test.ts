import { describe, expect, it } from "vite-plus/test";

import { shouldCloseProjectPickerAfterScientDecision } from "./scientProjectInitialization";

describe("Scient project initialization decision UX", () => {
  it("dismisses the project picker after either accepted opening choice", () => {
    expect(shouldCloseProjectPickerAfterScientDecision("initialize")).toBe(true);
    expect(shouldCloseProjectPickerAfterScientDecision("open-only")).toBe(true);
  });

  it("keeps the project picker available when setup is cancelled", () => {
    expect(shouldCloseProjectPickerAfterScientDecision("cancel")).toBe(false);
  });
});
