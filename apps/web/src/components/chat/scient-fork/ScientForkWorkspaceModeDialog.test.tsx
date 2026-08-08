import { describe, expect, it } from "vite-plus/test";

import { SCIENT_FORK_WORKSPACE_CHOICES } from "./ScientForkWorkspaceModeDialog";

describe("ScientForkWorkspaceModeDialog", () => {
  it("keeps the local and independent-worktree choices explicit", () => {
    expect(SCIENT_FORK_WORKSPACE_CHOICES).toEqual([
      { workspaceMode: "local", label: "Use same workspace" },
      { workspaceMode: "new-worktree", label: "Create independent worktree" },
    ]);
  });
});
