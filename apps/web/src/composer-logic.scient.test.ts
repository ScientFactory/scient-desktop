import { describe, expect, it } from "vite-plus/test";

import { isStandaloneForkSlashCommand } from "./composer-logic";

describe("isStandaloneForkSlashCommand", () => {
  it("recognizes a standalone /fork command", () => {
    expect(isStandaloneForkSlashCommand(" /FoRk ")).toBe(true);
  });

  it("does not consume a message that starts with /fork", () => {
    expect(isStandaloneForkSlashCommand("/fork explain this")).toBe(false);
  });
});
