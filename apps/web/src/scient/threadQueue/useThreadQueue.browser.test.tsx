import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { EnvironmentId, ThreadId, type ScientThreadQueueSnapshot } from "@t3tools/contracts";
import { useEffect } from "react";

import { expect, it, vi } from "vite-plus/test";

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

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const queueView = useThreadQueue({
    environmentId: EnvironmentId.make("environment-queue-poll"),
    threadId,
    threadBusy: false,
  });
  useEffect(() => {
    _fixture.publishLatest(queueView);
  });
  return null;
}

async function mountAndAdvance(_fixture: _Fixture, ms: number) {
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  return queue.calls;
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());
  vi.setSystemTime(0);
  queue.calls = [];
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  _fixture.publishLatest(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

it("polls every second while the queue answers", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  queue.respond = (call) => Promise.resolve(snapshot(call));
  expect(await mountAndAdvance(_fixture, 3_000)).toEqual([0, 1_000, 2_000, 3_000]);
});

it("backs off while the queue keeps failing, up to 30 seconds", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  queue.respond = () => Promise.reject(new Error("unavailable"));
  expect(await mountAndAdvance(_fixture, 60_000)).toEqual([
    0, 2_000, 6_000, 14_000, 30_000, 60_000,
  ]);
});

it("returns to one-second polling after a success", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  queue.respond = (call) =>
    call <= 3 ? Promise.reject(new Error("unavailable")) : Promise.resolve(snapshot(call));
  expect(await mountAndAdvance(_fixture, 16_000)).toEqual([
    0, 2_000, 6_000, 14_000, 15_000, 16_000,
  ]);
});

it("resumes one-second polling after a successful explicit refresh during back-off", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  queue.respond = (call) =>
    call <= 5 ? Promise.reject(new Error("unavailable")) : Promise.resolve(snapshot(call));
  // Failures at 0, 2, 6, 14 and 30 s; the next timed poll would wait until 60 s.
  await mountAndAdvance(_fixture, 30_100);
  await act(async () => {
    await _fixture.latest?.refresh();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(queue.calls).toEqual([0, 2_000, 6_000, 14_000, 30_000, 30_100, 31_100]);
});

function _createFixture() {
  let _published_latest = undefined! as ReturnType<typeof useThreadQueue> | undefined;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get latest() {
      return _published_latest;
    },
    publishLatest(next: typeof _published_latest) {
      _published_latest = next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
