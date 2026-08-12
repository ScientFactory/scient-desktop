import { describe, expect, it } from "vite-plus/test";

import {
  buildScientThreadTerminalOpenInput,
  isScientGeneralChatRightPanelKindAllowed,
  resolveScientGeneralChatCreationEnvironment,
  resolveScientThreadTerminalTarget,
  shouldCloseSurfaceAfterScientGeneralChatMove,
  shouldAssignScientGeneralChatNewThreadShortcut,
  supportsScientGeneralChatCapability,
} from "./policy";
import { EnvironmentId } from "@t3tools/contracts";

describe("Scient General Chat policy", () => {
  it("assigns chat.new to General Chat only when no project action owns it", () => {
    expect(
      shouldAssignScientGeneralChatNewThreadShortcut({
        hasGeneralChatTarget: true,
        hasProjectShortcutTarget: false,
      }),
    ).toBe(true);
    expect(
      shouldAssignScientGeneralChatNewThreadShortcut({
        hasGeneralChatTarget: true,
        hasProjectShortcutTarget: true,
      }),
    ).toBe(false);
    expect(
      shouldAssignScientGeneralChatNewThreadShortcut({
        hasGeneralChatTarget: false,
        hasProjectShortcutTarget: false,
      }),
    ).toBe(false);
  });

  it("creates General Chat in the active capable environment, then the primary fallback", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const legacy = EnvironmentId.make("legacy");

    expect(
      resolveScientGeneralChatCreationEnvironment({
        activeEnvironmentId: remote,
        primaryEnvironmentId: local,
        capableEnvironmentIds: [local, remote],
      }),
    ).toBe(remote);
    expect(
      resolveScientGeneralChatCreationEnvironment({
        activeEnvironmentId: legacy,
        primaryEnvironmentId: local,
        capableEnvironmentIds: [local, remote],
      }),
    ).toBe(local);
    expect(
      resolveScientGeneralChatCreationEnvironment({
        activeEnvironmentId: null,
        primaryEnvironmentId: legacy,
        capableEnvironmentIds: [remote],
      }),
    ).toBe(remote);
    expect(
      resolveScientGeneralChatCreationEnvironment({
        activeEnvironmentId: null,
        primaryEnvironmentId: null,
        capableEnvironmentIds: [],
      }),
    ).toBeNull();
  });

  it("requires a picker when several environments are capable and none is contextual", () => {
    expect(
      resolveScientGeneralChatCreationEnvironment({
        activeEnvironmentId: null,
        primaryEnvironmentId: null,
        capableEnvironmentIds: [EnvironmentId.make("remote-a"), EnvironmentId.make("remote-b")],
      }),
    ).toBeNull();
  });

  it("allows workspace tools but denies every project authority", () => {
    expect(supportsScientGeneralChatCapability("browser")).toBe(true);
    expect(supportsScientGeneralChatCapability("files")).toBe(true);
    expect(supportsScientGeneralChatCapability("pdfs")).toBe(true);
    expect(supportsScientGeneralChatCapability("search")).toBe(true);
    expect(supportsScientGeneralChatCapability("terminal")).toBe(true);
    expect(supportsScientGeneralChatCapability("agents")).toBe(true);
    expect(supportsScientGeneralChatCapability("moveToProject")).toBe(true);
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
      expect(supportsScientGeneralChatCapability(denied)).toBe(false);
    }
  });

  it("applies the same capability contract to persisted panel surfaces", () => {
    expect(
      ["files", "file", "preview", "terminal", "agents"].every((kind) =>
        isScientGeneralChatRightPanelKindAllowed(
          kind as "files" | "file" | "preview" | "terminal" | "agents",
        ),
      ),
    ).toBe(true);
    expect(isScientGeneralChatRightPanelKindAllowed("diff")).toBe(false);
    expect(isScientGeneralChatRightPanelKindAllowed("pull-request")).toBe(false);
    expect(isScientGeneralChatRightPanelKindAllowed("scient")).toBe(false);
  });

  it("closes workspace-bound surfaces after moving but preserves browser and agents", () => {
    expect(
      ["file", "files", "terminal", "diff", "pull-request", "scient"].every((kind) =>
        shouldCloseSurfaceAfterScientGeneralChatMove(
          kind as "file" | "files" | "terminal" | "diff" | "pull-request" | "scient",
        ),
      ),
    ).toBe(true);
    expect(shouldCloseSurfaceAfterScientGeneralChatMove("preview")).toBe(false);
    expect(shouldCloseSurfaceAfterScientGeneralChatMove("agents")).toBe(false);
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

  it("opens General Chat terminals only at the authoritative workspace root", () => {
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
    if (target === null) throw new Error("Expected a General Chat terminal target");
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
