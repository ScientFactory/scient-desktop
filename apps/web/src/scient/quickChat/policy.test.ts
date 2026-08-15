import { describe, expect, it } from "vite-plus/test";

import {
  buildScientThreadTerminalOpenInput,
  isScientQuickChatRightPanelKindAllowed,
  resolveScientQuickChatCreationEnvironment,
  resolveScientThreadTerminalTarget,
  shouldCloseSurfaceAfterScientQuickChatMove,
  shouldAssignScientQuickChatNewThreadShortcut,
  supportsScientQuickChatCapability,
} from "./policy";
import { EnvironmentId } from "@t3tools/contracts";

describe("Scient Quick Chat policy", () => {
  it("assigns chat.new to Quick Chat only when no project action owns it", () => {
    expect(
      shouldAssignScientQuickChatNewThreadShortcut({
        hasQuickChatTarget: true,
        hasProjectShortcutTarget: false,
      }),
    ).toBe(true);
    expect(
      shouldAssignScientQuickChatNewThreadShortcut({
        hasQuickChatTarget: true,
        hasProjectShortcutTarget: true,
      }),
    ).toBe(false);
    expect(
      shouldAssignScientQuickChatNewThreadShortcut({
        hasQuickChatTarget: false,
        hasProjectShortcutTarget: false,
      }),
    ).toBe(false);
  });

  it("creates Quick Chat in the active capable environment, then the primary fallback", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const legacy = EnvironmentId.make("legacy");

    expect(
      resolveScientQuickChatCreationEnvironment({
        activeEnvironmentId: remote,
        primaryEnvironmentId: local,
        capableEnvironmentIds: [local, remote],
      }),
    ).toBe(remote);
    expect(
      resolveScientQuickChatCreationEnvironment({
        activeEnvironmentId: legacy,
        primaryEnvironmentId: local,
        capableEnvironmentIds: [local, remote],
      }),
    ).toBe(local);
    expect(
      resolveScientQuickChatCreationEnvironment({
        activeEnvironmentId: null,
        primaryEnvironmentId: legacy,
        capableEnvironmentIds: [remote],
      }),
    ).toBe(remote);
    expect(
      resolveScientQuickChatCreationEnvironment({
        activeEnvironmentId: null,
        primaryEnvironmentId: null,
        capableEnvironmentIds: [],
      }),
    ).toBeNull();
  });

  it("requires a picker when several environments are capable and none is contextual", () => {
    expect(
      resolveScientQuickChatCreationEnvironment({
        activeEnvironmentId: null,
        primaryEnvironmentId: null,
        capableEnvironmentIds: [EnvironmentId.make("remote-a"), EnvironmentId.make("remote-b")],
      }),
    ).toBeNull();
  });

  it("allows workspace tools but denies every project authority", () => {
    expect(supportsScientQuickChatCapability("browser")).toBe(true);
    expect(supportsScientQuickChatCapability("files")).toBe(true);
    expect(supportsScientQuickChatCapability("pdfs")).toBe(true);
    expect(supportsScientQuickChatCapability("search")).toBe(true);
    expect(supportsScientQuickChatCapability("terminal")).toBe(true);
    expect(supportsScientQuickChatCapability("agents")).toBe(true);
    expect(supportsScientQuickChatCapability("moveToProject")).toBe(true);
    for (const denied of [
      "checkpoints",
      "diff",
      "git",
      "projectSettings",
      "pullRequests",
      "revert",
      "scripts",
      "worktrees",
    ] as const) {
      expect(supportsScientQuickChatCapability(denied)).toBe(false);
    }
  });

  it("applies the same capability contract to persisted panel surfaces", () => {
    expect(
      ["files", "file", "preview", "terminal", "agents"].every((kind) =>
        isScientQuickChatRightPanelKindAllowed(
          kind as "files" | "file" | "preview" | "terminal" | "agents",
        ),
      ),
    ).toBe(true);
    expect(isScientQuickChatRightPanelKindAllowed("diff")).toBe(false);
    expect(isScientQuickChatRightPanelKindAllowed("pull-request")).toBe(false);
    expect(isScientQuickChatRightPanelKindAllowed("scient")).toBe(false);
  });

  it("closes workspace-bound surfaces after moving but preserves browser and agents", () => {
    expect(
      ["file", "files", "terminal", "diff", "pull-request", "scient"].every((kind) =>
        shouldCloseSurfaceAfterScientQuickChatMove(
          kind as "file" | "files" | "terminal" | "diff" | "pull-request" | "scient",
        ),
      ),
    ).toBe(true);
    expect(shouldCloseSurfaceAfterScientQuickChatMove("preview")).toBe(false);
    expect(shouldCloseSurfaceAfterScientQuickChatMove("agents")).toBe(false);
  });

  it("keeps project terminal launch behavior unchanged", () => {
    expect(
      resolveScientThreadTerminalTarget({
        activeWorkspaceRoot: "/repo/worktree",
        projectWorkspaceRoot: "/repo",
        gitCwd: "/repo/worktree",
        worktreePath: "/repo/worktree",
      }),
    ).toEqual({
      cwd: "/repo/worktree",
      worktreePath: "/repo/worktree",
      env: {
        T3CODE_PROJECT_ROOT: "/repo",
        T3CODE_WORKTREE_PATH: "/repo/worktree",
      },
    });
  });

  it("opens Quick Chat terminals only at the authoritative workspace root", () => {
    const target = resolveScientThreadTerminalTarget({
      activeWorkspaceRoot: "/environment/root",
      projectWorkspaceRoot: null,
      gitCwd: null,
      worktreePath: "/stale/project/worktree",
    });
    expect(target).toEqual({
      cwd: "/environment/root",
      worktreePath: null,
      env: {},
    });
    if (target === null) throw new Error("Expected a Quick Chat terminal target");
    expect(
      buildScientThreadTerminalOpenInput({
        target,
        threadId: "thread-1",
        terminalId: "term-1",
      }),
    ).toEqual({
      threadId: "thread-1",
      terminalId: "term-1",
      cwd: "/environment/root",
      env: {},
    });
    expect(
      resolveScientThreadTerminalTarget({
        activeWorkspaceRoot: undefined,
        projectWorkspaceRoot: null,
        gitCwd: null,
        worktreePath: null,
      }),
    ).toBeNull();
  });
});
