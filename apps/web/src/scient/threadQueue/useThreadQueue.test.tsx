import { EnvironmentId, ThreadId, type ScientThreadQueueSnapshot } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const queue = vi.hoisted(() => ({
  calls: [] as number[],
  respond: (_call: number): Promise<unknown> => Promise.reject(new Error("unavailable")),
}));

vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return { usePreparedConnection: () => Option.some({}) };
});
vi.mock("./client", () => ({
  listThreadQueue: () => {
    queue.calls.push(Date.now());
    return queue.respond(queue.calls.length);
  },
  controlThreadQueue: vi.fn(),
  enqueueThreadQueueItem: vi.fn(),
  removeThreadQueueItem: vi.fn(),
  reorderThreadQueue: vi.fn(),
  updateThreadQueueItem: vi.fn(),
}));

import { useThreadQueue } from "./useThreadQueue";

const threadId = ThreadId.make("thread-queue-poll");
const snapshot = (revision: number): ScientThreadQueueSnapshot => ({
  threadId,
  revision,
  items: [],
  paused: null,
});

function Probe() {
  useThreadQueue({
    environmentId: EnvironmentId.make("environment-queue-poll"),
    threadId,
    threadBusy: false,
  });
  return null;
}

let renderer: ReactTestRenderer | undefined;

async function mountAndAdvance(ms: number) {
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  return queue.calls;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  queue.calls = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("polls every second while the queue answers", async () => {
  queue.respond = (call) => Promise.resolve(snapshot(call));
  expect(await mountAndAdvance(3_000)).toEqual([0, 1_000, 2_000, 3_000]);
});

it("backs off while the queue keeps failing, up to 30 seconds", async () => {
  queue.respond = () => Promise.reject(new Error("unavailable"));
  expect(await mountAndAdvance(60_000)).toEqual([0, 2_000, 6_000, 14_000, 30_000, 60_000]);
});

it("returns to one-second polling after a success", async () => {
  queue.respond = (call) =>
    call <= 3 ? Promise.reject(new Error("unavailable")) : Promise.resolve(snapshot(call));
  expect(await mountAndAdvance(16_000)).toEqual([0, 2_000, 6_000, 14_000, 15_000, 16_000]);
});
