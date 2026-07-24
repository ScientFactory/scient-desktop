// FILE: useComposerVoiceController.ts
// Purpose: Own the composer voice-note state machine for recording, cancellation, and transcription.
// Layer: Chat composer hook
// Depends on: useVoiceRecorder, ChatView voice helper logic, and the native API voice endpoint.

import { type ProviderKind, type ServerProviderStatus, type ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Project } from "../../types";
import { useAppSettings } from "../../appSettings";
import { ensureDesktopVoiceReady, hasDesktopVoiceRuntime } from "../../lib/desktopVoiceSetup";
import { formatVoiceRecordingDuration, useVoiceRecorder } from "../../lib/voiceRecorder";
import { readNativeApi } from "../../nativeApi";
import { transientAlertManager } from "../../notifications/transientAlert";
import {
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
} from "../ChatView.logic";
import type { ComposerVoiceCompletionIntent } from "./composerVoiceState";

export interface ComposerLocalFeedback {
  type: "error" | "info" | "success" | "warning";
  title: string;
  description?: string;
  actionProps?: {
    children: string;
    onClick: () => void;
  };
}

export type ReportComposerLocalFeedback = (feedback: ComposerLocalFeedback) => void;

interface UseComposerVoiceControllerOptions {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  activeProviderStatus: ServerProviderStatus | null;
  pendingUserInputCount: number;
  onTranscriptReady: (transcript: string) => void;
  refreshVoiceStatus: () => void;
  onFeedback?: ReportComposerLocalFeedback;
}

interface UseComposerVoiceControllerResult {
  isVoiceRecording: boolean;
  isVoiceTranscribing: boolean;
  voiceCompletionIntent: ComposerVoiceCompletionIntent | null;
  voiceWaveformLevels: readonly number[];
  voiceRecordingDurationLabel: string;
  showVoiceNotesControl: boolean;
  startComposerVoiceRecording: () => Promise<void>;
  finishComposerVoiceRecording: () => Promise<void>;
  cancelComposerVoiceRecording: () => void;
}

// Keeps the async transcription lifecycle out of ChatView so the component can stay UI-focused.
export function useComposerVoiceController(
  options: UseComposerVoiceControllerOptions,
): UseComposerVoiceControllerResult {
  const {
    activeProject,
    activeThreadId,
    threadId,
    selectedProvider,
    activeProviderStatus,
    pendingUserInputCount,
    onTranscriptReady,
    refreshVoiceStatus,
    onFeedback,
  } = options;
  const { settings } = useAppSettings();
  const desktopVoiceAvailable = hasDesktopVoiceRuntime();
  const {
    isRecording: isVoiceRecording,
    durationMs: voiceRecordingDurationMs,
    waveformLevels: voiceWaveformLevels,
    startRecording: startVoiceRecording,
    stopRecording: stopVoiceRecording,
    cancelRecording: cancelVoiceRecording,
  } = useVoiceRecorder();
  const [voiceCompletionIntent, setVoiceCompletionIntent] =
    useState<ComposerVoiceCompletionIntent | null>(null);
  const isVoiceTranscribing = voiceCompletionIntent !== null;
  const voiceTranscriptionRequestIdRef = useRef(0);
  const voiceCompletionInFlightRef = useRef(false);
  const voiceThreadIdRef = useRef(threadId);
  const voiceProviderRef = useRef<ProviderKind>(selectedProvider);
  voiceThreadIdRef.current = threadId;
  voiceProviderRef.current = selectedProvider;

  const voiceRecordingDurationLabel = useMemo(
    () => formatVoiceRecordingDuration(voiceRecordingDurationMs),
    [voiceRecordingDurationMs],
  );
  const { canStartVoiceNotes, showVoiceNotesControl } = useMemo(
    () =>
      deriveComposerVoiceState({
        authStatus: activeProviderStatus?.authStatus,
        voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable,
        desktopVoiceAvailable,
        isRecording: isVoiceRecording,
        isTranscribing: isVoiceTranscribing,
      }),
    [
      activeProviderStatus?.authStatus,
      activeProviderStatus?.voiceTranscriptionAvailable,
      desktopVoiceAvailable,
      isVoiceRecording,
      isVoiceTranscribing,
    ],
  );
  // This hook is also used by the Kanban task dialog. Composer callers provide
  // an owning-control reporter; the legacy toast is retained only as a fallback
  // for that out-of-scope non-composer consumer until it gains local feedback.
  const reportFeedback = useCallback<ReportComposerLocalFeedback>(
    (feedback) => {
      if (onFeedback) {
        onFeedback(feedback);
        return;
      }
      transientAlertManager.add({
        ...feedback,
        type: feedback.type === "warning" ? "warning" : "error",
      });
    },
    [onFeedback],
  );

  useEffect(() => {
    voiceTranscriptionRequestIdRef.current += 1;
    voiceCompletionInFlightRef.current = false;
    void readNativeApi()?.server.cancelVoiceTranscription?.();
    void cancelVoiceRecording();
    setVoiceCompletionIntent(null);
  }, [cancelVoiceRecording, threadId]);

  useEffect(() => {
    if (canStartVoiceNotes || !isVoiceRecording) {
      return;
    }
    voiceTranscriptionRequestIdRef.current += 1;
    voiceCompletionInFlightRef.current = false;
    void cancelVoiceRecording();
    setVoiceCompletionIntent(null);
  }, [canStartVoiceNotes, cancelVoiceRecording, isVoiceRecording]);

  const startComposerVoiceRecording = useCallback(async () => {
    if (!activeProject) {
      return;
    }
    if (!desktopVoiceAvailable && activeProviderStatus?.authStatus === "unauthenticated") {
      reportFeedback({
        type: "error",
        title: "Sign in to ChatGPT before using voice notes in the browser.",
      });
      return;
    }
    if (!canStartVoiceNotes) {
      reportFeedback({
        type: "error",
        title: "Voice transcription is unavailable in this browser session.",
      });
      return;
    }
    if (pendingUserInputCount > 0) {
      reportFeedback({
        type: "error",
        title: "Answer plan questions before recording a voice note.",
      });
      return;
    }

    if (!(await ensureDesktopVoiceReady(settings.voiceTranscriptionMode, reportFeedback))) return;

    try {
      await startVoiceRecording();
    } catch (error) {
      reportFeedback({
        type: "error",
        title: "Could not start recording",
        description: describeVoiceRecordingStartError(error),
      });
    }
  }, [
    activeProject,
    activeProviderStatus?.authStatus,
    canStartVoiceNotes,
    desktopVoiceAvailable,
    pendingUserInputCount,
    reportFeedback,
    settings.voiceTranscriptionMode,
    startVoiceRecording,
  ]);

  const finishComposerVoiceRecording = useCallback(async () => {
    if (!activeProject || !isVoiceRecording || voiceCompletionInFlightRef.current) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      reportFeedback({
        type: "error",
        title: "Voice transcription is unavailable right now.",
      });
      void cancelVoiceRecording();
      return;
    }

    setVoiceCompletionIntent("insert");
    voiceCompletionInFlightRef.current = true;
    const requestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    const requestProvider = selectedProvider;
    const isCurrentVoiceRequest = () =>
      voiceTranscriptionRequestIdRef.current === requestId &&
      voiceThreadIdRef.current === requestThreadId &&
      voiceProviderRef.current === requestProvider;

    try {
      const payload = await stopVoiceRecording();
      if (!isCurrentVoiceRequest()) {
        return;
      }
      if (!payload) {
        reportFeedback({
          type: "warning",
          title: "No audio was captured.",
        });
        return;
      }
      const result = await api.server.transcribeVoice({
        mode: settings.voiceTranscriptionMode,
        cwd: activeProject.cwd,
        ...(activeThreadId ? { threadId: activeThreadId } : {}),
        ...payload,
      });
      if (!isCurrentVoiceRequest()) {
        return;
      }
      onTranscriptReady(result.text);
    } catch (error) {
      if (!isCurrentVoiceRequest()) {
        return;
      }

      const description =
        error instanceof Error
          ? sanitizeVoiceErrorMessage(error.message)
          : "The voice note could not be transcribed.";
      const authExpired = !desktopVoiceAvailable && isVoiceAuthExpiredMessage(description);
      if (authExpired) {
        refreshVoiceStatus();
      }
      reportFeedback({
        type: "error",
        title: authExpired ? "Sign in to ChatGPT again" : "Voice transcription failed",
        description: authExpired
          ? "Your ChatGPT session was rejected. Sign in again and retry."
          : description,
        ...(authExpired
          ? {
              actionProps: {
                children: "Refresh status",
                onClick: refreshVoiceStatus,
              },
            }
          : {}),
      });
    } finally {
      if (isCurrentVoiceRequest()) {
        voiceCompletionInFlightRef.current = false;
        setVoiceCompletionIntent(null);
      }
    }
  }, [
    activeProject,
    activeThreadId,
    cancelVoiceRecording,
    desktopVoiceAvailable,
    isVoiceRecording,
    onTranscriptReady,
    reportFeedback,
    refreshVoiceStatus,
    selectedProvider,
    settings.voiceTranscriptionMode,
    stopVoiceRecording,
    threadId,
  ]);

  const cancelComposerVoiceRecording = useCallback(() => {
    voiceTranscriptionRequestIdRef.current += 1;
    voiceCompletionInFlightRef.current = false;
    setVoiceCompletionIntent(null);
    void readNativeApi()?.server.cancelVoiceTranscription?.();
    void cancelVoiceRecording();
  }, [cancelVoiceRecording]);

  return {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceCompletionIntent,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    finishComposerVoiceRecording,
    cancelComposerVoiceRecording,
  };
}
