import { describe, expect, it } from "vite-plus/test";

import {
  resolveScientForkSubmission,
  scientForkDialogTitle,
} from "./ScientForkWorkspaceModeDialog";

const WORKTREE_AVAILABLE = { available: true } as const;
const WORKTREE_UNAVAILABLE = { available: false, reason: "no-checkpoint" } as const;

function resolve(input: {
  readonly titleDraft?: string;
  readonly proposedTitle?: string;
  readonly titleOverrideSupported?: boolean;
  readonly newWorktree?: boolean;
  readonly worktreeAvailability?: Parameters<
    typeof resolveScientForkSubmission
  >[0]["worktreeAvailability"];
}) {
  return resolveScientForkSubmission({
    titleDraft: input.titleDraft ?? "Origin conversation (2)",
    proposedTitle: input.proposedTitle ?? "Origin conversation (2)",
    titleOverrideSupported: input.titleOverrideSupported ?? true,
    newWorktree: input.newWorktree ?? false,
    worktreeAvailability: input.worktreeAvailability ?? WORKTREE_AVAILABLE,
  });
}

describe("scientForkDialogTitle", () => {
  it("gives every fork source a complete title", () => {
    expect(scientForkDialogTitle("latest-response")).toBe("Fork this chat");
    expect(scientForkDialogTitle("this-response")).toBe("Fork from this response");
    expect(scientForkDialogTitle("this-message")).toBe("Fork and edit this message");
    expect(scientForkDialogTitle("switch-provider")).toBe("Fork to switch provider");
    expect(scientForkDialogTitle("running-turn")).toBe("Fork with work in progress");
  });
});

describe("resolveScientForkSubmission", () => {
  it("leaves an untouched proposal under server allocation", () => {
    expect(resolve({})).toEqual({
      ok: true,
      confirmation: { workspaceMode: "local" },
    });
  });

  it("treats surrounding whitespace as an untouched proposal", () => {
    expect(resolve({ titleDraft: "  Origin conversation (2)  " })).toEqual({
      ok: true,
      confirmation: { workspaceMode: "local" },
    });
  });

  it("sends a trimmed title only when the user changes the proposal", () => {
    expect(resolve({ titleDraft: "  My custom fork  " })).toEqual({
      ok: true,
      confirmation: { workspaceMode: "local", titleOverride: "My custom fork" },
    });
  });

  it("rejects a blank title", () => {
    expect(resolve({ titleDraft: "   " })).toEqual({ ok: false });
  });

  it("requests a new worktree only when selected", () => {
    expect(resolve({ newWorktree: true })).toEqual({
      ok: true,
      confirmation: { workspaceMode: "new-worktree" },
    });
    expect(resolve({ newWorktree: false })).toEqual({
      ok: true,
      confirmation: { workspaceMode: "local" },
    });
  });

  it("never silently substitutes the current workspace for a requested worktree", () => {
    expect(resolve({ newWorktree: true, worktreeAvailability: WORKTREE_UNAVAILABLE })).toEqual({
      ok: false,
    });
  });

  it("never sends a title override to an older server", () => {
    expect(resolve({ titleDraft: "My custom fork", titleOverrideSupported: false })).toEqual({
      ok: true,
      confirmation: { workspaceMode: "local" },
    });
  });
});
