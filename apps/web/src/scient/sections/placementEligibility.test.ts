import { MessageId, ProviderInstanceId, RunId, TurnId } from "@t3tools/contracts";
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
// regression: 8ce9e24657 feat(sidebar): keep active threads near the top of sections
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
it("reads visits as the sidebar rows do: the server's when it tracks them", () => {
  const done = {
    ...base,
    latestCompletedAnswer: {
      turnId: TurnId.make("turn"),
      messageId: MessageId.make("answer"),
      completedAt: now,
    },
  };
  // Read on another client: this device's older visit no longer counts.
  expect(placementEligible({ ...done, lastVisitedAt: now }, earlier, now)).toBe(false);
  // Marked unread on the server, even though this device visited later.
  expect(placementEligible({ ...done, lastVisitedAt: earlier }, now, now)).toBe(true);
  // A server that tracks visits but holds none ignores this device's history.
  expect(placementEligible({ ...done, lastVisitedAt: null }, earlier, now)).toBe(false);
  // Servers without visit tracking keep using this device's visit.
  expect(placementEligible(done, now, now)).toBe(false);
  expect(placementEligible(done, earlier, now)).toBe(true);
  // Same for wake events.
  const woke = { ...base, snoozedUntil: now };
  expect(placementEligible({ ...woke, lastVisitedAt: now }, earlier, now)).toBe(false);
});

it("reads an older server's completed run as its answer, as the sidebar's unread dot does", () => {
  const { latestCompletedAnswer: _, ...legacy } = base;
  const completed = {
    ...legacy,
    latestRun: {
      runId: RunId.make("run"),
      assistantMessageId: null,
      status: "completed" as const,
      requestedAt: earlier,
      startedAt: earlier,
      completedAt: now,
    },
  } as unknown as Parameters<typeof placementEligible>[0];
  expect(placementEligible(completed, earlier, now)).toBe(true);
  expect(placementEligible(completed, now, now)).toBe(false);
});
