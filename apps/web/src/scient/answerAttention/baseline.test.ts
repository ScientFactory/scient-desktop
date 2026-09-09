// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { OrchestrationShellSnapshot } from "@t3tools/contracts";
import { snapshotBaseline } from "./baseline";
const before = "2026-09-09T09:00:00.000Z";
const after = "2026-09-09T10:00:00.000Z";
const snapshot = (updatedAt: string) =>
  ({ updatedAt, threads: [] }) as unknown as OrchestrationShellSnapshot;
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
it("persists the first live boundary across reloads without swallowing later completions", async () => {
  const initial = await import("./baseline");
  expect(initial.getOrCreateBaseline("test", snapshot(before))).toBe(before);
  vi.resetModules();
  const reloaded = await import("./baseline");
  expect(reloaded.useAnswerBaselines.getState().byEnvironment.test).toBe(before);
  expect(reloaded.getOrCreateBaseline("test", snapshot(after))).toBe(before);
});
it("handles corrupt storage and keeps environments independent", async () => {
  localStorage.setItem("scient:answer-attention-baselines:v1", "not json");
  const baseline = await import("./baseline");
  expect(baseline.getOrCreateBaseline("one", snapshot(before))).toBe(before);
  expect(baseline.getOrCreateBaseline("two", snapshot(after))).toBe(after);
});
it("uses the newest server completion if it is ahead of the projection timestamp", () => {
  expect(
    snapshotBaseline({
      ...snapshot(before),
      threads: [{ latestCompletedAnswer: { completedAt: after } }],
    } as unknown as OrchestrationShellSnapshot),
  ).toBe(after);
});
