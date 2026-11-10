import { describe, expect, it } from "vitest";

import { computerControlPermissionDescription } from "./ComputerControlPermissions.logic";

const state = (granted: boolean, requested: boolean, waitingFor = 0) => ({
  granted,
  requested,
  waitingFor,
});

describe("computerControlPermissionDescription", () => {
  it("points to the top list before the user goes to the pane", () => {
    expect(computerControlPermissionDescription("screen-recording", state(false, false))).toContain(
      "Turn on Scient in the top list, not in System Audio Recording Only.",
    );
  });

  it("says plainly when screen access is still off after the pane was opened", () => {
    expect(computerControlPermissionDescription("screen-recording", state(false, true))).toMatch(
      /^Still off\. .*System Audio Recording Only does not let the agent see windows/u,
    );
  });

  it("says it waits for running threads before opening Screen Recording", () => {
    expect(computerControlPermissionDescription("screen-recording", state(false, true, 2))).toBe(
      "Opens System Settings once the 2 running threads finish: macOS may close Scient when you turn this on, which would stop them.",
    );
  });

  it("drops the hints once granted, and never adds them to Accessibility", () => {
    expect(computerControlPermissionDescription("screen-recording", state(true, true, 2))).toBe(
      "Lets the agent see the windows it works in.",
    );
    expect(computerControlPermissionDescription("accessibility", state(false, true, 2))).toBe(
      "Lets the agent read windows and click and type in them.",
    );
  });
});
