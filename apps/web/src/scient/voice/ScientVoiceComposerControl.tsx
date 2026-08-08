// Composer control for local, on-device voice dictation (desktop-only).
//
// Idle: a mic button in the composer's right action cluster. Recording: a
// COMPACT single-row bar covers only the composer footer (model picker etc.
// stay intact underneath) — the editor above remains usable, so you can type
// while listening. Live transcription streams into the editable draft; if you
// start typing, live updates yield. The authoritative full-pass transcription
// always runs on stop and refines the text. Keyboard: Enter = stop+insert, Esc
// = cancel. Send = stop+transcribe+send.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  CornerDownLeftIcon,
  DownloadIcon,
  Loader2Icon,
  MicIcon,
  XIcon,
} from "lucide-react";
import { LiveVoicePreviewSession } from "@scientfactory/scient-voice/livePreview";
import { shouldEnableLivePreview } from "@scientfactory/scient-voice/livePreviewGate";
import type {
  VoiceModelDownloadProgress,
  VoiceModelState,
  VoiceTranscribeRequest,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils.ts";
import { Button } from "../../components/ui/button.tsx";
import { ComposerControl, ComposerControlIcon } from "../../components/chat/ComposerControl.tsx";
import { getVoiceBridge, isVoiceSupported } from "./voiceClient.ts";
import { type VoiceRecorderErrorKind, useVoiceRecorder } from "./useVoiceRecorder.ts";
import type { VoiceWavClip } from "./voiceWavEncoder.ts";
import { useAnchoredRect } from "./overlayAnchor.ts";
import { getCachedBenchmark, runVoiceBenchmark, setCachedBenchmark } from "./voiceBenchmark.ts";

/** The composer footer element our recording bar covers. */
const FOOTER_SELECTOR = '[data-chat-composer-footer="true"]';

export interface ScientVoiceComposerControlProps {
  readonly disabled?: boolean;
  /** Append final transcript to the draft (used when the user has edited it). */
  readonly onTranscript: (text: string) => void;
  /** Replace the whole draft (live provisional + the final refine). */
  readonly onSetDraft?: (text: string) => void;
  /** Read the current draft text (used to detect a manual edit and yield). */
  readonly getDraft?: () => string;
  /** Submit the composer (for "Send" during recording). */
  readonly onRequestSubmit?: () => void;
  readonly className?: string;
}

type VoicePhase = "idle" | "setup-prompt" | "downloading" | "recording" | "transcribing";

export const MODEL_DOWNLOAD_LABEL = "Set up voice (~182 MB)";
export const EMPTY_TRANSCRIPT_MESSAGE = "No speech detected";
const MODEL_SETUP_FAILED_MESSAGE = "Voice setup didn't finish. Try again.";
const TRANSCRIPTION_FAILED_MESSAGE = "Transcription failed. Try again.";
const PERMISSION_DENIED_MESSAGE =
  "Allow microphone access in System Settings > Privacy & Security > Microphone";
const ARM_DELAY_MS = 250;

export function formatVoiceTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function describeVoiceRecorderError(kind: VoiceRecorderErrorKind): string {
  switch (kind) {
    case "permission-denied":
      return PERMISSION_DENIED_MESSAGE;
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

/** Strip internal paths / IPC framing / error-class tags before showing text. */
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

/** Join a base draft with a transcript addition (newline-separated). */
export function composeDraft(base: string, addition: string): string {
  const trimmedBase = base.replace(/\s+$/u, "");
  const trimmedAddition = addition.trim();
  if (trimmedAddition.length === 0) return base;
  return trimmedBase.length > 0 ? `${trimmedBase}\n${trimmedAddition}` : trimmedAddition;
}

function downloadPercent(progress: VoiceModelDownloadProgress | null): number {
  if (!progress || progress.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
}

function barHeight(level: number): number {
  return Math.max(3, Math.min(20, Math.round(level * 80)));
}

const WAVEFORM_BAR_SLOTS = Array.from({ length: 256 }, (_, slot) => `voice-waveform-bar-${slot}`);

function VoiceWaveform({ levels }: { readonly levels: readonly number[] }): ReactNode {
  return (
    <div
      className="flex h-6 min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      aria-hidden="true"
    >
      {levels.map((level, index) => (
        <span
          key={WAVEFORM_BAR_SLOTS[index]}
          className="w-0.5 shrink-0 rounded-full bg-primary/60"
          style={{ height: barHeight(level) }}
        />
      ))}
    </div>
  );
}

function VoiceErrorText({ message }: { readonly message: string }): ReactNode {
  return (
    <span className="flex items-center gap-1 text-destructive text-xs" role="alert">
      <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {message}
    </span>
  );
}

export function ScientVoiceComposerControl({
  disabled = false,
  onTranscript,
  onSetDraft,
  getDraft,
  onRequestSubmit,
  className,
}: ScientVoiceComposerControlProps): ReactNode {
  const supported = useMemo(() => isVoiceSupported(), []);
  const bridge = useMemo(() => getVoiceBridge(), []);

  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modelState, setModelState] = useState<VoiceModelState | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<VoiceModelDownloadProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const requestGuardRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<LiveVoicePreviewSession | null>(null);
  const benchmarkStartedRef = useRef(false);
  // Draft-streaming bookkeeping.
  const baseDraftRef = useRef("");
  const lastSetRef = useRef("");
  const userEditedRef = useRef(false);

  const overlayActive = phase === "recording" || phase === "transcribing";
  const anchorRect = useAnchoredRect(overlayActive, rootRef, FOOTER_SELECTOR);

  const canStreamDraft = onSetDraft !== undefined && getDraft !== undefined;

  const restoreBaseIfUntouched = useCallback(() => {
    if (canStreamDraft && !userEditedRef.current && onSetDraft) {
      onSetDraft(baseDraftRef.current);
      lastSetRef.current = baseDraftRef.current;
    }
  }, [canStreamDraft, onSetDraft]);

  const stopLivePreview = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) await session.stop();
  }, []);

  const applyFinalText = useCallback(
    (text: string) => {
      if (userEditedRef.current || !canStreamDraft || !onSetDraft) {
        onTranscript(text);
        return;
      }
      const next = composeDraft(baseDraftRef.current, text);
      onSetDraft(next);
      lastSetRef.current = next;
    },
    [canStreamDraft, onSetDraft, onTranscript],
  );

  const runFinalTranscription = useCallback(
    async (clip: VoiceWavClip | null, options: { readonly send: boolean }): Promise<void> => {
      if (!bridge) return;
      const token = requestGuardRef.current;
      if (!clip) {
        restoreBaseIfUntouched();
        setPhase("idle");
        setErrorMessage(EMPTY_TRANSCRIPT_MESSAGE);
        return;
      }
      setErrorMessage(null);
      setPhase("transcribing");
      try {
        const request: VoiceTranscribeRequest = {
          audioBase64: clip.base64,
          mimeType: "audio/wav",
          sampleRateHz: clip.sampleRateHz,
          durationMs: clip.durationMs,
        };
        const transcript = await bridge.transcribe(request);
        if (token !== requestGuardRef.current) return;
        const text = transcript.text.trim();
        if (text.length === 0) {
          restoreBaseIfUntouched();
          setPhase("idle");
          setErrorMessage(EMPTY_TRANSCRIPT_MESSAGE);
          return;
        }
        setPhase("idle");
        applyFinalText(text);
        if (options.send && onRequestSubmit) {
          requestAnimationFrame(() => onRequestSubmit());
        }
      } catch (error) {
        if (token !== requestGuardRef.current) return;
        restoreBaseIfUntouched();
        setPhase("idle");
        setErrorMessage(describeTranscriptionError(error));
      }
    },
    [bridge, restoreBaseIfUntouched, applyFinalText, onRequestSubmit],
  );

  const handleAutoStop = useCallback(
    (clip: VoiceWavClip | null) => {
      void (async () => {
        await stopLivePreview();
        await runFinalTranscription(clip, { send: false });
      })();
    },
    [stopLivePreview, runFinalTranscription],
  );

  const recorder = useVoiceRecorder({ onAutoStop: handleAutoStop });
  const recorderSnapshot = recorder.snapshot;
  const recorderDuration = recorder.getDurationMs;

  const maybeRunBenchmark = useCallback(() => {
    if (!bridge || benchmarkStartedRef.current || getCachedBenchmark() !== null) return;
    benchmarkStartedRef.current = true;
    void runVoiceBenchmark((request) => bridge.transcribe(request))
      .then(setCachedBenchmark)
      .catch(() => {
        benchmarkStartedRef.current = false;
      });
  }, [bridge]);

  const startLivePreview = useCallback(() => {
    if (!bridge || !canStreamDraft || !onSetDraft || !getDraft) return;
    if (!shouldEnableLivePreview({ benchmark: getCachedBenchmark() })) return;
    const session = new LiveVoicePreviewSession();
    sessionRef.current = session;
    session.start({
      getRecordingDurationMs: () => recorderDuration(),
      onPreview: (text) => {
        if (userEditedRef.current) return;
        // If the draft no longer matches what we last wrote, the user typed —
        // yield the draft to them for the rest of this recording.
        if (getDraft() !== lastSetRef.current) {
          userEditedRef.current = true;
          void stopLivePreview();
          return;
        }
        const next = composeDraft(baseDraftRef.current, text);
        onSetDraft(next);
        lastSetRef.current = next;
      },
      transcribeSnapshot: async (signal) => {
        const clip = recorderSnapshot();
        if (!clip) return null;
        const onAbort = () => void bridge.cancelTranscription();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const transcript = await bridge.transcribe({
            audioBase64: clip.base64,
            mimeType: "audio/wav",
            sampleRateHz: clip.sampleRateHz,
            durationMs: clip.durationMs,
          });
          return { text: transcript.text, durationMs: clip.durationMs };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    });
  }, [
    bridge,
    canStreamDraft,
    onSetDraft,
    getDraft,
    recorderSnapshot,
    recorderDuration,
    stopLivePreview,
  ]);

  const beginRecording = useCallback(async () => {
    requestGuardRef.current += 1;
    setErrorMessage(null);
    setElapsedMs(0);
    baseDraftRef.current = getDraft?.() ?? "";
    lastSetRef.current = baseDraftRef.current;
    userEditedRef.current = false;
    recordingStartedAtRef.current = performance.now();
    setPhase("recording");
    await recorder.start();
    maybeRunBenchmark();
    startLivePreview();
  }, [recorder, getDraft, maybeRunBenchmark, startLivePreview]);

  const handleActivate = useCallback(async () => {
    if (!bridge) return;
    setErrorMessage(null);
    let state = modelState;
    try {
      state = await bridge.getModelState();
      setModelState(state);
    } catch {
      state = modelState;
    }
    if (state && state.state === "ready") {
      maybeRunBenchmark();
      await beginRecording();
    } else {
      setPhase("setup-prompt");
    }
  }, [bridge, modelState, beginRecording, maybeRunBenchmark]);

  const handleModelSetup = useCallback(async () => {
    if (!bridge) return;
    setErrorMessage(null);
    setDownloadProgress(null);
    setPhase("downloading");
    const unsubscribe = bridge.onModelDownloadProgress((progress) => setDownloadProgress(progress));
    try {
      const state = await bridge.downloadModel();
      setModelState(state);
      if (state.state === "ready") {
        maybeRunBenchmark();
        await beginRecording();
      } else {
        setPhase("idle");
        setErrorMessage(MODEL_SETUP_FAILED_MESSAGE);
      }
    } catch (error) {
      setPhase("idle");
      setErrorMessage(describeTranscriptionError(error));
    } finally {
      unsubscribe();
      setDownloadProgress(null);
    }
  }, [bridge, beginRecording, maybeRunBenchmark]);

  const handleStop = useCallback(
    async (options: { readonly send: boolean }) => {
      if (
        phase !== "recording" ||
        performance.now() - recordingStartedAtRef.current < ARM_DELAY_MS
      ) {
        return;
      }
      requestGuardRef.current += 1;
      await stopLivePreview();
      const clip = await recorder.stop();
      await runFinalTranscription(clip, options);
    },
    [phase, stopLivePreview, recorder, runFinalTranscription],
  );

  const handleCancel = useCallback(() => {
    requestGuardRef.current += 1;
    void stopLivePreview();
    recorder.cancel();
    restoreBaseIfUntouched();
    setElapsedMs(0);
    setPhase("idle");
  }, [stopLivePreview, recorder, restoreBaseIfUntouched]);

  const handleDismiss = useCallback(() => {
    requestGuardRef.current += 1;
    setPhase("idle");
    setErrorMessage(null);
  }, []);

  useEffect(() => {
    if (!supported || !bridge) return;
    let active = true;
    void bridge
      .getModelState()
      .then((state) => {
        if (!active) return;
        setModelState(state);
        if (state.state === "ready") maybeRunBenchmark();
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [supported, bridge, maybeRunBenchmark]);

  useEffect(() => {
    if (recorder.status === "error" && recorder.errorKind) {
      void stopLivePreview();
      restoreBaseIfUntouched();
      setPhase("idle");
      setErrorMessage(describeVoiceRecorderError(recorder.errorKind));
    }
  }, [recorder.status, recorder.errorKind, stopLivePreview, restoreBaseIfUntouched]);

  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(interval);
  }, [phase]);

  // Enter = stop+insert, Esc = cancel — captured so the editor never also acts.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void handleStop({ send: false });
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [phase, handleStop, handleCancel]);

  useEffect(() => {
    return () => {
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  if (!supported) return null;

  const overlay =
    overlayActive && anchorRect
      ? createPortal(
          <div
            className="fixed z-40 flex items-center gap-2 bg-background px-3"
            style={{
              top: anchorRect.top,
              left: anchorRect.left,
              width: anchorRect.width,
              height: anchorRect.height,
            }}
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
            />
            {phase === "transcribing" ? (
              <span
                className="flex flex-1 items-center gap-2 text-muted-foreground text-xs"
                role="status"
              >
                <Loader2Icon aria-hidden="true" className="size-4 shrink-0 animate-spin" />
                Transcribing…
              </span>
            ) : (
              <>
                <VoiceWaveform levels={recorder.levels} />
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {formatVoiceTimer(elapsedMs)}
                </span>
                <Button
                  aria-label="Cancel recording (Esc)"
                  onClick={handleCancel}
                  size="icon-sm"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
                <Button
                  aria-label="Insert transcription (Enter)"
                  onClick={() => void handleStop({ send: false })}
                  size="icon-sm"
                  variant="ghost"
                >
                  <CornerDownLeftIcon />
                </Button>
                <Button
                  aria-label="Transcribe and send"
                  onClick={() => void handleStop({ send: true })}
                  size="icon-sm"
                  className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <ArrowUpIcon />
                </Button>
              </>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={cn("flex items-center gap-2", className)}>
      {phase === "setup-prompt" ? (
        <>
          <Button
            disabled={disabled}
            onClick={() => void handleModelSetup()}
            size="sm"
            variant="ghost"
          >
            <DownloadIcon />
            {MODEL_DOWNLOAD_LABEL}
          </Button>
          <Button
            aria-label="Dismiss voice setup"
            onClick={handleDismiss}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </>
      ) : phase === "downloading" ? (
        <div aria-live="polite" className="flex items-center gap-2" role="status">
          <Loader2Icon
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-muted-foreground"
          />
          <span className="text-muted-foreground text-xs">
            Downloading voice model… {downloadPercent(downloadProgress)}%
          </span>
          <Button
            aria-label="Hide voice setup"
            onClick={handleDismiss}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      ) : (
        <>
          <ComposerControl
            aria-label="Dictate a voice message"
            disabled={disabled || overlayActive}
            onClick={() => void handleActivate()}
          >
            <ComposerControlIcon icon={MicIcon} />
          </ComposerControl>
          {errorMessage ? <VoiceErrorText message={errorMessage} /> : null}
        </>
      )}
      {overlay}
    </div>
  );
}
