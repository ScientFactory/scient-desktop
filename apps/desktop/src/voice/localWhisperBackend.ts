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

export interface LocalWhisperRuntimeLike {
  isInstalled(): Promise<boolean>;
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
  ) {}

  async getAvailability(): Promise<VoiceTranscriptionBackendAvailability> {
    const runtimeInstalled = await this.runtime.isInstalled();
    if (!runtimeInstalled) {
      return { state: "unavailable", reason: "The bundled offline voice runtime is missing." };
    }
    const modelStatus = await this.modelManager.getStatus();
    if (modelStatus.state === "ready") return { state: "ready" };
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
    const status = await this.modelManager.getStatus();
    if (status.state !== "ready") {
      throw new VoiceTranscriptionBackendError({
        kind: "backend-unavailable",
        fallbackAllowed: false,
        safeMessage: "Set up offline voice transcription before using the microphone.",
      });
    }
    try {
      return await this.runtime.transcribe(status.modelPath, clip, options.signal);
    } catch (error) {
      if (options.signal.aborted) {
        throw new VoiceTranscriptionBackendError({
          kind: "cancelled",
          fallbackAllowed: false,
          safeMessage: "Voice transcription was cancelled.",
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
