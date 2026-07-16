// FILE: ChatHeader.test.ts
// Purpose: Covers chat header presentation helpers that choose thread identity chrome.
// Layer: Component unit tests
// Depends on: ChatHeader pure helpers and Vitest assertions.

import { describe, expect, it } from "vitest";

import {
  resolveChatHeaderRightPanelToggleMode,
  resolveChatHeaderThreadIconKind,
} from "./ChatHeader";

describe("resolveChatHeaderThreadIconKind", () => {
  it("uses the terminal icon for terminal-first threads", () => {
    expect(resolveChatHeaderThreadIconKind("terminal", "New terminal")).toBe("terminal");
  });

  it("keeps provider branding for chat-first threads", () => {
    expect(resolveChatHeaderThreadIconKind("chat", "Fix auth flow")).toBe("provider");
  });

  it("hides provider branding for untouched new chat threads", () => {
    expect(resolveChatHeaderThreadIconKind("chat", "New thread")).toBe("none");
  });
});

describe("resolveChatHeaderRightPanelToggleMode", () => {
  it("keeps the Diff shortcut when Git is available and the dock is empty", () => {
    expect(
      resolveChatHeaderRightPanelToggleMode({
        isGitRepo: true,
        diffOpen: false,
        rightDockHasPanes: false,
        canToggleRightDock: true,
      }),
    ).toBe("diff");
  });

  it("reopens an existing non-Diff dock pane instead of replacing it with Diff", () => {
    expect(
      resolveChatHeaderRightPanelToggleMode({
        isGitRepo: true,
        diffOpen: false,
        rightDockHasPanes: true,
        canToggleRightDock: true,
      }),
    ).toBe("dock");
  });

  it("uses the dock control for a non-Git project", () => {
    expect(
      resolveChatHeaderRightPanelToggleMode({
        isGitRepo: false,
        diffOpen: false,
        rightDockHasPanes: false,
        canToggleRightDock: true,
      }),
    ).toBe("dock");
  });

  it("does not claim a dock toggle when the containing surface cannot provide one", () => {
    expect(
      resolveChatHeaderRightPanelToggleMode({
        isGitRepo: false,
        diffOpen: false,
        rightDockHasPanes: true,
        canToggleRightDock: false,
      }),
    ).toBe("diff");
  });
});
