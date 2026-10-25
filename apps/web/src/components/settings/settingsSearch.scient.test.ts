import { describe, expect, it } from "vite-plus/test";

import { searchableSetting, searchSettings, SETTINGS_SEARCH_ITEMS } from "./settingsSearch";

describe("Scient settings search", () => {
  // regression: dd3895663a fix(cli): install and advertise the Scient command
  it("finds the canonical Scient command and its former t3 name", () => {
    expect(searchableSetting("cli-command").title).toBe("scient command");
    const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.id === "cli-command").map((item) => ({
      ...item,
      desktopOnly: false,
    }));
    expect(searchSettings("scient command", items).map((item) => item.id)).toEqual(["cli-command"]);
    expect(searchSettings("t3", items).map((item) => item.id)).toEqual(["cli-command"]);
  });

  // regression: 352cbecb13 fix(privacy): withhold unapproved policy links
  it("does not offer the withheld privacy-policy link", () => {
    expect(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).not.toContain("privacy-policy");
    expect(searchSettings("privacy policy")).toEqual([]);
    expect(searchSettings("diagnostics")[0]).toMatchObject({ id: "diagnostics" });
  });

  it("keeps the safety-held telemetry export action out of settings search", () => {
    expect(searchSettings("OpenTelemetry export")).toEqual([]);
    expect(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).not.toContain("telemetry-export");
  });
});

describe("searchSettings ranking", () => {
  // regression: 71d12d8c4a feat(web): make keybindings searchable from settings search (#12175)
  // Sole guard of the secondary-item ordering: upstream dropped this row in its snap, and no
  // other test fails when keybinding commands outrank ordinary settings.
  it("ranks keybinding commands after other settings", () => {
    const ids = searchSettings("model").map((item) => item.id);
    const commandIndex = ids.indexOf("keybinding-modelPicker.toggle");
    expect(commandIndex).toBeGreaterThan(-1);
    for (const id of ["custom-models", "default-model", "text-generation-model"]) {
      expect(ids.indexOf(id)).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(ids.indexOf(id));
    }
  });
});
