// AudioWorklet modules obey script-src rather than worker-src, so CSP requires
// public/scient-voice-worklet.js as a same-origin asset; blob URLs are blocked. Keep AudioWorklet
// globals out of this main-thread module.

/**
 * Name the processor registers under; also used to construct the node. MUST
 * stay in sync with the `registerProcessor(...)` call in
 * `public/scient-voice-worklet.js`.
 */
export const VOICE_WORKLET_PROCESSOR_NAME = "scient-voice-recorder";

/** Audio frame posted by the worklet. */
export interface VoiceWorkletSamplesMessage {
  readonly type: "samples";
  readonly samples: Float32Array;
  readonly rms: number;
}

/** Acknowledges that the worklet emitted its final partial frame. */
export interface VoiceWorkletFlushedMessage {
  readonly type: "flushed";
  readonly requestId: number;
}

export type VoiceWorkletMessage = VoiceWorkletSamplesMessage | VoiceWorkletFlushedMessage;

/** Main-thread command sent before a normal stop. */
export interface VoiceWorkletFlushCommand {
  readonly type: "flush";
  readonly requestId: number;
}
