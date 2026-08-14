import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_FORK_WORKSPACE_CHOICES,
  scientForkDialogCopy,
} from "./ScientForkWorkspaceModeDialog";

describe("ScientForkWorkspaceModeDialog", () => {
  it("keeps the local and independent-worktree choices explicit", () => {
    expect(SCIENT_FORK_WORKSPACE_CHOICES).toEqual([
      {
        workspaceMode: "local",
        label: "Same workspace",
        description: "Continue with the current files",
      },
      {
        workspaceMode: "new-worktree",
        label: "Separate worktree",
        description: "Create an isolated copy of the project",
      },
    ]);
  });

  it("distinguishes latest-response forks from response-specific forks", () => {
    expect(scientForkDialogCopy("latest-response")).toEqual({
      title: "Fork latest response",
      description: "Create a new conversation from the latest response.",
    });
    expect(scientForkDialogCopy("this-response")).toEqual({
      title: "Fork this response",
      description: "Create a new conversation from this response.",
    });
    expect(scientForkDialogCopy("this-message")).toEqual({
      title: "Fork this message",
      description: "Create a new conversation from this message.",
    });
  });
});
