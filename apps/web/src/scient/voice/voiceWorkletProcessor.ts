// Constants + message type for the Scient local-voice AudioWorklet.
//
// The actual processor runs from a SAME-ORIGIN static asset at
// `public/scient-voice-worklet.js` (loaded via `audioWorklet.addModule`) so it
// satisfies the renderer CSP `script-src 'self'` — a `blob:` URL is blocked
// there (blob: is only allowed under `worker-src`, but AudioWorklet modules
// obey script-src). This module holds only the values the main-thread hook
// needs; it touches no `AudioWorkletGlobalScope` globals.

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
