import { expect, it, vi } from "vite-plus/test";
import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { snapshotBaseline } from "./baseline";
const before = "2026-09-09T09:00:00.000Z";
const after = "2026-09-09T10:00:00.000Z";
const snapshot = (updatedAt: string) =>
  ({ threads: [{ updatedAt }], archivedThreads: [] }) as unknown as OrchestrationV2ShellSnapshot;
async function _setupFixture0(_fixture: _Fixture) {
  localStorage.clear();
  vi.resetModules();
}
it("persists the first live boundary across reloads without swallowing later completions", async () => {
  await using _fixture = _createFixture();
  await _setupFixture0(_fixture);

  const initial = await import("./baseline");
  expect(initial.getOrCreateBaseline("test", snapshot(before))).toBe(before);
  vi.resetModules();
  const reloaded = await import("./baseline");
  expect(reloaded.useAnswerBaselines.getState().byEnvironment.test).toBe(before);
  expect(reloaded.getOrCreateBaseline("test", snapshot(after))).toBe(before);
});
it("handles corrupt storage and keeps environments independent", async () => {
  await using _fixture = _createFixture();
  await _setupFixture0(_fixture);

  localStorage.setItem("scient:answer-attention-baselines:v1", "not json");
  const baseline = await import("./baseline");
  expect(baseline.getOrCreateBaseline("one", snapshot(before))).toBe(before);
  expect(baseline.getOrCreateBaseline("two", snapshot(after))).toBe(after);
});
it("uses the newest server completion if it is ahead of the projection timestamp", async () => {
  await using _fixture = _createFixture();
  await _setupFixture0(_fixture);

  expect(
    snapshotBaseline({
      ...snapshot(before),
      threads: [{ updatedAt: before, latestCompletedAnswer: { completedAt: after } }],
    } as unknown as OrchestrationV2ShellSnapshot),
  ).toBe(after);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
