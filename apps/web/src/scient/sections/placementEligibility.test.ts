import { MessageId, ProviderInstanceId, TurnId } from "@t3tools/contracts";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { expect, it } from "vitest";
import { placementEligible } from "./placementEligibility";
const now = "2026-10-02T12:00:00.000Z";
const earlier = "2026-10-02T10:00:00.000Z";
const base = {
  runtime: null,
  latestRun: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  snoozedUntil: null,
  snoozedAt: null,
  latestCompletedAnswer: null,
} satisfies Parameters<typeof placementEligible>[0];
const runtime = (status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary => ({
  status,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: status === "failed" ? "Provider failure" : null,
  updatedAt: now,
});
it.each([
  { runtime: runtime("running") },
  { runtime: runtime("starting") },
  { runtime: runtime("failed") },
  { runtime: runtime("waiting") },
  { runtime: runtime("idle") },
  { hasPendingApprovals: true },
  { hasPendingUserInput: true },
])("uses existing attention predicates without status priority: %j", (patch) => {
  expect(placementEligible({ ...base, ...patch }, now, now)).toBe(true);
});
it("only unread successful answers and unread wake events qualify idle threads", () => {
  expect(placementEligible(base, earlier, now)).toBe(false);
  const done = {
    ...base,
    latestCompletedAnswer: {
      turnId: TurnId.make("turn"),
      messageId: MessageId.make("answer"),
      completedAt: now,
    },
  };
  expect(placementEligible(done, earlier, now)).toBe(true);
  expect(placementEligible(done, now, now)).toBe(false);
  const woke = { ...base, snoozedUntil: now };
  expect(placementEligible(woke, earlier, now)).toBe(true);
  expect(placementEligible(woke, now, now)).toBe(false);
});
