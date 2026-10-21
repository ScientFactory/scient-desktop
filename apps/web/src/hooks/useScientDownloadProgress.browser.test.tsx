import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  act,
} from "../../test/render";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";
import { useScientDownloadProgress } from "./useScientDownloadProgress";

type Props = Parameters<typeof useScientDownloadProgress>[0];

const frames = new Map<number, FrameRequestCallback>();
function Probe({ _fixture, ...input }: Props & { _fixture: _Fixture }) {
  const value = useScientDownloadProgress(input);
  useLayoutEffect(() => {
    _fixture.publishResult(value);
  });
  return null;
}
async function update(_fixture: _Fixture, patch: Partial<Props>) {
  _fixture.props = { ..._fixture.props, ...patch };
  await act(
    async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} {..._fixture.props} />),
  );
}
async function step(_fixture: _Fixture, ms = 16) {
  _fixture.now += ms;
  const pending = [...frames.values()];
  frames.clear();
  await act(() => pending.forEach((callback) => callback(_fixture.now)));
}
async function _setupFixture0(_fixture: _Fixture) {
  _fixture.now = 0;
  _fixture.id = 0;
  _fixture.hidden = false;
  frames.clear();
  _fixture.events = document;

  vi.spyOn(performance, "now").mockImplementation(() => _fixture.now);
  _fixture.stack.use(
    _fixtureStubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++_fixture.id, callback);
      return _fixture.id;
    }),
  );
  _fixture.stack.use(
    _fixtureStubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key)),
  );
  vi.spyOn(document, "hidden", "get").mockImplementation(() => _fixture.hidden);
  _fixture.props = { status: "downloading", version: "1.2.0", percent: 0, reducedMotion: false };
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} {..._fixture.props} />);
  });
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

it("holds zero until a real reading, then smoothly catches up and stops", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  expect(_fixture.result).toBe(0);
  expect(frames.size).toBe(0);
  await update(_fixture, { percent: 30 });
  await step(_fixture);
  expect(_fixture.result).toBeGreaterThan(0);
  expect(_fixture.result).toBeLessThan(1);
  for (let i = 0; i < 300; i++) await step(_fixture);
  expect(_fixture.result).toBe(30);
  expect(frames.size).toBe(0);
});
it("retargets without snapping and honors downward corrections", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { percent: 30 });
  await step(_fixture);
  const before = _fixture.result;
  await update(_fixture, { percent: 60 });
  expect(_fixture.result).toBe(before);
  await step(_fixture);
  expect(_fixture.result).toBeGreaterThan(before!);
  expect(_fixture.result).toBeLessThan(60);
  await update(_fixture, { percent: 0.1 });
  expect(_fixture.result).toBe(0.1);
  expect(frames.size).toBe(0);
});
it.each(["available", "downloaded", "error"])(
  "cancels animation immediately on %s",
  async (status) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await update(_fixture, { percent: 60 });
    await step(_fixture);
    await update(_fixture, { status, percent: status === "downloaded" ? 100 : null });
    expect(_fixture.result).toBe(_fixture.props.percent);
    expect(frames.size).toBe(0);
    await update(_fixture, { status: "downloading", percent: 0 });
    expect(_fixture.result).toBe(0);
  },
);
it("resets for a different version and for missing readings", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { percent: 50 });
  await step(_fixture);
  await update(_fixture, { version: "1.3.0", percent: 20 });
  expect(_fixture.result).toBe(20);
  await update(_fixture, { percent: NaN });
  expect(_fixture.result).toBeNull();
  expect(frames.size).toBe(0);
  await update(_fixture, { percent: 40 });
  expect(_fixture.result).toBe(40);
});
it("uses direct progress with reduced motion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { percent: 50 });
  await step(_fixture);
  await update(_fixture, { reducedMotion: true });
  expect(_fixture.result).toBe(50);
  expect(frames.size).toBe(0);
});
it("synchronizes hidden windows and cancels stale frames on unmount", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { percent: 50 });
  await step(_fixture);
  _fixture.hidden = true;
  await act(() => _fixture.events.dispatchEvent(new Event("visibilitychange")));
  expect(_fixture.result).toBe(50);
  expect(frames.size).toBe(0);
  await update(_fixture, { percent: 60 });
  expect(_fixture.result).toBe(60);
  _fixture.hidden = false;
  await act(() => _fixture.events.dispatchEvent(new Event("visibilitychange")));
  await update(_fixture, { percent: 70 });
  const stale = [...frames.values()][0];
  await act(async () => await _fixture.root0.unmount());
  expect(frames.size).toBe(0);
  await act(() => stale?.(_fixture.now + 16));
  expect(frames.size).toBe(0);
});

function _createFixture() {
  let _published_result = undefined! as number | null;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    props: undefined! as Props,
    get result() {
      return _published_result;
    },
    publishResult(next: typeof _published_result) {
      _published_result = next;
      return next;
    },
    events: undefined! as EventTarget,
    hidden: undefined! as boolean,
    now: undefined! as number,
    id: undefined! as number,

    stack,
    cleanup,
    root0: undefined! as Screen,
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
