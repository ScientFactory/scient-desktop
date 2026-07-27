import { afterEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  reserveProjectRemoval,
  resetProjectRemovalCoordinationForTests,
} from "./projectRemovalCoordination";
import { dispatchKanbanDraftThread } from "./kanbanDispatch";
import { createKanbanDraftTask } from "./kanbanTaskCreate";

describe("dispatchKanbanDraftThread project-removal turnstile", () => {
  afterEach(() => {
    resetProjectRemovalCoordinationForTests();
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  });

  it("keeps the draft and reports an error when the project is being removed", async () => {
    reserveProjectRemoval("project-kanban" as never);

    const result = await dispatchKanbanDraftThread({
      threadId: "thread-kanban" as never,
      projectId: "project-kanban" as never,
      thread: null,
      defaultProvider: "codex" as never,
      assistantDeliveryMode: "foreground" as never,
    });

    expect(result).toEqual({
      kind: "error",
      message: "This project is being removed. Your draft was kept.",
    });
  });

  it("does not create a standalone task after project removal is reserved", () => {
    const projectId = "project-kanban" as never;
    const scratchThreadId = "thread-kanban-scratch" as never;
    useComposerDraftStore.getState().setPrompt(scratchThreadId, "keep this task draft");
    reserveProjectRemoval(projectId);

    expect(() =>
      createKanbanDraftTask({
        projectId,
        prompt: "fallback prompt",
        sourceComposerThreadId: scratchThreadId,
        modelSelection: { provider: "codex", model: "gpt-5" } as never,
        runtimeMode: "full-access" as never,
        interactionMode: "default" as never,
        envMode: "local",
      }),
    ).toThrow("This project is being removed. Your draft was kept in the task composer.");

    expect(useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.prompt).toBe(
      "keep this task draft",
    );
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toEqual([]);
  });
});
