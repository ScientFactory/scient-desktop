import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveScientQuickChatMoveProgress } from "./moveState";

const projectId = ProjectId.make("project-target");

describe("Quick Chat move progress", () => {
  it("waits for the stopped projection before submitting exactly once", () => {
    expect(
      resolveScientQuickChatMoveProgress({
        pendingMove: { projectId, phase: "stopping" },
        sessionStatus: "ready",
        currentProjectId: null,
      }),
    ).toBeNull();
    expect(
      resolveScientQuickChatMoveProgress({
        pendingMove: { projectId, phase: "stopping" },
        sessionStatus: "stopped",
        currentProjectId: null,
      }),
    ).toBe("submit-move");
  });

  it("reports success only after the destination project is projected", () => {
    expect(
      resolveScientQuickChatMoveProgress({
        pendingMove: { projectId, phase: "awaiting-projection" },
        sessionStatus: "stopped",
        currentProjectId: null,
      }),
    ).toBeNull();
    expect(
      resolveScientQuickChatMoveProgress({
        pendingMove: { projectId, phase: "awaiting-projection" },
        sessionStatus: "stopped",
        currentProjectId: projectId,
      }),
    ).toBe("complete");
  });
});
