import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  VoiceModelDownloadProgress,
  VoiceModelId,
  VoiceModelsSnapshot,
  VoiceLanguagePreference,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils.ts";

import { type VoiceRecorderErrorKind, useVoiceRecorder } from "./useVoiceRecorder.ts";
import type { VoiceTranscriptionClient } from "./voiceClient.ts";
import {
  deliverVoiceTranscriptToDraft,
  reportVoiceDraftFailure,
  type VoiceDraftOrigin,
} from "./voiceDraftDelivery.ts";
import { describeVoiceError } from "./voiceErrorPresentation.ts";
import {
  cancelVoiceJob,
  cancelVoiceJobsForOwner,
  clearVoiceJobError,
  finishVoiceJobWithOriginal,
  setVoiceJobError,
  startVoiceJob,
  useVoiceJob,
  useVoiceJobError,
} from "./voiceProcessing.ts";
import type { VoiceWavClip } from "./voiceWavEncoder.ts";
import { useRecordScientAnalytics } from "../analytics/client.ts";
import type { VoiceTranscriptCorrectionClient } from "./voiceTranscriptCorrectionClient.ts";

export type VoicePhase =
  | "idle"
  | "setup-prompt"
  | "downloading"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "correcting";

const MODEL_SETUP_FAILED_MESSAGE = "Voice setup didn't finish. Try again.";
const ARM_DELAY_MS = 250;

interface VoiceControllerOptions {
  readonly client: VoiceTranscriptionClient | null;
  readonly correctionClient?: VoiceTranscriptCorrectionClient | null;
  readonly correctionEnabled?: boolean;
  readonly languagePreference?: VoiceLanguagePreference;
  readonly environmentId?: EnvironmentId;
  /**
   * The composer draft a stop click commits to. With an origin, a committed
   * dictation outlives this control and lands in that draft; without one it
   * stays local, ends with the control and uses the callbacks below.
   */
  readonly draftOrigin?: VoiceDraftOrigin | null;
  /**
   * Identity of the field local dictation fills, such as one question's answer.
   * Local dictation is delivered only to the field it started in; when the field
   * changes or closes first, the dictation ends with it.
   */
  readonly localFieldKey?: string | null;
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
  readonly microphonePermissionDenied: boolean;
  readonly downloadPercent: number;
  readonly modelSnapshot: VoiceModelsSnapshot | null;
  activate: () => Promise<void>;
  setupModel: (modelId?: VoiceModelId) => Promise<void>;
  dismissSetup: () => void;
  stop: (send: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  useOriginal: () => void;
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

function percent(progress: VoiceModelDownloadProgress | null): number {
  if (!progress || progress.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
}

export function useScientVoiceController({
  client,
  correctionClient = null,
  correctionEnabled = false,
  languagePreference = "auto",
  environmentId,
  draftOrigin = null,
  localFieldKey = null,
  onTranscript,
  onRequestSubmit,
}: VoiceControllerOptions): ScientVoiceController {
  const recordAnalytics = useRecordScientAnalytics();
  const [localPhase, setPhaseState] = useState<VoicePhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [microphonePermissionDenied, setMicrophonePermissionDenied] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<VoiceModelDownloadProgress | null>(null);
  const [modelSnapshot, setModelSnapshot] = useState<VoiceModelsSnapshot | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const phaseRef = useRef<VoicePhase>("idle");
  const operationRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const downloadModelIdRef = useRef<VoiceModelId | null>(null);
  const autoStopRef = useRef<(clip: VoiceWavClip | null) => void>(() => undefined);
  const completionCallbacksRef = useRef<VoiceCompletionCallbacks>({
    onTranscript,
    onRequestSubmit,
  });
  completionCallbacksRef.current = { onTranscript, onRequestSubmit };
  const draftOriginRef = useRef(draftOrigin);
  draftOriginRef.current = draftOrigin;
  const localFieldKeyRef = useRef(localFieldKey);
  localFieldKeyRef.current = localFieldKey;

  // Committed dictation is shown by owner key: the draft's key for composer
  // drafts (so returning to a thread shows its job), else this control alone.
  const [localOwnerKey] = useState(() => `local:${randomUUID()}`);
  const draftOwnerKey = draftOrigin ? `draft:${draftOrigin.key}` : null;
  const localJob = useVoiceJob(localOwnerKey);
  const draftJob = useVoiceJob(draftOwnerKey);
  const job = localJob ?? draftJob;
  const localJobError = useVoiceJobError(localOwnerKey);
  const draftJobError = useVoiceJobError(draftOwnerKey);
  const phase: VoicePhase = localPhase !== "idle" ? localPhase : (job?.phase ?? "idle");

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const clearErrors = useCallback(() => {
    setErrorMessage(null);
    setMicrophonePermissionDenied(false);
    clearVoiceJobError(localOwnerKey);
    clearVoiceJobError(draftOriginRef.current ? `draft:${draftOriginRef.current.key}` : null);
  }, [localOwnerKey]);

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

  /**
   * Hands a committed stop to the window-level job owner. Everything the job
   * needs, including where its text goes, is captured here, synchronously.
   */
  const commit = useCallback(
    (clip: Promise<VoiceWavClip | null>, send: boolean): Promise<void> => {
      if (!client) return Promise.resolve();
      setPhase("idle");
      setErrorMessage(null);
      const origin = draftOriginRef.current;
      const fieldKey = localFieldKeyRef.current;
      const ownerKey = origin ? `draft:${origin.key}` : localOwnerKey;
      const correctionRequested =
        correctionEnabled && correctionClient !== null && environmentId !== undefined;
      const { done } = startVoiceJob({
        ownerKey,
        clip,
        send,
        voiceBridge: client,
        correction: correctionRequested ? { corrector: correctionClient, environmentId } : null,
        language: languagePreference === "auto" ? undefined : languagePreference,
        recordAnalytics,
        deliver: origin
          ? (text, sendText) => deliverVoiceTranscriptToDraft(origin, text, sendText)
          : (text, sendText) => {
              if (localFieldKeyRef.current !== fieldKey) return;
              routeCompletedVoiceTranscription(completionCallbacksRef, text, sendText);
            },
        fail: origin
          ? (message) =>
              reportVoiceDraftFailure(origin, message, (shown) => setVoiceJobError(ownerKey, shown))
          : (message) => setVoiceJobError(ownerKey, message),
      });
      return done;
    },
    [
      client,
      correctionClient,
      correctionEnabled,
      environmentId,
      languagePreference,
      localOwnerKey,
      recordAnalytics,
      setPhase,
    ],
  );

  const useOriginal = useCallback((): void => {
    if (job?.phase === "correcting") finishVoiceJobWithOriginal(job.id);
  }, [job]);

  const beginRecording = useCallback(async (): Promise<void> => {
    const operation = (operationRef.current += 1);
    clearErrors();
    setElapsedMs(0);
    setPhase("requesting-permission");
    if (client?.requestMicrophoneAccess) {
      const access = await client.requestMicrophoneAccess().catch(() => "unavailable" as const);
      if (operation !== operationRef.current) return;
      if (access === "denied" || access === "restricted") {
        setPhase("idle");
        setMicrophonePermissionDenied(access === "denied");
        setErrorMessage(
          access === "restricted"
            ? "Microphone access is restricted by this Mac. Check parental controls or contact your administrator."
            : "Microphone access is off. Enable Scient in System Settings, then restart Scient.",
        );
        recordAnalytics({
          name: "voice.transcription.failed",
          properties: { engineClass: "local-whisper", failureClass: "permission" },
        });
        return;
      }
    }
    const started = await startRecording();
    if (operation !== operationRef.current) {
      cancelRecording();
      return;
    }
    if (!started) return;
    recordingStartedAtRef.current = performance.now();
    setPhase("recording");
  }, [cancelRecording, clearErrors, client, recordAnalytics, setPhase, startRecording]);

  const activate = useCallback(async (): Promise<void> => {
    if (!client) return;
    const operation = (operationRef.current += 1);
    clearErrors();
    let state: VoiceModelsSnapshot;
    try {
      state = await client.getModelsState();
      setModelSnapshot(state);
      if (operation !== operationRef.current) return;
    } catch (error) {
      if (operation !== operationRef.current) return;
      setErrorMessage(describeVoiceError(error));
      return;
    }
    const selectedModel = state.models.find((model) => model.id === state.selectedModelId);
    if (selectedModel?.state.state === "ready") await beginRecording();
    else if (!state.runtimeAvailable) {
      setErrorMessage(state.runtimeMessage ?? "Offline voice is unavailable.");
    } else {
      setPhase("setup-prompt");
    }
  }, [beginRecording, clearErrors, client, setPhase]);

  const setupModel = useCallback(
    async (requestedModelId?: VoiceModelId): Promise<void> => {
      if (!client) return;
      const operation = (operationRef.current += 1);
      clearErrors();
      setDownloadProgress(null);
      setPhase("downloading");
      let modelId: VoiceModelId | null = null;
      let unsubscribe: () => void = () => undefined;
      try {
        const snapshot = modelSnapshot ?? (await client.getModelsState());
        if (operation !== operationRef.current) return;
        setModelSnapshot(snapshot);
        modelId =
          requestedModelId ?? snapshot.recommendation?.modelId ?? snapshot.models[0]?.id ?? null;
        if (!modelId) {
          setPhase("idle");
          setErrorMessage(MODEL_SETUP_FAILED_MESSAGE);
          return;
        }
        downloadModelIdRef.current = modelId;
        unsubscribe = client.onModelDownloadProgress(setDownloadProgress);
        const nextSnapshot = await client.downloadModel({ modelId, selectOnSuccess: true });
        setModelSnapshot(nextSnapshot);
        if (operation !== operationRef.current) return;
        const state = nextSnapshot.models.find((model) => model.id === modelId)?.state;
        if (state?.state === "ready") await beginRecording();
        else {
          setPhase("idle");
          setErrorMessage(
            state?.state === "error" || state?.state === "unavailable"
              ? state.message
              : MODEL_SETUP_FAILED_MESSAGE,
          );
        }
      } catch (error) {
        if (operation !== operationRef.current) return;
        setPhase("idle");
        setErrorMessage(describeVoiceError(error));
      } finally {
        unsubscribe();
        if (downloadModelIdRef.current === modelId) downloadModelIdRef.current = null;
        if (operation === operationRef.current) setDownloadProgress(null);
      }
    },
    [beginRecording, clearErrors, client, modelSnapshot, setPhase],
  );

  const stop = useCallback(
    (send: boolean): Promise<void> => {
      if (
        phaseRef.current !== "recording" ||
        performance.now() - recordingStartedAtRef.current < ARM_DELAY_MS
      ) {
        return Promise.resolve();
      }
      operationRef.current += 1;
      // Starts the recorder's final flush and commits it in the same task, so
      // leaving the thread right after the click cannot drop the dictation.
      return commit(stopRecording(), send);
    },
    [commit, stopRecording],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const cancelledPhase = phaseRef.current;
    const operation = (operationRef.current += 1);
    const cancelDownload =
      phaseRef.current === "downloading"
        ? client
            ?.cancelModelDownload({
              modelId: downloadModelIdRef.current ?? "whisper-small-multilingual-q5_1",
            })
            .catch(() => undefined)
        : undefined;
    const cancelJob = cancelledPhase === "idle" && job ? cancelVoiceJob(job.id) : undefined;
    phaseRef.current = "idle";
    await Promise.all([cancelRecording(), cancelDownload, cancelJob]);
    if (operation !== operationRef.current) return;
    if (cancelledPhase === "recording") {
      recordAnalytics({
        name: "voice.transcription.cancelled",
        properties: { stage: cancelledPhase },
      });
    }
    setElapsedMs(0);
    clearErrors();
    setPhase("idle");
  }, [cancelRecording, clearErrors, client, job, recordAnalytics, setPhase]);

  const dismissSetup = useCallback(() => {
    operationRef.current += 1;
    clearErrors();
    setPhase("idle");
  }, [clearErrors, setPhase]);

  autoStopRef.current = (clip) => {
    if (phaseRef.current !== "recording") return;
    operationRef.current += 1;
    void commit(Promise.resolve(clip), false);
  };

  useEffect(() => {
    if (recorderStatus !== "error" || !recorderErrorKind) return;
    setPhase("idle");
    setMicrophonePermissionDenied(recorderErrorKind === "permission-denied");
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

  // Local dictation belongs to the field it started in, such as one question's
  // answer; a different or closed field ends it rather than receiving its text.
  useEffect(() => {
    if (localFieldKey === null) return undefined;
    return () => cancelVoiceJobsForOwner(localOwnerKey);
  }, [localFieldKey, localOwnerKey]);

  // Unmounting ends what this control still owns: an unfinished recording or
  // permission request, and local (non-draft) dictation. A dictation committed
  // to a composer draft belongs to its job and keeps going.
  useEffect(
    () => () => {
      operationRef.current += 1;
      phaseRef.current = "idle";
      void cancelRecording();
      cancelVoiceJobsForOwner(localOwnerKey);
      clearVoiceJobError(localOwnerKey);
    },
    [cancelRecording, localOwnerKey],
  );

  return {
    phase,
    levels: recorderLevels,
    elapsedMs,
    errorMessage: errorMessage ?? localJobError ?? draftJobError,
    microphonePermissionDenied,
    downloadPercent: percent(downloadProgress),
    modelSnapshot,
    activate,
    setupModel,
    dismissSetup,
    stop,
    cancel,
    useOriginal,
  };
}
