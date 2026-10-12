import { afterEach, expect, it, vi } from "vite-plus/test";
import { scheduleMathFieldMount } from "./mathFieldMountQueue";

const cancellations: Array<() => void> = [];
function job(callback: () => void, priority = 0) {
  const queued = scheduleMathFieldMount(callback, () => priority);
  cancellations.push(queued.cancel);
  return queued;
}
afterEach(() => {
  for (const cancel of cancellations.splice(0)) cancel();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("finishes prioritized preview work without waiting for an animation frame", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const completed: string[] = [];
  job(() => completed.push("outside viewport"), 0);
  job(() => completed.push("visible"), 2);
  await expect
    .poll(() => completed, { timeout: 180, interval: 10 })
    .toEqual(["visible", "outside viewport"]);
});

it("keeps cancellation local and flushes explicit editing exactly once", async () => {
  const completed: string[] = [];
  job(() => completed.push("canceled"), 3).cancel();
  const editing = job(() => completed.push("editing"), 4);
  job(() => completed.push("reading"));
  editing.flush();
  editing.flush();
  expect(completed).toEqual(["editing"]);
  await expect.poll(() => completed).toEqual(["editing", "reading"]);
});

it("defers preview work while input is pending and resumes afterward", async () => {
  const scheduling = (navigator as Navigator & { scheduling: { isInputPending(): boolean } })
    .scheduling;
  const pending = vi.spyOn(scheduling, "isInputPending").mockReturnValue(true);
  const completed: string[] = [];
  job(() => completed.push("reading"));
  await expect.poll(() => pending.mock.calls.length).toBeGreaterThan(0);
  expect(completed).toEqual([]);
  pending.mockReturnValue(false);
  await expect.poll(() => completed).toEqual(["reading"]);
});

it("also progresses without animation frames when the task scheduler is unavailable", async () => {
  vi.stubGlobal("scheduler", undefined);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const completed: string[] = [];
  job(() => completed.push("reading"));
  await expect.poll(() => completed, { timeout: 180, interval: 10 }).toEqual(["reading"]);
});

it("continues other previews after one scheduled view throws", async () => {
  const report = vi.spyOn(window, "reportError").mockImplementation(() => {});
  const failure = new Error("Synthetic preview failure");
  const completed: string[] = [];
  job(() => {
    throw failure;
  }, 2);
  job(() => completed.push("remaining"));
  await expect.poll(() => completed).toEqual(["remaining"]);
  await expect.poll(() => report.mock.calls.length).toBe(1);
  expect(report).toHaveBeenCalledWith(failure);
});
