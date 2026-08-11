import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeScientThreadCreateTarget, validateScientGeneralChatMove } from "./Policy.ts";

const now = "2026-01-01T00:00:00.000Z";

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-general"),
    projectId: null,
    workspaceRoot: "/workspace/general",
    title: "General chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

const target = {
  id: ProjectId.make("project-target"),
  deletedAt: null,
} satisfies Pick<OrchestrationProject, "id" | "deletedAt">;

describe("Scient General Chat server policy", () => {
  it("normalizes General Chat to the environment workspace without project metadata", () => {
    expect(
      normalizeScientThreadCreateTarget({
        projectId: null,
        environmentWorkspaceRoot: "/workspace/environment",
      }),
    ).toEqual({
      workspaceRoot: "/workspace/environment",
      branch: null,
      worktreePath: null,
    });
  });

  it("keeps project-backed creation project-owned", () => {
    expect(
      normalizeScientThreadCreateTarget({
        projectId: ProjectId.make("project-target"),
        environmentWorkspaceRoot: "/workspace/environment",
      }),
    ).toEqual({ workspaceRoot: null });
  });

  it("accepts only a stopped, idle General Chat and active destination", () => {
    expect(
      validateScientGeneralChatMove({
        thread: thread(),
        target,
        hasQueuedTurnStart: false,
      }),
    ).toBeNull();
    expect(
      validateScientGeneralChatMove({
        thread: thread({
          session: {
            threadId: ThreadId.make("thread-general"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        }),
        target,
        hasQueuedTurnStart: false,
      }),
    ).toMatchObject({ code: "provider-active" });
    expect(
      validateScientGeneralChatMove({
        thread: thread(),
        target: { ...target, deletedAt: now },
        hasQueuedTurnStart: false,
      }),
    ).toMatchObject({ code: "destination-deleted" });
  });
});
