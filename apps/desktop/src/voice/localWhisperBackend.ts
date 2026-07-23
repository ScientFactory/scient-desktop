// FILE: localWhisperBackend.ts
// Purpose: Implements the provider-neutral local backend with the verified Small Q5 model.
// Layer: Desktop voice runtime

import {
  type NormalizedVoiceClip,
  type VoiceTranscriptionBackend,
  type VoiceTranscriptionBackendAvailability,
  VoiceTranscriptionBackendError,
  type VoiceTranscript,
} from "@synara/shared/voiceTranscription";
import type { LocalVoiceModelManager } from "./localVoiceModelManager";
import { LocalWhisperRuntimeError } from "./localWhisperRuntime";

export interface LocalWhisperRuntimeLike {
  isInstalled(): Promise<boolean>;
  isBusy(): boolean;
  stopIdle(): Promise<void>;
  transcribe(
    modelPath: string,
    clip: NormalizedVoiceClip,
    signal: AbortSignal,
  ): Promise<VoiceTranscript>;
  dispose(): Promise<void>;
}

export class LocalWhisperBackend implements VoiceTranscriptionBackend {
  readonly id = "local" as const;

  constructor(
    private readonly modelManager: LocalVoiceModelManager,
    private readonly runtime: LocalWhisperRuntimeLike,
    private readonly isMaintenanceActive: () => boolean = () => false,
  ) {}

  async getAvailability(): Promise<VoiceTranscriptionBackendAvailability> {
    if (this.isMaintenanceActive()) {
      return {
        state: "temporarily-unavailable",
        reason: "Offline voice model maintenance is in progress.",
      };
    }
    const runtimeInstalled = await this.runtime.isInstalled();
    if (!runtimeInstalled) {
      return { state: "unavailable", reason: "The bundled offline voice runtime is missing." };
    }
    const modelStatus = await this.modelManager.getStatus();
    if (
      modelStatus.state === "ready" ||
      (modelStatus.state === "downloading" && modelStatus.readyModelPath)
    ) {
      return { state: "ready" };
    }
    if (modelStatus.state === "downloading") {
      return {
        state: "temporarily-unavailable",
        reason: "The offline voice model is still downloading.",
      };
    }
    return { state: "requires-setup", reason: "model-not-installed" };
  }

  async transcribe(
    clip: NormalizedVoiceClip,
    options: { readonly signal: AbortSignal },
  ): Promise<VoiceTranscript> {
    options.signal.throwIfAborted();
    if (this.isMaintenanceActive()) {
      throw new VoiceTranscriptionBackendError({
        kind: "backend-unavailable",
        fallbackAllowed: false,
        safeMessage: "Wait for offline voice model maintenance to finish.",
      });
    }
    const status = await this.modelManager.getStatus();
    const modelPath =
      status.state === "ready"
        ? status.modelPath
        : status.state === "downloading"
          ? status.readyModelPath
          : undefined;
    if (!modelPath) {
      throw new VoiceTranscriptionBackendError({
        kind: "backend-unavailable",
        fallbackAllowed: false,
        safeMessage: "Set up offline voice transcription before using the microphone.",
      });
    }
    try {
      return await this.runtime.transcribe(modelPath, clip, options.signal);
    } catch (error) {
      if (options.signal.aborted) {
        throw new VoiceTranscriptionBackendError({
          kind: "cancelled",
          fallbackAllowed: false,
          safeMessage: "Voice transcription was cancelled.",
          cause: error,
        });
      }
      if (error instanceof LocalWhisperRuntimeError && error.kind === "timeout") {
        throw new VoiceTranscriptionBackendError({
          kind: "timeout",
          fallbackAllowed: false,
          safeMessage: "Offline voice transcription timed out.",
          cause: error,
        });
      }
      if (error instanceof LocalWhisperRuntimeError && error.kind === "disposed") {
        throw new VoiceTranscriptionBackendError({
          kind: "backend-unavailable",
          fallbackAllowed: false,
          safeMessage: "Offline voice transcription is shutting down.",
          cause: error,
        });
      }
      throw new VoiceTranscriptionBackendError({
        kind: "provider-error",
        fallbackAllowed: false,
        safeMessage: "Offline voice transcription failed.",
        cause: error,
      });
    }
  }

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}
