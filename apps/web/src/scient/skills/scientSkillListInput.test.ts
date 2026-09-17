import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveScientSkillListInput } from "./scientSkillListInput";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

describe("resolveScientSkillListInput", () => {
  it("uses project context without a provisional thread ID for drafts", () => {
    expect(resolveScientSkillListInput({ routeKind: "draft", threadId, projectId })).toEqual({
      projectId,
    });
  });

  it("uses the authoritative thread and matching project for server routes", () => {
    expect(resolveScientSkillListInput({ routeKind: "server", threadId, projectId })).toEqual({
      threadId,
      projectId,
    });
  });

  it("supports projectless drafts and server routes before thread data loads", () => {
    expect(resolveScientSkillListInput({ routeKind: "draft", threadId, projectId: null })).toEqual(
      {},
    );
    expect(resolveScientSkillListInput({ routeKind: "server", threadId: null, projectId })).toEqual(
      { projectId },
    );
  });
});
