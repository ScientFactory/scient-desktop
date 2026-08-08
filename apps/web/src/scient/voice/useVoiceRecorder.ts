// Microphone capture lifecycle for local voice dictation.
//
// The generation guard is the important invariant: a permission prompt or
// AudioWorklet load may resolve after cancel/unmount. A stale generation stops
// its stream immediately and never creates a hidden recording graph.

import { useCallback, useEffect, useRef, useState } from "react";

import { VOICE_CLIP_SAMPLE_RATE_HZ, encodeWavClip, type VoiceWavClip } from "./voiceWavEncoder.ts";
import {
  VOICE_WORKLET_PROCESSOR_NAME,
  type VoiceWorkletFlushCommand,
  type VoiceWorkletMessage,
} from "./voiceWorkletProcessor.ts";
import { acquireCurrentMicrophone } from "./voiceMedia.ts";

export type VoiceRecorderStatus = "idle" | "requesting-permission" | "recording" | "error";

export type VoiceRecorderErrorKind =
  | "permission-denied"
  | "no-microphone"
  | "device-in-use"
  | "unsupported"
  | "unknown";

export const MAX_RECORDING_MS = 120_000;
const MAX_LEVELS = 48;
const WORKLET_FLUSH_TIMEOUT_MS = 500;

export interface UseVoiceRecorderOptions {
  readonly onAutoStop?: (clip: VoiceWavClip | null) => void;
}

export interface VoiceRecorderControls {
  readonly status: VoiceRecorderStatus;
  readonly levels: readonly number[];
  readonly errorKind: VoiceRecorderErrorKind | null;
  /** Resolves true only after the microphone graph is actually recording. */
  start: () => Promise<boolean>;
  stop: () => Promise<VoiceWavClip | null>;
  cancel: () => Promise<void>;
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

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export function useVoiceRecorder(options?: UseVoiceRecorderOptions): VoiceRecorderControls {
  const [status, setStatusState] = useState<VoiceRecorderStatus>("idle");
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [errorKind, setErrorKind] = useState<VoiceRecorderErrorKind | null>(null);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const statusRef = useRef<VoiceRecorderStatus>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const messageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const framesRef = useRef<Float32Array[]>([]);
  const inputRateRef = useRef(VOICE_CLIP_SAMPLE_RATE_HZ);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSequenceRef = useRef(0);
  const flushResolversRef = useRef(new Map<number, () => void>());
  const finalizeInFlightRef = useRef<Promise<VoiceWavClip | null> | null>(null);
  const pendingLevelsRef = useRef<number[]>([]);
  const levelsAnimationFrameRef = useRef<number | null>(null);

  const onAutoStopRef = useRef(options?.onAutoStop);
  useEffect(() => {
    onAutoStopRef.current = options?.onAutoStop;
  }, [options?.onAutoStop]);

  const setStatus = useCallback((next: VoiceRecorderStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatusState(next);
  }, []);

  const flushLevels = useCallback(() => {
    levelsAnimationFrameRef.current = null;
    const additions = pendingLevelsRef.current.splice(0);
    if (additions.length === 0 || !mountedRef.current) return;
    setLevels((previous) => [...previous, ...additions].slice(-MAX_LEVELS));
  }, []);

  const clearLevelUpdates = useCallback(() => {
    pendingLevelsRef.current = [];
    if (levelsAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(levelsAnimationFrameRef.current);
      levelsAnimationFrameRef.current = null;
    }
  }, []);

  const requestWorkletFlush = useCallback(async (worklet: AudioWorkletNode): Promise<void> => {
    const requestId = (flushSequenceRef.current += 1);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        flushResolversRef.current.delete(requestId);
        resolve();
      };
      const timeout = setTimeout(finish, WORKLET_FLUSH_TIMEOUT_MS);
      flushResolversRef.current.set(requestId, finish);
      const command: VoiceWorkletFlushCommand = { type: "flush", requestId };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePort, not Window.postMessage.
      worklet.port.postMessage(command);
    });
  }, []);

  const teardownAudio = useCallback(
    async (flushFinalFrame: boolean): Promise<void> => {
      if (autoStopTimerRef.current !== null) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      const worklet = workletRef.current;
      if (flushFinalFrame && worklet) await requestWorkletFlush(worklet);

      if (worklet) {
        if (messageHandlerRef.current) {
          worklet.port.removeEventListener("message", messageHandlerRef.current);
          messageHandlerRef.current = null;
        }
        worklet.port.close();
        worklet.disconnect();
        workletRef.current = null;
      }
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      gainRef.current?.disconnect();
      gainRef.current = null;
      if (streamRef.current) stopStream(streamRef.current);
      streamRef.current = null;
      const context = contextRef.current;
      contextRef.current = null;
      if (context && context.state !== "closed") await context.close().catch(() => undefined);
      for (const resolve of flushResolversRef.current.values()) resolve();
      flushResolversRef.current.clear();
      clearLevelUpdates();
    },
    [clearLevelUpdates, requestWorkletFlush],
  );

  const finalize = useCallback(
    (produceClip: boolean): Promise<VoiceWavClip | null> => {
      const activeFinalization = finalizeInFlightRef.current;
      if (activeFinalization) return activeFinalization;

      let finalization: Promise<VoiceWavClip | null>;
      finalization = (async () => {
        generationRef.current += 1;
        await teardownAudio(produceClip);
        const frames = framesRef.current;
        const rate = inputRateRef.current;
        framesRef.current = [];
        if (mountedRef.current) setLevels([]);
        setStatus("idle");
        if (!produceClip || frames.length === 0) return null;
        const clip = encodeWavClip(frames, rate);
        return clip.durationMs > 0 ? clip : null;
      })().finally(() => {
        if (finalizeInFlightRef.current === finalization) {
          finalizeInFlightRef.current = null;
        }
      });
      finalizeInFlightRef.current = finalization;
      return finalization;
    },
    [setStatus, teardownAudio],
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (statusRef.current === "recording" || statusRef.current === "requesting-permission") {
      return false;
    }
    const generation = (generationRef.current += 1);
    framesRef.current = [];
    if (mountedRef.current) setLevels([]);
    setErrorKind(null);

    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const AudioContextCtor = typeof window !== "undefined" ? window.AudioContext : undefined;
    if (!media || typeof media.getUserMedia !== "function" || AudioContextCtor === undefined) {
      setErrorKind("unsupported");
      setStatus("error");
      return false;
    }

    setStatus("requesting-permission");
    let stream: MediaStream | null;
    try {
      stream = await acquireCurrentMicrophone(
        media,
        () => generation === generationRef.current && mountedRef.current,
      );
    } catch (error) {
      if (generation !== generationRef.current || !mountedRef.current) return false;
      setErrorKind(mapGetUserMediaError(error));
      setStatus("error");
      return false;
    }
    if (!stream) return false;
    streamRef.current = stream;

    try {
      const context = new AudioContextCtor({ sampleRate: VOICE_CLIP_SAMPLE_RATE_HZ });
      contextRef.current = context;
      inputRateRef.current = context.sampleRate;
      await context.audioWorklet.addModule(
        new URL("scient-voice-worklet.js", document.baseURI).href,
      );
      if (context.state === "suspended") await context.resume();
      if (generation !== generationRef.current || !mountedRef.current) {
        await teardownAudio(false);
        return false;
      }

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;
      const worklet = new AudioWorkletNode(context, VOICE_WORKLET_PROCESSOR_NAME);
      workletRef.current = worklet;
      const handleMessage = (event: MessageEvent) => {
        const message = event.data as VoiceWorkletMessage | undefined;
        if (!message) return;
        if (message.type === "flushed") {
          flushResolversRef.current.get(message.requestId)?.();
          return;
        }
        framesRef.current.push(message.samples);
        pendingLevelsRef.current.push(message.rms);
        if (levelsAnimationFrameRef.current === null) {
          levelsAnimationFrameRef.current = window.requestAnimationFrame(flushLevels);
        }
      };
      messageHandlerRef.current = handleMessage;
      worklet.port.addEventListener("message", handleMessage);
      worklet.port.start();

      const gain = context.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;
      source.connect(worklet);
      worklet.connect(gain);
      gain.connect(context.destination);

      autoStopTimerRef.current = setTimeout(() => {
        void finalize(true).then((clip) => onAutoStopRef.current?.(clip));
      }, MAX_RECORDING_MS);
      setStatus("recording");
      return true;
    } catch {
      await teardownAudio(false);
      framesRef.current = [];
      if (generation !== generationRef.current || !mountedRef.current) return false;
      setErrorKind("unknown");
      setStatus("error");
      return false;
    }
  }, [finalize, flushLevels, setStatus, teardownAudio]);

  const stop = useCallback(() => finalize(true), [finalize]);
  const cancel = useCallback(async (): Promise<void> => {
    await finalize(false);
  }, [finalize]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      void teardownAudio(false);
    };
  }, [teardownAudio]);

  return { status, levels, errorKind, start, stop, cancel };
}
