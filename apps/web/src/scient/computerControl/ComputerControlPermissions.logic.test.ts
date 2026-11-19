import { describe, expect, it } from "vitest";

import { computerControlPermissionDescription } from "./ComputerControlPermissions.logic";

const state = (granted: boolean, requested: boolean) => ({ granted, requested });

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

  it("drops the hints once granted, and never adds them to Accessibility", () => {
    expect(computerControlPermissionDescription("screen-recording", state(true, true))).toBe(
      "Lets the agent see the windows it works in.",
    );
    expect(computerControlPermissionDescription("accessibility", state(false, true))).toBe(
      "Lets the agent read windows and click and type in them.",
    );
  });
});
