import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { expect, it } from "vitest";
import { placementEligible } from "./placementEligibility";
const now = "2026-10-02T12:00:00.000Z";
const earlier = "2026-10-02T10:00:00.000Z";
const base = {
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  backgroundLiveness: null,
  snoozedUntil: null,
  latestCompletedAnswer: null,
} as unknown as EnvironmentThreadShell;
it.each([
  { session: { status: "running" } },
  { session: { status: "starting" } },
  { session: { status: "error" } },
  { backgroundLiveness: "working" },
  { backgroundLiveness: "monitoring" },
  { hasPendingApprovals: true },
  { hasPendingUserInput: true },
])("uses existing attention predicates without status priority: %j", (patch) => {
  expect(placementEligible({ ...base, ...patch } as EnvironmentThreadShell, now, now)).toBe(true);
});
it("only unread successful answers and unread wake events qualify idle threads", () => {
  expect(placementEligible(base, earlier, now)).toBe(false);
  const done = {
    ...base,
    latestCompletedAnswer: { turnId: "turn", messageId: "answer", completedAt: now },
  } as EnvironmentThreadShell;
  expect(placementEligible(done, earlier, now)).toBe(true);
  expect(placementEligible(done, now, now)).toBe(false);
  const woke = { ...base, snoozedUntil: now };
  expect(placementEligible(woke, earlier, now)).toBe(true);
  expect(placementEligible(woke, now, now)).toBe(false);
});
