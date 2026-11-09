import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vitest";

import { summarizeSectionStatus } from "./sectionStatus";

const quiet = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestRun: {
    runId: "turn-1" as never,
    status: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  },
  lastVisitedAt: "2026-03-09T10:06:00.000Z",
  runtime: null,
};
const runtime = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-03-09T10:00:00.000Z",
};
const working = { ...quiet, runtime };
const monitoring = { ...quiet, runtime, blockedOnThreadWait: true };
const done = { ...quiet, lastVisitedAt: "2026-03-09T10:04:00.000Z" };
const needsYou = { ...quiet, hasPendingUserInput: true };

it("counts each state most urgent first, including waiting, which folders leave quiet", () => {
  expect(summarizeSectionStatus([quiet])).toEqual([]);
  expect(summarizeSectionStatus([monitoring, quiet])).toEqual([{ kind: "waiting", count: 1 }]);
  expect(summarizeSectionStatus([monitoring, working, done, working, needsYou])).toEqual([
    { kind: "attention", count: 1 },
    { kind: "done", count: 1 },
    { kind: "working", count: 2 },
    { kind: "waiting", count: 1 },
  ]);
});
