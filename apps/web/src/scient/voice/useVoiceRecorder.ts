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

export const MAX_RECORDING_MS = 180_000;
export const VOICE_WAVEFORM_LEVEL_COUNT = 96;
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

interface VoiceAudioSession {
  readonly stream: MediaStream;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  gain: GainNode | null;
  messageHandler: ((event: MessageEvent) => void) | null;
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

/** @internal Clears only the session that still owns the recorder slot. */
export function releaseOwnedVoiceSession<T extends object>(
  slot: { current: T | null },
  session: T,
): void {
  if (slot.current === session) slot.current = null;
}

export function useVoiceRecorder(options?: UseVoiceRecorderOptions): VoiceRecorderControls {
  const [status, setStatusState] = useState<VoiceRecorderStatus>("idle");
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [errorKind, setErrorKind] = useState<VoiceRecorderErrorKind | null>(null);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const statusRef = useRef<VoiceRecorderStatus>("idle");
  const sessionRef = useRef<VoiceAudioSession | null>(null);
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
    setLevels((previous) => [...previous, ...additions].slice(-VOICE_WAVEFORM_LEVEL_COUNT));
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

  const teardownSession = useCallback(
    async (session: VoiceAudioSession, flushFinalFrame: boolean): Promise<void> => {
      const worklet = session.worklet;
      if (flushFinalFrame && worklet) await requestWorkletFlush(worklet);
      if (worklet) {
        if (session.messageHandler) {
          worklet.port.removeEventListener("message", session.messageHandler);
          session.messageHandler = null;
        }
        worklet.port.close();
        worklet.disconnect();
        session.worklet = null;
      }
      session.source?.disconnect();
      session.source = null;
      session.gain?.disconnect();
      session.gain = null;
      stopStream(session.stream);
      const context = session.context;
      session.context = null;
      if (context && context.state !== "closed") await context.close().catch(() => undefined);
      releaseOwnedVoiceSession(sessionRef, session);
    },
    [requestWorkletFlush],
  );

  const teardownAudio = useCallback(
    async (flushFinalFrame: boolean): Promise<void> => {
      if (autoStopTimerRef.current !== null) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      const session = sessionRef.current;
      if (session) await teardownSession(session, flushFinalFrame);
      for (const resolve of flushResolversRef.current.values()) resolve();
      flushResolversRef.current.clear();
      clearLevelUpdates();
    },
    [clearLevelUpdates, teardownSession],
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
    const session: VoiceAudioSession = {
      stream,
      context: null,
      source: null,
      worklet: null,
      gain: null,
      messageHandler: null,
    };
    sessionRef.current = session;

    try {
      const context = new AudioContextCtor({ sampleRate: VOICE_CLIP_SAMPLE_RATE_HZ });
      session.context = context;
      inputRateRef.current = context.sampleRate;
      await context.audioWorklet.addModule(
        new URL("scient-voice-worklet.js", document.baseURI).href,
      );
      if (context.state === "suspended") await context.resume();
      if (
        generation !== generationRef.current ||
        !mountedRef.current ||
        sessionRef.current !== session
      ) {
        await teardownSession(session, false);
        return false;
      }

      const source = context.createMediaStreamSource(stream);
      session.source = source;
      const worklet = new AudioWorkletNode(context, VOICE_WORKLET_PROCESSOR_NAME);
      session.worklet = worklet;
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
      session.messageHandler = handleMessage;
      worklet.port.addEventListener("message", handleMessage);
      worklet.port.start();

      const gain = context.createGain();
      gain.gain.value = 0;
      session.gain = gain;
      source.connect(worklet);
      worklet.connect(gain);
      gain.connect(context.destination);

      autoStopTimerRef.current = setTimeout(() => {
        void finalize(true).then((clip) => onAutoStopRef.current?.(clip));
      }, MAX_RECORDING_MS);
      setStatus("recording");
      return true;
    } catch {
      await teardownSession(session, false);
      if (generation !== generationRef.current || !mountedRef.current) return false;
      framesRef.current = [];
      clearLevelUpdates();
      if (mountedRef.current) setLevels([]);
      setErrorKind("unknown");
      setStatus("error");
      return false;
    }
  }, [clearLevelUpdates, finalize, flushLevels, setStatus, teardownSession]);

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
