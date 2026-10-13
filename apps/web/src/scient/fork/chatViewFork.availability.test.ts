import { describe, expect, it } from "vite-plus/test";

import { forkWorktreeAvailabilityFromOptions } from "./chatViewFork";

describe("forkWorktreeAvailabilityFromOptions", () => {
  it("offers a new worktree whenever the server can build one", () => {
    expect(forkWorktreeAvailabilityFromOptions({ newWorktree: true }, true)).toEqual({
      available: true,
    });
  });

  it("names a missing checkpoint for a finished fork point", () => {
    expect(forkWorktreeAvailabilityFromOptions({ newWorktree: false }, false)).toEqual({
      available: false,
      reason: "no-checkpoint",
    });
  });

  it("names the removed worktree, not Git, for a running fork whose worktree is gone", () => {
    const notice = "The original worktree was removed, so this fork works in the project folder.";
    expect(
      forkWorktreeAvailabilityFromOptions({ newWorktree: false, workspaceNotice: notice }, true),
    ).toEqual({ available: false, reason: "worktree-removed" });
    expect(forkWorktreeAvailabilityFromOptions({ newWorktree: false }, true)).toEqual({
      available: false,
      reason: "no-git-repository",
    });
  });
});
