import { describe, expect, it } from "vite-plus/test";
import { workspaceReadiness } from "./workspaceReadiness";

const ready = {
  initialized: true,
  settingsHydrated: true,
  navigating: false,
  localEnvironment: true,
  connected: true,
  liveSnapshot: true,
};

describe("desktop workspace readiness", () => {
  it("requires a committed usable local workspace rather than a renderer or cached snapshot", () => {
    expect(workspaceReadiness(ready)).toBe(true);
    expect(workspaceReadiness({ ...ready, initialized: false })).toBe(false);
    expect(workspaceReadiness({ ...ready, settingsHydrated: false })).toBe(false);
    expect(workspaceReadiness({ ...ready, navigating: true })).toBe(false);
    expect(workspaceReadiness({ ...ready, localEnvironment: false })).toBe(false);
    expect(workspaceReadiness({ ...ready, connected: false })).toBe(false);
    expect(workspaceReadiness({ ...ready, liveSnapshot: false })).toBe(false);
  });
});
