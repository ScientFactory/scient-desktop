import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { buildKeybindingRows } from "./KeybindingsSettings.logic";

describe("buildKeybindingRows", () => {
  // regression: 9130d932f4 feat(web): add composer and PR number shortcuts (#11615)
  // Sole guard: no other test notices a default binding losing its "Default" source.
  // The sendAlternate conflict below is the current (spurious) mod+enter overlap with
  // sendBackground, recorded as a finding; update this row when that is fixed.
  it("lists composer, provider, and pull request commands with editable defaults", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS);
    for (const command of [
      "composer.sendAlternate",
      "composer.sendBackground",
      "thread.steerQueuedMessage",
      "thread.editQueuedMessage",
      "composer.host",
      "composer.effort",
      "composer.mode",
      "composer.workspace",
      "composer.branch",
      "composer.previousWorktree",
      "modelPicker.previousProvider",
      "modelPicker.nextProvider",
      "thread.copyReference",
      "pullRequest.copyNumber",
    ]) {
      expect(rows.find((row) => row.command === command)).toMatchObject({
        source: "Default",
        conflicts: command === "composer.sendAlternate" ? ["Composer: Start in Background"] : [],
      });
    }
  });
});
