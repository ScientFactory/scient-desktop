import { describe, expect, it } from "vite-plus/test";

import { settingsContentResetKey } from "./settingsScopeNavigation";

const checkoutSearch = {
  project: "repository:t3code",
  machine: "remote-server",
  checkout: "remote-server:/home/user/T3 Code",
};

// regression: 6a52b09f3a fix(settings): acknowledge navigation and avoid repeated setup
describe("Settings content lifetime", () => {
  it("retains page state across same-scope provider/task target changes", () => {
    const initial = { ...checkoutSearch, instanceId: "codex", taskId: "task-a" };
    const next = { ...checkoutSearch, instanceId: "claudeCode", taskId: "task-b" };
    expect(settingsContentResetKey(initial, 0)).toBe(settingsContentResetKey(next, 0));
  });
  it("resets for any actual scope axis and explicit restore", () => {
    const original = settingsContentResetKey(checkoutSearch, 0);
    for (const axis of ["project", "machine", "checkout"] as const) {
      expect(settingsContentResetKey({ ...checkoutSearch, [axis]: "different" }, 0)).not.toBe(
        original,
      );
    }
    expect(settingsContentResetKey(checkoutSearch, 1)).not.toBe(original);
  });
});
