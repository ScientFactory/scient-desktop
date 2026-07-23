// FILE: liveVoicePreview.ts
// Purpose: Runs one-at-a-time local transcription snapshots while microphone capture continues.
// Layer: Client voice utility

import type { VoiceRecordingPayload } from "./voiceRecorder";

export interface LiveVoicePreviewOptions {
  readonly captureSnapshot: () => Promise<VoiceRecordingPayload | null>;
  readonly transcribeSnapshot: (payload: VoiceRecordingPayload) => Promise<string>;
  readonly cancelActiveTranscription: () => Promise<void>;
  readonly onPreview: (text: string) => void;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly maximumIntervalMs?: number;
  readonly minimumDurationMs?: number;
}

const DEFAULT_INITIAL_DELAY_MS = 1_800;
const DEFAULT_INTERVAL_MS = 2_500;
const DEFAULT_MAXIMUM_INTERVAL_MS = 8_000;
const DEFAULT_MINIMUM_DURATION_MS = 1_000;

/**
 * Preview requests are deliberately sequential. A slower machine therefore
 * produces fewer updates instead of accumulating Whisper work behind Stop/Send.
 */
export class LiveVoicePreviewSession {
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private transcriptionActive = false;
  private options: LiveVoicePreviewOptions | null = null;

  start(options: LiveVoicePreviewOptions): void {
    if (this.controller) {
      throw new Error("A live voice preview session is already running.");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.options = options;
    this.loop = this.run(options, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.controller === controller) {
          this.controller = null;
          this.loop = null;
          this.options = null;
          this.transcriptionActive = false;
        }
      });
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    const loop = this.loop;
    const options = this.options;
    if (!controller || !loop) {
      return;
    }
    controller.abort();
    if (this.transcriptionActive && options) {
      await options.cancelActiveTranscription().catch(() => undefined);
    }
    await loop.catch(() => undefined);
  }

  private async run(options: LiveVoicePreviewOptions, signal: AbortSignal): Promise<void> {
    let delayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const maximumIntervalMs = options.maximumIntervalMs ?? DEFAULT_MAXIMUM_INTERVAL_MS;
    const minimumDurationMs = options.minimumDurationMs ?? DEFAULT_MINIMUM_DURATION_MS;

    while (!signal.aborted) {
      if (!(await abortableDelay(delayMs, signal))) {
        return;
      }
      delayMs = intervalMs;

      const payload = await options.captureSnapshot();
      if (signal.aborted) {
        return;
      }
      if (!payload || payload.durationMs < minimumDurationMs) {
        continue;
      }
      // Each snapshot intentionally covers the full recording so Whisper can
      // revise earlier words and punctuation. Slow the cadence as the clip
      // grows to avoid quadratic CPU/battery cost on long dictations.
      delayMs = Math.min(maximumIntervalMs, Math.max(intervalMs, payload.durationMs / 6));

      this.transcriptionActive = true;
      try {
        const text = (await options.transcribeSnapshot(payload)).trim();
        if (!signal.aborted && text) {
          options.onPreview(text);
        }
      } catch {
        // Preview is opportunistic. A missing/downloading local model or a
        // cancelled request must never break the final cloud/local path.
        return;
      } finally {
        this.transcriptionActive = false;
      }
    }
  }
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      },
      Math.max(0, durationMs),
    );
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
