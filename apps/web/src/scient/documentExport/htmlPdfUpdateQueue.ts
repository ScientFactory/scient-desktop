export interface HtmlPdfUpdateQueue {
  readonly schedule: (manual: boolean, delayMs?: number) => void;
  readonly dispose: () => void;
}

export function createHtmlPdfUpdateQueue(
  run: (manual: boolean) => Promise<void>,
): HtmlPdfUpdateQueue {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let pendingManual = false;
  let running = false;
  let rerun = false;
  let rerunManual = false;
  let disposed = false;

  const runOnce = async (manual: boolean) => {
    if (disposed) return;
    if (running) {
      rerun = true;
      rerunManual ||= manual;
      return;
    }

    running = true;
    try {
      await run(manual);
    } finally {
      running = false;
      if (!disposed && rerun) {
        const nextManual = rerunManual;
        rerun = false;
        rerunManual = false;
        void runOnce(nextManual);
      }
    }
  };

  return {
    schedule: (manual, delayMs = 300) => {
      if (disposed) return;
      if (running) {
        rerun = true;
        rerunManual ||= manual;
        return;
      }
      pendingManual ||= manual;
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(
        () => {
          timer = null;
          const nextManual = pendingManual;
          pendingManual = false;
          void runOnce(nextManual);
        },
        pendingManual ? 0 : delayMs,
      );
    },
    dispose: () => {
      disposed = true;
      pendingManual = false;
      rerun = false;
      rerunManual = false;
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = null;
    },
  };
}
