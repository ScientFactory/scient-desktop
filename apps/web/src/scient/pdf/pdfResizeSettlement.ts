interface PdfResizeFrameClock {
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (handle: number) => void;
}

export interface PdfResizeSettlement {
  readonly cancel: () => void;
  readonly schedule: () => void;
}

function browserFrameClock(): PdfResizeFrameClock {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/**
 * Runs expensive PDF layout only after the observed pane has stayed unchanged
 * across two paint frames. A continuing drag keeps replacing the pending work.
 */
export function createPdfResizeSettlement(
  onSettled: () => void,
  clock: PdfResizeFrameClock = browserFrameClock(),
): PdfResizeSettlement {
  let frame: number | null = null;
  let remainingStableFrames = 0;

  const cancel = () => {
    if (frame !== null) clock.cancel(frame);
    frame = null;
    remainingStableFrames = 0;
  };
  const runFrame = () => {
    frame = null;
    remainingStableFrames -= 1;
    if (remainingStableFrames > 0) {
      frame = clock.request(runFrame);
      return;
    }
    onSettled();
  };

  return {
    cancel,
    schedule: () => {
      cancel();
      remainingStableFrames = 2;
      frame = clock.request(runFrame);
    },
  };
}
