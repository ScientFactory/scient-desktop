import { describe, expect, it } from "vite-plus/test";

import {
  settingsPageChoosesOneEnvironment,
  settingsPageIgnoresProjects,
  settingsPageRendersOffline,
  settingsPageScopeSearch,
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

  it("sets the project aside on Documents, so its server tools never inherit a project scope", () => {
    const search = { project: "paper", machine: "remote", checkout: "remote:paper" };
    expect(settingsPageIgnoresProjects("/settings/documents")).toBe(true);
    expect(settingsPageScopeSearch("/settings/documents", search)).toEqual({ machine: "remote" });
    expect(settingsPageIgnoresProjects("/settings/providers")).toBe(false);
    expect(settingsPageScopeSearch("/settings/providers", search)).toBe(search);
  });

  it("has Extensions manage one server, so its picker names the machine every change goes to", () => {
    const search = { project: "paper", machine: "remote", checkout: "remote:paper" };
    expect(settingsPageChoosesOneEnvironment("/settings/extensions")).toBe(true);
    expect(settingsPageScopeSearch("/settings/extensions", search)).toEqual({ machine: "remote" });
    expect(settingsPageRendersOffline("/settings/extensions")).toBe(false);
  });
});
