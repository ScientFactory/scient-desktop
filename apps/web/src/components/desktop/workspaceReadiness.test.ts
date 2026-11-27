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

const usable = { projectControlsVisible: true, composerUsable: true, windowUnlocked: true };

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
      reportWorkspaceSettled: async (input: object) => {
        reports.push({ settled: input });
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
        observe: () => usable,
        settle: async () => undefined,
      });

    await report(true, false);
    expect(tokenRequests).toBe(0);
    expect(reports).toEqual([{ projectRestored: false }]);

    // A second Getting Started report is not another startup.
    await report(true, false);
    expect(reports).toHaveLength(1);

    await report(false, true);
    expect(reports).toEqual([
      { projectRestored: false },
      { ...token, projectRestored: true, interaction: usable },
      { settled: { ...token, interaction: usable } },
    ]);
  });

  it("observes a completed restart's workspace at readiness and again once it settles", async () => {
    const token = { attemptId: "attempt-1", launchId: "launch-1" };
    const locked = { ...usable, composerUsable: false, windowUnlocked: false };
    const events: unknown[] = [];
    let observation = usable;
    let completes = true;
    const bridge = {
      getRestartReadinessToken: async () => token,
      reportWorkspaceReady: async (input: object) => {
        events.push({ ready: input });
        return completes;
      },
      reportWorkspaceSettled: async (input: object) => {
        events.push({ settled: input });
        return true;
      },
    };
    const report = () =>
      reportDesktopWorkspaceReady({
        bridge,
        startupOnly: false,
        projectRestored: true,
        startup: { reported: false },
        isCurrent: () => true,
        observe: () => observation,
        settle: async () => {
          events.push("settle");
          // A lock that appears only after readiness.
          observation = locked;
        },
      });

    await report();
    expect(events).toEqual([
      { ready: { ...token, projectRestored: true, interaction: usable } },
      "settle",
      { settled: { ...token, interaction: locked } },
    ]);

    // A report that completed no restart is not followed up.
    events.length = 0;
    completes = false;
    await report();
    expect(events).toEqual([{ ready: { ...token, projectRestored: true, interaction: locked } }]);
  });
});
