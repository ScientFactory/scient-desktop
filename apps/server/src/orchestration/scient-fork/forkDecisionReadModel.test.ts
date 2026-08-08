import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { withForkOriginDetail } from "./forkDecisionReadModel.ts";

const NOW = "2026-08-08T00:00:00.000Z";

function thread(id: string, messages: OrchestrationThread["messages"]): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

const readModel = (threads: OrchestrationReadModel["threads"]): OrchestrationReadModel => ({
  snapshotSequence: 4,
  projects: [],
  threads,
  updatedAt: NOW,
});

it("replaces an existing lightweight origin without moving other threads", () => {
  const shell = thread("origin", []);
  const other = thread("other", []);
  const detail = thread("origin", [
    {
      id: MessageId.make("message-1"),
      role: "user",
      text: "retained",
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);

  const hydrated = withForkOriginDetail(readModel([shell, other]), detail);
  expect(hydrated.threads).toEqual([detail, other]);
});

it("adds the authoritative origin when a lightweight bootstrap omitted it", () => {
  const other = thread("other", []);
  const detail = thread("origin", []);

  const hydrated = withForkOriginDetail(readModel([other]), detail);
  expect(hydrated.threads).toEqual([other, detail]);
});
