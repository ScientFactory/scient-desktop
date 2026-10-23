import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { createRef, useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";
import {
  END_CONTROL_SHOW_DELAY_MS,
  followModeAfterEndTransition,
  useTimelineEndControl,
} from "./useTimelineEndControl";

const onReachedEnd = vi.fn();
const onLeftEnd = vi.fn();
function Probe({
  _fixture,
  isAtEndRef,
}: { isAtEndRef: { current: boolean } } & { _fixture: _Fixture }) {
  const value = useTimelineEndControl({ isAtEndRef, onReachedEnd, onLeftEnd });
  useLayoutEffect(() => {
    _fixture.publishControl(value);
  });
  return null;
}
async function mount(_fixture: _Fixture) {
  const isAtEndRef = createRef<boolean>() as { current: boolean };
  isAtEndRef.current = true;
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} isAtEndRef={isAtEndRef} />);
  });
  return isAtEndRef;
}
async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());

  onReachedEnd.mockClear();
  onLeftEnd.mockClear();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

it("shows the control after its delay even while scroll and size events keep arriving", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await mount(_fixture);
  await act(() => _fixture.control.onIsAtEndChange(false));
  // Streaming keeps reporting "away from the end"; that must not restart the delay.
  for (let i = 0; i < 5; i++) {
    await act(() => {
      vi.advanceTimersByTime(40);
      _fixture.control.onIsAtEndChange(false);
    });
  }
  expect(_fixture.control.showScrollToBottom).toBe(true);
});

it("restores the composer only when the reader arrives at the end, not on every event there", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await mount(_fixture);
  await act(() => _fixture.control.onIsAtEndChange(false));
  await act(() => _fixture.control.onIsAtEndChange(true));
  await act(() => _fixture.control.onIsAtEndChange(true));
  await act(() => _fixture.control.onIsAtEndChange(true));
  expect(onReachedEnd).toHaveBeenCalledTimes(1);
  expect(_fixture.control.showScrollToBottom).toBe(false);
});

it("hides at once and clears the unread count on reaching the end", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await mount(_fixture);
  await act(() => _fixture.control.onIsAtEndChange(false));
  await act(() => {
    vi.advanceTimersByTime(END_CONTROL_SHOW_DELAY_MS + 1);
    _fixture.control.setUnreadBelowCount(2);
  });
  expect(_fixture.control.showScrollToBottom).toBe(true);
  await act(() => _fixture.control.onIsAtEndChange(true));
  expect(_fixture.control.showScrollToBottom).toBe(false);
  expect(_fixture.control.unreadBelowCount).toBe(0);
});

it("shows the control at once for a thread returned to mid-history", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const isAtEndRef = await mount(_fixture);
  await act(() => _fixture.control.resetForThread(false));
  expect(_fixture.control.showScrollToBottom).toBe(true);
  expect(isAtEndRef.current).toBe(false);
  // Its first "away" report is not a new transition, so nothing flickers.
  await act(() => _fixture.control.onIsAtEndChange(false));
  expect(_fixture.control.showScrollToBottom).toBe(true);
  await act(() => _fixture.control.resetForThread(true));
  expect(_fixture.control.showScrollToBottom).toBe(false);
});

it("shows the control when an answer grows past the screen after the reader was at the end", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await mount(_fixture);
  // At the end (as after a send's follow), then the answer grows below the
  // screen: the timeline reports leaving, with no scroll from the reader.
  await act(() => _fixture.control.onIsAtEndChange(true));
  await act(() => _fixture.control.onIsAtEndChange(false));
  await act(() => {
    vi.advanceTimersByTime(END_CONTROL_SHOW_DELAY_MS + 1);
    _fixture.control.setUnreadBelowCount(1);
  });
  expect(_fixture.control.showScrollToBottom).toBe(true);
  expect(_fixture.control.unreadBelowCount).toBe(1);
  expect(onLeftEnd).toHaveBeenCalledTimes(1);
});

it("reports each arrival and departure once, however many events repeat it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await mount(_fixture);
  for (const atEnd of [false, false, true, true, false, false]) {
    await act(() => _fixture.control.onIsAtEndChange(atEnd));
  }
  expect(onLeftEnd).toHaveBeenCalledTimes(2);
  expect(onReachedEnd).toHaveBeenCalledTimes(1);
});

it("changes the follow mode on reaching or leaving the end, except while a send is being placed", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  expect(followModeAfterEndTransition("free-scrolling", "reached")).toBe("following-end");
  expect(followModeAfterEndTransition("following-end", "left")).toBe("free-scrolling");
  // The placement owns the mode until it ends or the reader navigates.
  expect(followModeAfterEndTransition("anchoring-new-turn", "left")).toBeNull();
  expect(followModeAfterEndTransition("anchoring-new-turn", "reached")).toBeNull();
});

function _createFixture() {
  let _published_control = undefined! as ReturnType<typeof useTimelineEndControl>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get control() {
      return _published_control;
    },
    publishControl(next: typeof _published_control) {
      _published_control = next;
    },

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
