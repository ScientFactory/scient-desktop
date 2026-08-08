// Microphone capture hook for local voice dictation.
//
// Wires getUserMedia → AudioContext → AudioWorklet, accumulating mono Float32
// frames (for `encodeWavClip`) and a rolling RMS level series (for the live
// waveform). The worklet is loaded as a SAME-ORIGIN static asset
// (`public/scient-voice-worklet.js`) so it satisfies the renderer CSP
// `script-src 'self'`; a `blob:` URL is blocked there (blob: is only allowed
// under `worker-src`, but AudioWorklet modules obey script-src). All audio
// resources are torn down on stop/cancel/unmount.

import { useCallback, useEffect, useRef, useState } from "react";

import { VOICE_CLIP_SAMPLE_RATE_HZ, encodeWavClip, type VoiceWavClip } from "./voiceWavEncoder.ts";
import { VOICE_WORKLET_PROCESSOR_NAME, type VoiceWorkletMessage } from "./voiceWorkletProcessor.ts";

export type VoiceRecorderStatus = "idle" | "recording" | "error";

export type VoiceRecorderErrorKind =
  | "permission-denied"
  | "no-microphone"
  | "device-in-use"
  | "unsupported"
  | "unknown";

/** Hard ceiling on a single dictation clip. */
export const MAX_RECORDING_MS = 120_000;

/** Number of recent RMS samples retained for the waveform. */
const MAX_LEVELS = 48;

export interface UseVoiceRecorderOptions {
  /** Called with the finalized clip when the 120s cap auto-stops recording. */
  readonly onAutoStop?: (clip: VoiceWavClip | null) => void;
}

export interface VoiceRecorderControls {
  readonly status: VoiceRecorderStatus;
  readonly levels: readonly number[];
  readonly errorKind: VoiceRecorderErrorKind | null;
  start: () => Promise<void>;
  stop: () => Promise<VoiceWavClip | null>;
  cancel: () => void;
  /** Encode the audio captured *so far* without stopping capture (live preview). */
  snapshot: () => VoiceWavClip | null;
  /** Milliseconds of audio captured so far. */
  getDurationMs: () => number;
}

function mapGetUserMediaError(error: unknown): VoiceRecorderErrorKind {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-microphone";
    case "NotReadableError":
    case "AbortError":
      return "device-in-use";
    default:
      return "unknown";
  }
}

export function useVoiceRecorder(options?: UseVoiceRecorderOptions): VoiceRecorderControls {
  const [status, setStatusState] = useState<VoiceRecorderStatus>("idle");
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [errorKind, setErrorKind] = useState<VoiceRecorderErrorKind | null>(null);

  const statusRef = useRef<VoiceRecorderStatus>("idle");
  const setStatus = useCallback((next: VoiceRecorderStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const messageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const framesRef = useRef<Float32Array[]>([]);
  const inputRateRef = useRef<number>(VOICE_CLIP_SAMPLE_RATE_HZ);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onAutoStopRef = useRef<UseVoiceRecorderOptions["onAutoStop"]>(options?.onAutoStop);
  useEffect(() => {
    onAutoStopRef.current = options?.onAutoStop;
  }, [options?.onAutoStop]);

  const teardownAudio = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    const worklet = workletRef.current;
    if (worklet) {
      if (messageHandlerRef.current) {
        worklet.port.removeEventListener("message", messageHandlerRef.current);
        messageHandlerRef.current = null;
      }
      worklet.port.close();
      worklet.disconnect();
      workletRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (gainRef.current) {
      gainRef.current.disconnect();
      gainRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    const context = contextRef.current;
    if (context && context.state !== "closed") {
      void context.close();
    }
    contextRef.current = null;
  }, []);

  const finalize = useCallback(
    async (produceClip: boolean): Promise<VoiceWavClip | null> => {
      const frames = framesRef.current;
      const rate = inputRateRef.current;
      framesRef.current = [];
      teardownAudio();
      setLevels([]);
      if (statusRef.current === "recording") setStatus("idle");

      if (!produceClip || frames.length === 0) return null;
      const clip = encodeWavClip(frames, rate);
      return clip.durationMs > 0 ? clip : null;
    },
    [setStatus, teardownAudio],
  );

  const start = useCallback(async () => {
    if (statusRef.current === "recording") return;
    framesRef.current = [];
    setLevels([]);
    setErrorKind(null);

    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const AudioContextCtor = typeof window !== "undefined" ? window.AudioContext : undefined;
    if (!media || typeof media.getUserMedia !== "function" || AudioContextCtor === undefined) {
      setErrorKind("unsupported");
      setStatus("error");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      setErrorKind(mapGetUserMediaError(error));
      setStatus("error");
      return;
    }
    streamRef.current = stream;

    try {
      const context = new AudioContextCtor();
      contextRef.current = context;
      inputRateRef.current = context.sampleRate;

      // Same-origin static asset (public/); a blob: URL is blocked by the
      // renderer CSP (script-src 'self'), which is what AudioWorklet obeys.
      // Resolved lazily here (not at module scope) so importing this hook in a
      // non-DOM test env never touches `document`.
      await context.audioWorklet.addModule(
        new URL("scient-voice-worklet.js", document.baseURI).href,
      );

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;
      const worklet = new AudioWorkletNode(context, VOICE_WORKLET_PROCESSOR_NAME);
      workletRef.current = worklet;
      const handleMessage = (event: MessageEvent) => {
        const message = event.data as VoiceWorkletMessage | undefined;
        if (!message) return;
        framesRef.current.push(message.samples);
        setLevels((previous) => {
          const trimmed =
            previous.length >= MAX_LEVELS
              ? previous.slice(previous.length - MAX_LEVELS + 1)
              : previous;
          return [...trimmed, message.rms];
        });
      };
      messageHandlerRef.current = handleMessage;
      worklet.port.addEventListener("message", handleMessage);
      worklet.port.start();

      // A muted sink keeps the graph pulling the worklet without echoing the
      // microphone back to the speakers.
      const gain = context.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;
      source.connect(worklet);
      worklet.connect(gain);
      gain.connect(context.destination);

      autoStopTimerRef.current = setTimeout(() => {
        void (async () => {
          const clip = await finalize(true);
          onAutoStopRef.current?.(clip);
        })();
      }, MAX_RECORDING_MS);

      setStatus("recording");
    } catch {
      teardownAudio();
      framesRef.current = [];
      setErrorKind("unknown");
      setStatus("error");
    }
  }, [finalize, setStatus, teardownAudio]);

  const stop = useCallback(() => finalize(true), [finalize]);

  // Copy the frames captured so far and encode them, WITHOUT stopping capture.
  // The mic callback keeps appending to `framesRef` after this slice, so the
  // snapshot sees a stable prefix and no samples are dropped (live preview).
  const snapshot = useCallback((): VoiceWavClip | null => {
    const frames = framesRef.current.slice();
    if (frames.length === 0) return null;
    const clip = encodeWavClip(frames, inputRateRef.current);
    return clip.durationMs > 0 ? clip : null;
  }, []);

  const getDurationMs = useCallback((): number => {
    let samples = 0;
    for (const frame of framesRef.current) samples += frame.length;
    const rate = inputRateRef.current > 0 ? inputRateRef.current : VOICE_CLIP_SAMPLE_RATE_HZ;
    return Math.round((samples / rate) * 1000);
  }, []);

  const cancel = useCallback(() => {
    void finalize(false);
  }, [finalize]);

  // Release the microphone and audio graph if the component unmounts mid-record.
  useEffect(() => () => teardownAudio(), [teardownAudio]);

  return { status, levels, errorKind, start, stop, cancel, snapshot, getDurationMs };
}
