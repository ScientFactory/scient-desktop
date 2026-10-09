import { describe, expect, it } from "vite-plus/test";

import {
  settingsPageChoosesOneEnvironment,
  settingsPageRendersOffline,
} from "./settingsPageScopes";

describe("settings page scopes", () => {
  it("has Providers and Documents choose one environment", () => {
    expect(settingsPageChoosesOneEnvironment("/settings/providers")).toBe(true);
    expect(settingsPageChoosesOneEnvironment("/settings/documents")).toBe(true);
    expect(settingsPageChoosesOneEnvironment("/settings/scientific-computing")).toBe(false);
  });

  it("keeps Documents' device preferences reachable while its environment is offline", () => {
    expect(settingsPageRendersOffline("/settings/documents")).toBe(true);
    expect(settingsPageRendersOffline("/settings/providers")).toBe(false);
  });
});
