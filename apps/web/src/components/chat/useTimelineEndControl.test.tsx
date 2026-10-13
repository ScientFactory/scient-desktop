import { act, createRef, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  END_CONTROL_SHOW_DELAY_MS,
  followModeAfterEndTransition,
  useTimelineEndControl,
} from "./useTimelineEndControl";

let control: ReturnType<typeof useTimelineEndControl>;
let renderer: ReactTestRenderer;
const onReachedEnd = vi.fn();
const onLeftEnd = vi.fn();
function Probe({ isAtEndRef }: { isAtEndRef: { current: boolean } }) {
  const value = useTimelineEndControl({ isAtEndRef, onReachedEnd, onLeftEnd });
  useLayoutEffect(() => {
    control = value;
  });
  return null;
}
function mount() {
  const isAtEndRef = createRef<boolean>() as { current: boolean };
  isAtEndRef.current = true;
  act(() => {
    renderer = create(<Probe isAtEndRef={isAtEndRef} />);
  });
  return isAtEndRef;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onReachedEnd.mockClear();
  onLeftEnd.mockClear();
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows the control after its delay even while scroll and size events keep arriving", () => {
  mount();
  act(() => control.onIsAtEndChange(false));
  // Streaming keeps reporting "away from the end"; that must not restart the delay.
  for (let i = 0; i < 5; i++) {
    act(() => {
      vi.advanceTimersByTime(40);
      control.onIsAtEndChange(false);
    });
  }
  expect(control.showScrollToBottom).toBe(true);
});

it("restores the composer only when the reader arrives at the end, not on every event there", () => {
  mount();
  act(() => control.onIsAtEndChange(false));
  act(() => control.onIsAtEndChange(true));
  act(() => control.onIsAtEndChange(true));
  act(() => control.onIsAtEndChange(true));
  expect(onReachedEnd).toHaveBeenCalledTimes(1);
  expect(control.showScrollToBottom).toBe(false);
});

it("hides at once and clears the unread count on reaching the end", () => {
  mount();
  act(() => control.onIsAtEndChange(false));
  act(() => {
    vi.advanceTimersByTime(END_CONTROL_SHOW_DELAY_MS + 1);
    control.setUnreadBelowCount(2);
  });
  expect(control.showScrollToBottom).toBe(true);
  act(() => control.onIsAtEndChange(true));
  expect(control.showScrollToBottom).toBe(false);
  expect(control.unreadBelowCount).toBe(0);
});

it("shows the control at once for a thread returned to mid-history", () => {
  const isAtEndRef = mount();
  act(() => control.resetForThread(false));
  expect(control.showScrollToBottom).toBe(true);
  expect(isAtEndRef.current).toBe(false);
  // Its first "away" report is not a new transition, so nothing flickers.
  act(() => control.onIsAtEndChange(false));
  expect(control.showScrollToBottom).toBe(true);
  act(() => control.resetForThread(true));
  expect(control.showScrollToBottom).toBe(false);
});

it("shows the control when an answer grows past the screen after the reader was at the end", () => {
  mount();
  // At the end (as after a send's follow), then the answer grows below the
  // screen: the timeline reports leaving, with no scroll from the reader.
  act(() => control.onIsAtEndChange(true));
  act(() => control.onIsAtEndChange(false));
  act(() => {
    vi.advanceTimersByTime(END_CONTROL_SHOW_DELAY_MS + 1);
    control.setUnreadBelowCount(1);
  });
  expect(control.showScrollToBottom).toBe(true);
  expect(control.unreadBelowCount).toBe(1);
  expect(onLeftEnd).toHaveBeenCalledTimes(1);
});

it("reports each arrival and departure once, however many events repeat it", () => {
  mount();
  for (const atEnd of [false, false, true, true, false, false]) {
    act(() => control.onIsAtEndChange(atEnd));
  }
  expect(onLeftEnd).toHaveBeenCalledTimes(2);
  expect(onReachedEnd).toHaveBeenCalledTimes(1);
});

it("changes the follow mode on reaching or leaving the end, except while a send is being placed", () => {
  expect(followModeAfterEndTransition("free-scrolling", "reached")).toBe("following-end");
  expect(followModeAfterEndTransition("following-end", "left")).toBe("free-scrolling");
  // The placement owns the mode until it ends or the reader navigates.
  expect(followModeAfterEndTransition("anchoring-new-turn", "left")).toBeNull();
  expect(followModeAfterEndTransition("anchoring-new-turn", "reached")).toBeNull();
});
