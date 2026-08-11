import { useCallback, useEffect, useRef, useState } from "react";
import type {
  VoiceModelDownloadProgress,
  VoiceModelState,
  VoiceTranscribeRequest,
} from "@t3tools/contracts";

import { type VoiceRecorderErrorKind, useVoiceRecorder } from "./useVoiceRecorder.ts";
import type { VoiceTranscriptionClient } from "./voiceClient.ts";
import type { VoiceWavClip } from "./voiceWavEncoder.ts";
import { useRecordScientAnalytics } from "../analytics/client.ts";

export type VoicePhase =
  | "idle"
  | "setup-prompt"
  | "downloading"
  | "requesting-permission"
  | "recording"
  | "transcribing";

const MODEL_SETUP_FAILED_MESSAGE = "Voice setup didn't finish. Try again.";
const TRANSCRIPTION_FAILED_MESSAGE = "Transcription failed. Try again.";
const EMPTY_TRANSCRIPT_MESSAGE = "No speech detected";
const ARM_DELAY_MS = 250;

interface VoiceControllerOptions {
  readonly client: VoiceTranscriptionClient | null;
  readonly onTranscript: (text: string) => void;
  readonly onRequestSubmit?: () => void;
}

interface VoiceCompletionCallbacks {
  readonly onTranscript: (text: string) => void;
  readonly onRequestSubmit: (() => void) | undefined;
}

interface VoiceCompletionCallbacksRef {
  current: VoiceCompletionCallbacks;
}

export function routeCompletedVoiceTranscription(
  callbacksRef: VoiceCompletionCallbacksRef,
  text: string,
  send: boolean,
  scheduleSubmit: (callback: () => void) => void = (callback) => {
    requestAnimationFrame(callback);
  },
): void {
  callbacksRef.current.onTranscript(text);
  if (send && callbacksRef.current.onRequestSubmit) {
    scheduleSubmit(() => callbacksRef.current.onRequestSubmit?.());
  }
}

export interface ScientVoiceController {
  readonly phase: VoicePhase;
  readonly levels: readonly number[];
  readonly elapsedMs: number;
  readonly errorMessage: string | null;
  readonly downloadPercent: number;
  activate: () => Promise<void>;
  setupModel: () => Promise<void>;
  dismissSetup: () => void;
  stop: (send: boolean) => Promise<void>;
  cancel: () => Promise<void>;
}

export function formatVoiceTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function describeVoiceRecorderError(kind: VoiceRecorderErrorKind): string {
  switch (kind) {
    case "permission-denied":
      return "Allow microphone access in your system privacy settings, then try again.";
    case "no-microphone":
      return "No microphone found. Connect one and try again.";
    case "device-in-use":
      return "Your microphone is busy in another app. Close it and try again.";
    case "unsupported":
      return "Voice recording isn't available in this environment.";
    case "unknown":
      return "Couldn't start recording. Try again.";
  }
}

export function sanitizeVoiceErrorMessage(message: string): string {
  return message
    .replace(/\n\s*at\s+[\s\S]*$/u, "")
    .replace(/^Error invoking remote method '[^']*':\s*/u, "")
    .replace(/^[A-Za-z][A-Za-z0-9_]*Error:\s*/u, "")
    .replace(/^(?:Error:\s*)+/u, "")
    .trim();
}

export function describeTranscriptionError(error: unknown): string {
  if (error !== null && typeof error === "object" && "safeMessage" in error) {
    const safe = (error as { readonly safeMessage?: unknown }).safeMessage;
    if (typeof safe === "string" && safe.trim().length > 0) return safe;
  }
  if (error instanceof Error) {
    const sanitized = sanitizeVoiceErrorMessage(error.message);
    if (sanitized.length > 0) return sanitized;
  }
  return TRANSCRIPTION_FAILED_MESSAGE;
}

function percent(progress: VoiceModelDownloadProgress | null): number {
  if (!progress || progress.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
}

export function useScientVoiceController({
  client,
  onTranscript,
  onRequestSubmit,
}: VoiceControllerOptions): ScientVoiceController {
  const recordAnalytics = useRecordScientAnalytics();
  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<VoiceModelDownloadProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const phaseRef = useRef<VoicePhase>("idle");
  const operationRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const autoStopRef = useRef<(clip: VoiceWavClip | null) => void>(() => undefined);
  const completionCallbacksRef = useRef<VoiceCompletionCallbacks>({
    onTranscript,
    onRequestSubmit,
  });
  completionCallbacksRef.current = { onTranscript, onRequestSubmit };

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const recorder = useVoiceRecorder({
    onAutoStop: (clip) => autoStopRef.current(clip),
  });
  const {
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
    status: recorderStatus,
    errorKind: recorderErrorKind,
    levels: recorderLevels,
  } = recorder;

  const transcribe = useCallback(
    async (clip: VoiceWavClip | null, send: boolean, operation: number): Promise<void> => {
      if (!client || operation !== operationRef.current) return;
      if (!clip) {
        setPhase("idle");
        setErrorMessage(EMPTY_TRANSCRIPT_MESSAGE);
        return;
      }
      setErrorMessage(null);
      setPhase("transcribing");
      const transcriptionStartedAt = performance.now();
      recordAnalytics({
        name: "voice.transcription.started",
        properties: { engineClass: "local-whisper", languageMode: "automatic" },
      });
      try {
        const request: VoiceTranscribeRequest = {
          audioBase64: clip.base64,
          mimeType: "audio/wav",
          sampleRateHz: clip.sampleRateHz,
          durationMs: clip.durationMs,
        };
        const transcript = await client.transcribe(request);
        if (operation !== operationRef.current) return;
        const text = transcript.text.trim();
        setPhase("idle");
        if (!text) {
          setErrorMessage(EMPTY_TRANSCRIPT_MESSAGE);
          recordAnalytics({
            name: "voice.transcription.failed",
            properties: { engineClass: "local-whisper", failureClass: "audio" },
          });
          return;
        }
        routeCompletedVoiceTranscription(completionCallbacksRef, text, send);
        recordAnalytics({
          name: "voice.transcription.completed",
          properties: {
            engineClass: "local-whisper",
            durationMs: performance.now() - transcriptionStartedAt,
            audioDurationMs: clip.durationMs,
          },
        });
      } catch (error) {
        if (operation !== operationRef.current) return;
        setPhase("idle");
        setErrorMessage(describeTranscriptionError(error));
        recordAnalytics({
          name: "voice.transcription.failed",
          properties: { engineClass: "local-whisper", failureClass: "engine" },
        });
      }
    },
    [client, recordAnalytics, setPhase],
  );

  const beginRecording = useCallback(async (): Promise<void> => {
    const operation = (operationRef.current += 1);
    setErrorMessage(null);
    setElapsedMs(0);
    setPhase("requesting-permission");
    const started = await startRecording();
    if (operation !== operationRef.current) {
      cancelRecording();
      return;
    }
    if (!started) return;
    recordingStartedAtRef.current = performance.now();
    setPhase("recording");
  }, [cancelRecording, setPhase, startRecording]);

  const activate = useCallback(async (): Promise<void> => {
    if (!client) return;
    const operation = (operationRef.current += 1);
    setErrorMessage(null);
    let state: VoiceModelState;
    try {
      state = await client.getModelState();
      if (operation !== operationRef.current) return;
    } catch (error) {
      if (operation !== operationRef.current) return;
      setErrorMessage(describeTranscriptionError(error));
      return;
    }
    if (state?.state === "ready") await beginRecording();
    else if (state?.state === "unavailable" || state?.state === "error") {
      setErrorMessage(state.message);
    } else {
      setPhase("setup-prompt");
    }
  }, [beginRecording, client, setPhase]);

  const setupModel = useCallback(async (): Promise<void> => {
    if (!client) return;
    const operation = (operationRef.current += 1);
    setErrorMessage(null);
    setDownloadProgress(null);
    setPhase("downloading");
    const unsubscribe = client.onModelDownloadProgress(setDownloadProgress);
    try {
      const state = await client.downloadModel();
      if (operation !== operationRef.current) return;
      if (state.state === "ready") await beginRecording();
      else {
        setPhase("idle");
        setErrorMessage(
          state.state === "error" || state.state === "unavailable"
            ? state.message
            : MODEL_SETUP_FAILED_MESSAGE,
        );
      }
    } catch (error) {
      if (operation !== operationRef.current) return;
      setPhase("idle");
      setErrorMessage(describeTranscriptionError(error));
    } finally {
      unsubscribe();
      if (operation === operationRef.current) setDownloadProgress(null);
    }
  }, [beginRecording, client, setPhase]);

  const stop = useCallback(
    async (send: boolean): Promise<void> => {
      if (
        phaseRef.current !== "recording" ||
        performance.now() - recordingStartedAtRef.current < ARM_DELAY_MS
      ) {
        return;
      }
      const operation = (operationRef.current += 1);
      const clip = await stopRecording();
      await transcribe(clip, send, operation);
    },
    [stopRecording, transcribe],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const cancelledPhase = phaseRef.current;
    const operation = (operationRef.current += 1);
    const cancelDownload =
      phaseRef.current === "downloading"
        ? client?.cancelModelDownload().catch(() => undefined)
        : undefined;
    const cancelHost =
      phaseRef.current === "transcribing"
        ? client?.cancelTranscription().catch(() => undefined)
        : undefined;
    await Promise.all([cancelRecording(), cancelDownload, cancelHost]);
    if (operation !== operationRef.current) return;
    if (cancelledPhase === "recording" || cancelledPhase === "transcribing") {
      recordAnalytics({
        name: "voice.transcription.cancelled",
        properties: { stage: cancelledPhase },
      });
    }
    setElapsedMs(0);
    setErrorMessage(null);
    setPhase("idle");
  }, [cancelRecording, client, recordAnalytics, setPhase]);

  const dismissSetup = useCallback(() => {
    operationRef.current += 1;
    setErrorMessage(null);
    setPhase("idle");
  }, [setPhase]);

  autoStopRef.current = (clip) => {
    const operation = (operationRef.current += 1);
    void transcribe(clip, false, operation);
  };

  useEffect(() => {
    if (recorderStatus !== "error" || !recorderErrorKind) return;
    setPhase("idle");
    setErrorMessage(describeVoiceRecorderError(recorderErrorKind));
    recordAnalytics({
      name: "voice.transcription.failed",
      properties: {
        engineClass: "local-whisper",
        failureClass: recorderErrorKind === "permission-denied" ? "permission" : "audio",
      },
    });
  }, [recordAnalytics, recorderErrorKind, recorderStatus, setPhase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void stop(false);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void cancel();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, phase, stop]);

  useEffect(
    () => () => {
      operationRef.current += 1;
      void cancelRecording();
      void client?.cancelTranscription();
    },
    [cancelRecording, client],
  );

  return {
    phase,
    levels: recorderLevels,
    elapsedMs,
    errorMessage,
    downloadPercent: percent(downloadProgress),
    activate,
    setupModel,
    dismissSetup,
    stop,
    cancel,
  };
}
