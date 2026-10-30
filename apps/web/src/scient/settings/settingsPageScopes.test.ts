import { describe, expect, it } from "vite-plus/test";

import {
  settingsPageChoosesOneEnvironment,
  settingsPageIgnoresProjects,
  settingsPageRendersOffline,
  settingsPageScopeSearch,
} from "./settingsPageScopes";

describe("settings page scopes", () => {
  it("keeps synced-folder credentials and links scoped to one connected server", () => {
    const pathname = "/settings/synced-folders";
    expect(settingsPageChoosesOneEnvironment(pathname)).toBe(true);
    expect(
      settingsPageScopeSearch(pathname, {
        project: "paper",
        machine: "remote",
        checkout: "remote:paper",
      }),
    ).toEqual({ machine: "remote" });
    expect(settingsPageRendersOffline(pathname)).toBe(false);
  });

  it("has Providers and Documents choose one environment", () => {
    expect(settingsPageChoosesOneEnvironment("/settings/providers")).toBe(true);
    expect(settingsPageChoosesOneEnvironment("/settings/documents")).toBe(true);
    expect(settingsPageChoosesOneEnvironment("/settings/scientific-computing")).toBe(true);
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
    for (const page of [
      "/settings/extensions/installed",
      "/settings/extensions/item/connector/con_linear0001",
      "/settings/extensions/item/server/io.github.owner/server",
    ]) {
      expect(settingsPageChoosesOneEnvironment(page)).toBe(true);
      expect(settingsPageScopeSearch(page, search)).toEqual({ machine: "remote" });
    }
    expect(settingsPageChoosesOneEnvironment("/settings/skills/external")).toBe(false);
  });
});
