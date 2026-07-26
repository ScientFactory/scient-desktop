import { afterEach, describe, expect, it } from "vitest";

import {
  reserveProjectRemoval,
  resetProjectRemovalCoordinationForTests,
} from "./projectRemovalCoordination";
import { dispatchKanbanDraftThread } from "./kanbanDispatch";

describe("dispatchKanbanDraftThread project-removal turnstile", () => {
  afterEach(() => resetProjectRemovalCoordinationForTests());

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
});
