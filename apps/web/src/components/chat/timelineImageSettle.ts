// FILE: timelineImageSettle.ts
// Purpose: Schedules bounded live-tail corrections after an image changes transcript height.
// Layer: Web chat timeline behavior

export function scheduleTimelineImageSettleCorrections(input: {
  readonly isAtEnd: () => boolean;
  readonly scrollToEnd: () => void;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (id: number) => void;
  readonly setTimer: (callback: () => void, delay: number) => number;
  readonly clearTimer: (id: number) => void;
  readonly delays?: readonly number[];
}): () => void {
  let frameId: number | null = null;
  let timerIds: number[] = [];
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (frameId !== null) input.cancelFrame(frameId);
    for (const timerId of timerIds) input.clearTimer(timerId);
    frameId = null;
    timerIds = [];
  };
  const correctIfStillAtEnd = () => {
    if (cancelled) return;
    if (!input.isAtEnd()) {
      cancel();
      return;
    }
    input.scrollToEnd();
  };
  frameId = input.requestFrame(() => {
    frameId = null;
    correctIfStillAtEnd();
  });
  timerIds = (input.delays ?? [80, 180, 260]).map((delay) =>
    input.setTimer(correctIfStillAtEnd, delay),
  );
  return cancel;
}
