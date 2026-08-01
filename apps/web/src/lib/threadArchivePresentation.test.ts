import { describe, expect, it } from "vitest";

import {
  archivedThreadDeleteAccessibleLabel,
  archivedThreadDeleteActionLabel,
  archivedThreadDeleteProgressMessage,
  archivedThreadDeleteSuccessMessage,
  archivedWorktreeDeleteBlockedMessage,
  archivedWorktreeDeleteSuccessMessage,
  archivedThreadRestoreAccessibleLabel,
  archivedThreadRestoreActionLabel,
  archivedThreadRestoreProgressMessage,
  archivedThreadRestoreSuccessMessage,
  threadArchiveAccessibleLabel,
  threadArchiveActionLabel,
  threadArchiveToastTitle,
  threadFamilyConversationCountLabel,
} from "./threadArchivePresentation";

describe("thread archive presentation", () => {
  it("keeps leaf copy concise", () => {
    expect(threadArchiveActionLabel(1)).toBe("Archive");
    expect(threadArchiveAccessibleLabel(1)).toBe("Archive thread");
    expect(threadArchiveToastTitle(1)).toBe("Thread archived");
  });

  it("discloses conversation-family scope and count", () => {
    expect(threadArchiveActionLabel(3)).toBe("Archive family (3)");
    expect(threadArchiveAccessibleLabel(3)).toBe("Archive conversation family (3)");
    expect(threadArchiveToastTitle(3)).toBe("3 conversations archived");
  });

  it("describes archived leaf actions with their thread title", () => {
    expect(threadFamilyConversationCountLabel(1)).toBe("1 conversation");
    expect(archivedThreadRestoreActionLabel(1)).toBe("Restore");
    expect(archivedThreadDeleteActionLabel(1)).toBe("Delete");
    expect(archivedThreadRestoreAccessibleLabel("Main analysis", 1)).toBe(
      'Restore "Main analysis"',
    );
    expect(archivedThreadDeleteAccessibleLabel("Main analysis", 1)).toBe(
      'Permanently delete "Main analysis"',
    );
    expect(archivedThreadRestoreProgressMessage("Main analysis", 1)).toBe(
      'Restoring "Main analysis"...',
    );
    expect(archivedThreadRestoreSuccessMessage(1)).toBe("The thread was restored to the sidebar.");
    expect(archivedThreadDeleteProgressMessage("Main analysis", 1)).toBe(
      'Deleting "Main analysis"...',
    );
    expect(archivedThreadDeleteSuccessMessage(1)).toBe(
      "The archived thread was permanently removed.",
    );
  });

  it("discloses archived family scope in actions and feedback", () => {
    expect(threadFamilyConversationCountLabel(3)).toBe("3 conversations");
    expect(archivedThreadRestoreActionLabel(3)).toBe("Restore family (3)");
    expect(archivedThreadDeleteActionLabel(3)).toBe("Delete family (3)");
    expect(archivedThreadRestoreAccessibleLabel("Main analysis", 3)).toBe(
      'Restore "Main analysis" and its 2 sub-agent conversations',
    );
    expect(archivedThreadDeleteAccessibleLabel("Main analysis", 3)).toBe(
      'Permanently delete "Main analysis" and its 2 sub-agent conversations',
    );
    expect(archivedThreadRestoreProgressMessage("Main analysis", 3)).toBe(
      'Restoring 3 conversations from "Main analysis"...',
    );
    expect(archivedThreadRestoreSuccessMessage(3)).toBe(
      "3 conversations were restored to the sidebar.",
    );
    expect(archivedThreadDeleteProgressMessage("Main analysis", 3)).toBe(
      'Deleting 3 conversations from "Main analysis"...',
    );
    expect(archivedThreadDeleteSuccessMessage(3)).toBe(
      "3 archived conversations were permanently removed.",
    );
  });

  it("reports the actual safe worktree deletion scope and refused descendants", () => {
    expect(archivedWorktreeDeleteSuccessMessage("Feature worktree", 3)).toBe(
      "Feature worktree was removed and 3 archived conversations were deleted.",
    );
    expect(archivedWorktreeDeleteSuccessMessage("Feature worktree", 1)).toBe(
      "Feature worktree was removed and 1 archived conversation was deleted.",
    );
    expect(archivedWorktreeDeleteBlockedMessage("Feature worktree", 2)).toBe(
      "Could not safely delete Feature worktree. 2 descendant conversations fall outside the archived conversations linked to this worktree. Archive or relink them, then retry.",
    );
  });
});
