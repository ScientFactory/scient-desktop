// Live captions for a lesson recording: the recorder's own microphone stream is cut into short
// clips at pauses and each clip goes to the recording engine. Captions are a preview; the saved
// audio is transcribed again when the lesson ends. Only the clip being built, the one being
// transcribed and one waiting are ever held, so a slow engine delays captions, never the audio.

import {
  encodeWavClip,
  VOICE_CLIP_SAMPLE_RATE_HZ,
  type VoiceWavClip,
} from "../voice/voiceWavEncoder";
import {
  VOICE_WORKLET_PROCESSOR_NAME,
  type VoiceWorkletMessage,
} from "../voice/voiceWorkletProcessor";

/** A clip is cut at the first pause after this long. */
const CAPTION_MIN_SECONDS = 10;
/** And always at this length. */
const CAPTION_MAX_SECONDS = 30;
const PAUSE_SECONDS = 0.5;
/** Frame loudness below this is quiet. */
const QUIET_RMS = 0.01;
const REQUEST_TIMEOUT_MS = 45_000;

export type LessonCaption = {
  readonly window: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export type CaptionClip = {
  readonly window: number;
  /** Seconds into the saved recording; paused time is not recorded, so it is not counted. */
  readonly start: number;
  readonly end: number;
  readonly frames: readonly Float32Array[];
};

/** Cuts frames into clips: at a pause once a clip is long enough, or at the longest length. */
export class CaptionWindows {
  private frames: Float32Array[] = [];
  private samples = 0;
  private quietSamples = 0;
  private loud = false;
  private consumed = 0;
  private next = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly emit: (clip: CaptionClip) => void,
  ) {}

  push(samples: Float32Array, rms: number) {
    this.frames.push(samples);
    this.samples += samples.length;
    if (rms >= QUIET_RMS) {
      this.loud = true;
      this.quietSamples = 0;
    } else this.quietSamples += samples.length;
    const seconds = this.samples / this.sampleRate;
    if (
      seconds >= CAPTION_MAX_SECONDS ||
      (seconds >= CAPTION_MIN_SECONDS && this.quietSamples >= PAUSE_SECONDS * this.sampleRate)
    )
      this.cut();
  }

  /** Ends the current clip, as at a pause or stop. */
  cut() {
    const start = this.consumed / this.sampleRate;
    this.consumed += this.samples;
    const clip = {
      window: this.next,
      start,
      end: this.consumed / this.sampleRate,
      frames: this.frames,
    };
    const speech = this.loud;
    this.frames = [];
    this.samples = 0;
    this.quietSamples = 0;
    this.loud = false;
    if (!speech || clip.end - clip.start < 0.5) return;
    this.next += 1;
    this.emit(clip);
  }
}

/** One clip transcribed at a time and one waiting; a newer clip replaces the waiting one. */
export class CaptionQueue {
  private running = false;
  private waiting: CaptionClip | undefined;
  private closed = false;
  readonly controller = new AbortController();

  constructor(
    private readonly work: (clip: CaptionClip, signal: AbortSignal) => Promise<void>,
    private readonly onDelayed: () => void,
  ) {}

  add(clip: CaptionClip) {
    if (this.closed) return;
    if (this.running) {
      if (this.waiting) this.onDelayed();
      this.waiting = clip;
      return;
    }
    void this.run(clip);
  }

  close() {
    this.closed = true;
    this.waiting = undefined;
    this.controller.abort();
  }

  private async run(clip: CaptionClip) {
    this.running = true;
    let current: CaptionClip | undefined = clip;
    while (current && !this.closed) {
      const signal = AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      await this.work(current, signal).catch(() => undefined);
      current = this.waiting;
      this.waiting = undefined;
    }
    this.running = false;
  }
}

export type LessonCaptionsTap = {
  /** Ends the current clip, so what was said before a pause or a question is captioned. */
  readonly cut: () => void;
  readonly setPaused: (paused: boolean) => void;
  readonly close: () => void;
};

/** Listens to the recorder's stream and captions it; the stream stays the recorder's. */
export async function tapLessonCaptions(input: {
  readonly stream: MediaStream;
  readonly transcribe: (clip: VoiceWavClip, signal: AbortSignal) => Promise<string>;
  readonly save: (caption: LessonCaption) => Promise<void>;
  readonly onCaption: (caption: LessonCaption) => void;
  readonly onDelayed: () => void;
}): Promise<LessonCaptionsTap> {
  const context = new AudioContext({ sampleRate: VOICE_CLIP_SAMPLE_RATE_HZ });
  try {
    await context.audioWorklet.addModule(new URL("scient-voice-worklet.js", document.baseURI).href);
  } catch (cause) {
    void context.close();
    throw cause;
  }
  const rate = context.sampleRate;
  const queue = new CaptionQueue(async (clip, signal) => {
    const text = (await input.transcribe(encodeWavClip(clip.frames, rate), signal)).trim();
    if (!text || signal.aborted) return;
    const caption = { window: clip.window, start: clip.start, end: clip.end, text };
    await input.save(caption);
    if (!signal.aborted) input.onCaption(caption);
  }, input.onDelayed);
  const windows = new CaptionWindows(rate, (clip) => queue.add(clip));
  const source = context.createMediaStreamSource(input.stream);
  const worklet = new AudioWorkletNode(context, VOICE_WORKLET_PROCESSOR_NAME);
  const silent = context.createGain();
  silent.gain.value = 0;
  let paused = false;
  worklet.port.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as VoiceWorkletMessage | undefined;
    if (message?.type === "samples" && !paused) windows.push(message.samples, message.rms);
  });
  worklet.port.start();
  source.connect(worklet);
  worklet.connect(silent);
  silent.connect(context.destination);
  void context.resume().catch(() => undefined);
  return {
    cut: () => windows.cut(),
    setPaused: (next) => {
      if (next && !paused) windows.cut();
      paused = next;
    },
    close: () => {
      queue.close();
      worklet.port.close();
      worklet.disconnect();
      source.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}
