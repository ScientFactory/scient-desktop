// @effect-diagnostics nodeBuiltinImport:off -- Static audit that the creation hook uses the Scient workspace sanitizer.
import * as NodeFS from "node:fs";

import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  QuickChatTaskRequiredError,
  resolveScientThreadStartTurnWorkspace,
  validateQuickChatCreation,
} from "./quickChatCreationValidation";

const creationHookSource = NodeFS.readFileSync(
  new URL("../threads/use-project-actions.ts", import.meta.url),
  "utf8",
);

describe("Quick Chat creation validation", () => {
  const environmentId = EnvironmentId.make("environment-local");

  it("returns a structured failure for an empty task", () => {
    const error = validateQuickChatCreation({ environmentId, initialMessageText: "  " });
    expect(error).toBeInstanceOf(QuickChatTaskRequiredError);
    expect(error).toMatchObject({
      _tag: "QuickChatTaskRequiredError",
      environmentId,
      message: "Enter a task before starting the thread.",
    });
  });

  it("accepts a non-empty task", () => {
    expect(validateQuickChatCreation({ environmentId, initialMessageText: "Explore this" })).toBe(
      null,
    );
  });
});

describe("Quick Chat start-turn workspace", () => {
  it("forces local workspace with no branch or worktree when there is no project", () => {
    expect(
      resolveScientThreadStartTurnWorkspace({
        hasProject: false,
        envMode: "worktree",
        branch: "main",
        worktreePath: "/tmp/worktree",
      }),
    ).toEqual({
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    });
  });

  it("keeps T3's project workspace fields when a project is selected", () => {
    expect(
      resolveScientThreadStartTurnWorkspace({
        hasProject: true,
        envMode: "worktree",
        branch: "main",
        worktreePath: "/tmp/worktree",
      }),
    ).toEqual({
      workspaceMode: "worktree",
      branch: "main",
      worktreePath: "/tmp/worktree",
    });
  });

  it("passes through a local project checkout without inventing a branch", () => {
    expect(
      resolveScientThreadStartTurnWorkspace({
        hasProject: true,
        envMode: "local",
        branch: null,
        worktreePath: null,
      }),
    ).toEqual({
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    });
  });

  it("is the mapping the mobile creation hook applies", () => {
    expect(creationHookSource).toContain("hasProject: input.project !== null");
    expect(creationHookSource).toContain("workspaceMode: workspace.workspaceMode");
    expect(creationHookSource).toContain("branch: workspace.branch");
    expect(creationHookSource).toContain("worktreePath: workspace.worktreePath");
    expect(creationHookSource).toContain("projectId: input.project?.id ?? null");
  });
});
