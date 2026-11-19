// @effect-diagnostics nodeBuiltinImport:off - reads SettingsPanels.tsx as text; importing it in a test pulls the whole settings graph.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { getChangedScientSettingLabels, SCIENT_RESTORED_SETTING_DEFAULTS } from "./settingsRestore";

describe("Scient's part of Restore defaults", () => {
  it("lists the conversation text direction only when it changed", () => {
    expect(getChangedScientSettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(getChangedScientSettingLabels({ contentDirection: "rtl" })).toEqual([
      "Conversation text direction",
    ]);
  });

  it("restores Scient's settings and leaves the compatibility-only math preference", () => {
    expect(SCIENT_RESTORED_SETTING_DEFAULTS).toEqual({
      contentDirection: DEFAULT_UNIFIED_SETTINGS.contentDirection,
      fontWeightInterface: DEFAULT_UNIFIED_SETTINGS.fontWeightInterface,
      browserSearchSuggestions: DEFAULT_UNIFIED_SETTINGS.browserSearchSuggestions,
    });
    expect(SCIENT_RESTORED_SETTING_DEFAULTS).not.toHaveProperty("mathRenderingEnabled");
  });

  it("is composed into T3's useSettingsRestore in place of its math row", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../../components/settings/SettingsPanels.tsx"),
      "utf8",
    );
    const start = source.indexOf("export function useSettingsRestore(");
    expect(start).toBeGreaterThan(-1);
    const hook = source.slice(start, source.indexOf("\n}\n", start));
    expect(hook).toContain("...getChangedScientSettingLabels(settings),");
    expect(hook).toContain("...SCIENT_RESTORED_SETTING_DEFAULTS,");
    expect(hook).not.toContain("mathRenderingEnabled");
  });
});
