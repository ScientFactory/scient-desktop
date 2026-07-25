import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  startContainerChat,
  startFreshChatForActiveSurface,
  type StartContainerChatResult,
} from "./startContainerChat";
import { draftNavigationSlotKey, runDraftNavigationOnce } from "./stagedDraftNavigation";

const paths = {
  homeDir: "/Users/tester",
  chatWorkspaceRoot: "/Users/tester/Documents/Synara/Chats",
  studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
};

function successfulHandler() {
  return vi.fn(async (): Promise<StartContainerChatResult> => ({ ok: true, threadId: null }));
}

describe("startFreshChatForActiveSurface", () => {
  it("keeps the global New chat action in Studio", async () => {
    const handleNewChat = successfulHandler();
    const handleNewStudioChat = successfulHandler();

    await startFreshChatForActiveSurface({
      activeProject: {
        kind: "studio",
        cwd: "/Users/tester/Documents/Synara/Studio",
      },
      isStudioRoute: false,
      paths,
      handleNewChat,
      handleNewStudioChat,
    });

    expect(handleNewStudioChat).toHaveBeenCalledOnce();
    expect(handleNewStudioChat).toHaveBeenCalledWith({ fresh: true });
    expect(handleNewChat).not.toHaveBeenCalled();
  });

  it("keeps the global New chat action on the Studio landing route", async () => {
    const handleNewChat = successfulHandler();
    const handleNewStudioChat = successfulHandler();

    await startFreshChatForActiveSurface({
      activeProject: null,
      isStudioRoute: true,
      paths,
      handleNewChat,
      handleNewStudioChat,
    });

    expect(handleNewStudioChat).toHaveBeenCalledOnce();
    expect(handleNewChat).not.toHaveBeenCalled();
  });

  it("keeps the global New chat action in Projects for ordinary or missing projects", async () => {
    for (const activeProject of [
      { kind: "project" as const, cwd: "/Users/tester/Developer/app" },
      null,
    ]) {
      const handleNewChat = successfulHandler();
      const handleNewStudioChat = successfulHandler();

      await startFreshChatForActiveSurface({
        activeProject,
        isStudioRoute: false,
        paths,
        handleNewChat,
        handleNewStudioChat,
      });

      expect(handleNewChat).toHaveBeenCalledOnce();
      expect(handleNewChat).toHaveBeenCalledWith({ fresh: true });
      expect(handleNewStudioChat).not.toHaveBeenCalled();
    }
  });
});

describe("startContainerChat", () => {
  it("keeps reuse-eligible container chats in the local container workspace", async () => {
    const projectId = ProjectId.makeUnsafe("project-container");
    const threadId = ThreadId.makeUnsafe("thread-container");
    const handleNewThread = vi.fn(async () => threadId);

    await expect(
      startContainerChat({
        ensureProjectId: async () => projectId,
        handleNewThread,
        navigationTargetKey: "studio-chat",
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });
    expect(handleNewThread).toHaveBeenCalledWith(
      projectId,
      { workspace: { kind: "local-container" } },
      undefined,
      expect.objectContaining({
        isCurrent: expect.any(Function),
        routeToken: expect.any(String),
      }),
    );
  });

  it("returns the created thread so callers can attach context deterministically", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");

    await expect(
      startContainerChat({
        ensureProjectId: async () => projectId,
        handleNewThread: async () => threadId,
        navigationTargetKey: "home-chat",
        fresh: true,
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });
  });

  it("does not let delayed container resolution retake ownership from a later intent", async () => {
    const projectId = ProjectId.makeUnsafe("project-delayed-container");
    let resolveProject!: (value: ProjectId) => void;
    const ensuredProject = new Promise<ProjectId>((resolve) => {
      resolveProject = resolve;
    });
    const handleNewThread = vi.fn(async () => ThreadId.makeUnsafe("thread-stale-container"));

    const delayedContainer = startContainerChat({
      ensureProjectId: () => ensuredProject,
      handleNewThread,
      navigationTargetKey: "home-chat-delayed",
      fresh: true,
      errorLabel: "failed",
    });
    await Promise.resolve();

    const laterIntent = runDraftNavigationOnce(
      draftNavigationSlotKey(),
      "project-b-terminal",
      async (ownership) => (ownership.isCurrent() ? "later" : "superseded"),
    );
    await expect(laterIntent).resolves.toBe("later");
    resolveProject(projectId);

    await expect(delayedContainer).resolves.toEqual({ ok: true, threadId: null });
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
