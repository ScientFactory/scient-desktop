import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveScientGeneralChatMoveProgress } from "./moveState";

const projectId = ProjectId.make("project-target");

describe("General Chat move progress", () => {
  it("waits for the stopped projection before submitting exactly once", () => {
    expect(
      resolveScientGeneralChatMoveProgress({
        pendingMove: { projectId, phase: "stopping" },
        sessionStatus: "ready",
        currentProjectId: null,
      }),
    ).toBeNull();
    expect(
      resolveScientGeneralChatMoveProgress({
        pendingMove: { projectId, phase: "stopping" },
        sessionStatus: "stopped",
        currentProjectId: null,
      }),
    ).toBe("submit-move");
  });

  it("reports success only after the destination project is projected", () => {
    expect(
      resolveScientGeneralChatMoveProgress({
        pendingMove: { projectId, phase: "awaiting-projection" },
        sessionStatus: "stopped",
        currentProjectId: null,
      }),
    ).toBeNull();
    expect(
      resolveScientGeneralChatMoveProgress({
        pendingMove: { projectId, phase: "awaiting-projection" },
        sessionStatus: "stopped",
        currentProjectId: projectId,
      }),
    ).toBe("complete");
  });
});
