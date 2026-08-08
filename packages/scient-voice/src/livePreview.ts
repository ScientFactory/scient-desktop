// @effect-diagnostics globalDate:off - pure timing loop, no Effect runtime; `now` defaults to Date.now.
// Runs one-at-a-time local transcription snapshots while microphone capture
// continues, so the composer can show a provisional transcript that keeps
// firming up as the user speaks.
//
// Lifted from the old app's `liveVoicePreview.ts`. Design preserved:
//   - preview requests are strictly sequential (single-flight); a slower
//     machine produces fewer updates instead of piling Whisper work behind
//     Stop/Send,
//   - the cadence backs off as the clip grows to avoid quadratic CPU cost,
//   - snapshots stop past a hard duration cap (the authoritative full pass runs
//     on Stop/Send), and
//   - every failure is swallowed: preview is opportunistic and must never break
//     the final transcription path.
//
// Everything impure (audio capture, transcription, timers, the clock) is
// injected, so the loop is pure and deterministically testable.

export const DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS = 1_800;
export const DEFAULT_LIVE_PREVIEW_INTERVAL_MS = 2_500;
export const DEFAULT_LIVE_PREVIEW_MAX_INTERVAL_MS = 8_000;
export const DEFAULT_LIVE_PREVIEW_MAX_DURATION_MS = 30_000;
export const DEFAULT_LIVE_PREVIEW_MIN_DURATION_MS = 1_000;

/** A single provisional snapshot: the full transcript so far plus its length. */
export interface LiveVoiceSnapshot {
  readonly text: string;
  readonly durationMs: number;
}

/** Injectable timer/clock surface, so tests can drive a fake clock. */
export interface LivePreviewTimers {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
  readonly now: () => number;
}

/** Tunable cadence. All fields default to the `DEFAULT_LIVE_PREVIEW_*` constants. */
export interface LivePreviewTiming {
  readonly initialDelayMs: number;
  readonly intervalMs: number;
  readonly maxIntervalMs: number;
  readonly maxDurationMs: number;
  readonly minDurationMs: number;
}

export interface LiveVoicePreviewOptions {
  /**
   * Capture the current growing buffer and transcribe it offline. Resolves
   * `null` when there is nothing worth previewing yet. Must honor `signal`:
   * aborting a session aborts the in-flight snapshot.
   */
  readonly transcribeSnapshot: (signal: AbortSignal) => Promise<LiveVoiceSnapshot | null>;
  /** Current recording length in milliseconds. */
  readonly getRecordingDurationMs: () => number;
  /** Called with the FULL provisional transcript each snapshot (replace, not append). */
  readonly onPreview: (text: string) => void;
  /** Optional failure hook. Defaults to swallowing the error. */
  readonly onError?: (error: unknown) => void;
  /** Optional timer/clock injection (defaults to the host globals). */
  readonly timers?: LivePreviewTimers;
  /** Optional cadence overrides (defaults to the `DEFAULT_LIVE_PREVIEW_*` constants). */
  readonly timing?: Partial<LivePreviewTiming>;
}

const DEFAULT_TIMERS: LivePreviewTimers = {
  setTimeout,
  clearTimeout,
  now: () => Date.now(),
};

/**
 * Preview requests are deliberately sequential. A slower machine therefore
 * produces fewer updates instead of accumulating Whisper work behind Stop/Send.
 */
export class LiveVoicePreviewSession {
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;

  /** Begin a preview session. Throws if one is already running. */
  start(options: LiveVoicePreviewOptions): void {
    if (this.controller) {
      throw new Error("A live voice preview session is already running.");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.run(options, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.controller === controller) {
          this.controller = null;
          this.loop = null;
        }
      });
  }

  /**
   * Stop the session: aborts the controller (resolving any pending delay and
   * signalling the in-flight snapshot) and awaits the loop. Safe to call when
   * the session was never started or has already stopped.
   */
  async stop(): Promise<void> {
    const controller = this.controller;
    const loop = this.loop;
    if (!controller || !loop) {
      return;
    }
    controller.abort();
    await loop;
  }

  private async run(options: LiveVoicePreviewOptions, signal: AbortSignal): Promise<void> {
    const timers = options.timers ?? DEFAULT_TIMERS;
    const timing = resolveTiming(options.timing);

    let delayMs = timing.initialDelayMs;
    while (!signal.aborted) {
      if (!(await abortableDelay(timers, delayMs, signal))) {
        return;
      }

      // Stop taking provisional snapshots past the hard cap; Stop/Send still
      // performs the authoritative full pass. This is not an error.
      if (options.getRecordingDurationMs() >= timing.maxDurationMs) {
        return;
      }

      // Too little audio to bother with; keep waiting at the base cadence.
      if (options.getRecordingDurationMs() < timing.minDurationMs) {
        delayMs = timing.intervalMs;
        continue;
      }

      let snapshot: LiveVoiceSnapshot | null;
      try {
        snapshot = await options.transcribeSnapshot(signal);
      } catch (error) {
        // Preview is opportunistic. A missing/downloading model or a cancelled
        // request must never break the final path: report and stop the loop.
        options.onError?.(error);
        return;
      }

      if (signal.aborted) {
        return;
      }
      if (!snapshot) {
        delayMs = timing.intervalMs;
        continue;
      }
      if (snapshot.text) {
        options.onPreview(snapshot.text);
      }
      // Each snapshot intentionally covers the full recording so Whisper can
      // revise earlier words and punctuation. Slow the cadence as the clip
      // grows to avoid quadratic CPU/battery cost on long dictations.
      delayMs = adaptiveDelay(snapshot.durationMs, timing);
    }
  }
}

function resolveTiming(overrides: Partial<LivePreviewTiming> | undefined): LivePreviewTiming {
  return {
    initialDelayMs: overrides?.initialDelayMs ?? DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS,
    intervalMs: overrides?.intervalMs ?? DEFAULT_LIVE_PREVIEW_INTERVAL_MS,
    maxIntervalMs: overrides?.maxIntervalMs ?? DEFAULT_LIVE_PREVIEW_MAX_INTERVAL_MS,
    maxDurationMs: overrides?.maxDurationMs ?? DEFAULT_LIVE_PREVIEW_MAX_DURATION_MS,
    minDurationMs: overrides?.minDurationMs ?? DEFAULT_LIVE_PREVIEW_MIN_DURATION_MS,
  };
}

/** `min(maxInterval, max(interval, lastDurationMs / 6))` — the original backoff. */
function adaptiveDelay(lastDurationMs: number, timing: LivePreviewTiming): number {
  return Math.min(timing.maxIntervalMs, Math.max(timing.intervalMs, lastDurationMs / 6));
}

/**
 * Resolves `true` once the delay elapses, or `false` immediately if the signal
 * is (or becomes) aborted. Never rejects.
 */
function abortableDelay(
  timers: LivePreviewTimers,
  durationMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const handle = timers.setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      },
      Math.max(0, durationMs),
    );
    const onAbort = (): void => {
      timers.clearTimeout(handle);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
