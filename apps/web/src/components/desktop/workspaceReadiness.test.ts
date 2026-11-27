import { describe, expect, it } from "vite-plus/test";
import { reportDesktopWorkspaceReady, workspaceReadiness } from "./workspaceReadiness";

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

  it("leaves an update restart's token to the restored workspace when Getting Started shows first", async () => {
    const token = { attemptId: "attempt-1", launchId: "launch-1" };
    let tokenRequests = 0;
    const reports: unknown[] = [];
    const bridge = {
      getRestartReadinessToken: async () => {
        tokenRequests += 1;
        return token;
      },
      reportWorkspaceReady: async (input: object) => {
        reports.push(input);
        return true;
      },
    };
    const startup = { reported: false };
    const report = (startupOnly: boolean, projectRestored: boolean) =>
      reportDesktopWorkspaceReady({
        bridge,
        startupOnly,
        projectRestored,
        startup,
        isCurrent: () => true,
      });

    await report(true, false);
    expect(tokenRequests).toBe(0);
    expect(reports).toEqual([{ projectRestored: false }]);

    // A second Getting Started report is not another startup.
    await report(true, false);
    expect(reports).toHaveLength(1);

    await report(false, true);
    expect(reports).toEqual([{ projectRestored: false }, { ...token, projectRestored: true }]);
  });
});
