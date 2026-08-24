// The engine-neutral `TranscriptionEngine` interface and its only current
// implementation: a local whisper.cpp engine.
//
// The interface is deliberately engine-neutral (results carry `engine`) so a
// remote engine could be added later, but only `local` is implemented today.
// This ties together the model manager (download/verify) and the whisper
// runtime (inference), and maps low-level failures into the shared
// `VoiceTranscriptionError` taxonomy (lifted from the old `localWhisperBackend`).

import {
  type NormalizedVoiceClip,
  type VoiceEngineId,
  VoiceTranscriptionError,
  type VoiceTranscript,
} from "./errors.ts";
import type { VoiceModelDefinition } from "./modelManifest.ts";
import { DEFAULT_VOICE_MODEL_ID } from "./modelManifest.ts";
import {
  type VoiceModelDownloadProgressCallback,
  type VoiceModelState,
  VoiceModelManager,
} from "./modelManager.ts";
import { LocalWhisperRuntime, type WhisperSpawn, WhisperRuntimeError } from "./whisperRuntime.ts";

export interface TranscribeOptions {
  readonly signal: AbortSignal;
  readonly language?: string;
}

/** Engine-neutral transcription surface. Implemented today only by local whisper. */
export interface TranscriptionEngine {
  readonly engine: VoiceEngineId;
  /** Current install/download state of the backing model. */
  getModelState(): Promise<VoiceModelState>;
  /** Get the state for a specific catalog model. */
  getModelStateForModel(modelId: string): Promise<VoiceModelState>;
  /** Get every catalog model state without exposing filesystem paths. */
  getModelStates(): Promise<Readonly<Record<string, VoiceModelState>>>;
  /** Ensure the model is downloaded and verified. Resolves the model path. */
  ensureModel(
    onProgress?: VoiceModelDownloadProgressCallback,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Ensure a specific catalog model is downloaded and verified. */
  ensureModelForModel(
    modelId: string,
    signal: AbortSignal,
    onProgress?: VoiceModelDownloadProgressCallback,
  ): Promise<string>;
  /** Remove the model after stopping the runtime that may hold it open. */
  removeModel(): Promise<void>;
  /** Remove a specific catalog model after stopping the shared runtime. */
  removeModelForModel(modelId: string): Promise<void>;
  /** Stop the idle helper before model maintenance. */
  stopRuntime(): Promise<void>;
  /** Whether the platform helper exists at the configured runtime path. */
  isRuntimeInstalled(): Promise<boolean>;
  /** Transcribe a validated clip. Rejects with a {@link VoiceTranscriptionError}. */
  transcribe(clip: NormalizedVoiceClip, options: TranscribeOptions): Promise<VoiceTranscript>;
  /** Transcribe a validated clip with a specific catalog model. */
  transcribeForModel(
    modelId: string,
    clip: NormalizedVoiceClip,
    options: TranscribeOptions,
  ): Promise<VoiceTranscript>;
  /** Tear down the backing runtime process. */
  dispose(): Promise<void>;
}

export interface LocalWhisperEngineOptions {
  readonly runtimeDir: string;
  readonly modelDir: string;
  /** Legacy single-model option retained for callers and tests. */
  readonly manifest?: VoiceModelDefinition;
  /** The complete catalog used by the desktop multi-model owner. */
  readonly manifests?: readonly VoiceModelDefinition[];
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: WhisperSpawn;
  readonly threads?: number;
  readonly idleTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Optional gate that blocks transcription while model maintenance runs. */
  readonly isMaintenanceActive?: () => boolean;
}

/**
 * Create the local whisper.cpp transcription engine. The model manager and
 * runtime are constructed eagerly; the whisper process itself only starts on
 * the first `transcribe` and idles down between clips.
 */
export function createLocalWhisperEngine(options: LocalWhisperEngineOptions): TranscriptionEngine {
  const definitions = options.manifests ?? (options.manifest ? [options.manifest] : []);
  if (definitions.length === 0) {
    throw new Error("At least one offline voice model definition is required.");
  }
  const managers = new Map(
    definitions.map((manifest) => [
      manifest.id,
      new VoiceModelManager({
        modelsDirectory: options.modelDir,
        manifest,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    ]),
  );
  const defaultModelId = managers.has(DEFAULT_VOICE_MODEL_ID)
    ? DEFAULT_VOICE_MODEL_ID
    : definitions[0]!.id;
  const runtime = new LocalWhisperRuntime({
    runtimeDirectory: options.runtimeDir,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    ...(options.threads !== undefined ? { threads: options.threads } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const isMaintenanceActive = options.isMaintenanceActive ?? (() => false);

  return {
    engine: "local",

    getModelState(): Promise<VoiceModelState> {
      return managers.get(defaultModelId)!.getStatus();
    },

    getModelStateForModel(modelId: string): Promise<VoiceModelState> {
      return requireManager(managers, modelId).getStatus();
    },

    async getModelStates(): Promise<Readonly<Record<string, VoiceModelState>>> {
      const entries = await Promise.all(
        [...managers.entries()].map(
          async ([modelId, manager]) => [modelId, await manager.getStatus()] as const,
        ),
      );
      return Object.fromEntries(entries);
    },

    ensureModel(
      onProgress?: VoiceModelDownloadProgressCallback,
      signal?: AbortSignal,
    ): Promise<string> {
      return managers
        .get(defaultModelId)!
        .ensureInstalled(signal ?? new AbortController().signal, onProgress);
    },

    ensureModelForModel(
      modelId: string,
      signal: AbortSignal,
      onProgress?: VoiceModelDownloadProgressCallback,
    ): Promise<string> {
      return requireManager(managers, modelId).ensureInstalled(signal, onProgress);
    },

    async removeModel(): Promise<void> {
      await runtime.stopIdle();
      await managers.get(defaultModelId)!.remove();
    },

    async removeModelForModel(modelId: string): Promise<void> {
      await runtime.stopIdle();
      await requireManager(managers, modelId).remove();
    },

    stopRuntime(): Promise<void> {
      return runtime.stopIdle();
    },

    isRuntimeInstalled(): Promise<boolean> {
      return runtime.isInstalled();
    },

    async transcribe(
      clip: NormalizedVoiceClip,
      transcribeOptions: TranscribeOptions,
    ): Promise<VoiceTranscript> {
      transcribeOptions.signal.throwIfAborted();
      if (isMaintenanceActive()) {
        throw new VoiceTranscriptionError({
          kind: "backend-unavailable",
          fallbackAllowed: false,
          safeMessage: "Wait for offline voice model maintenance to finish.",
        });
      }

      const status = await managers.get(defaultModelId)!.getStatus();
      const modelPath =
        status.state === "ready"
          ? status.modelPath
          : status.state === "downloading"
            ? status.readyModelPath
            : undefined;
      if (!modelPath) {
        throw new VoiceTranscriptionError({
          kind: "model-missing",
          fallbackAllowed: false,
          safeMessage: "Set up offline voice transcription before using the microphone.",
        });
      }

      try {
        const result = await runtime.transcribe(modelPath, clip, {
          signal: transcribeOptions.signal,
          ...(transcribeOptions.language !== undefined
            ? { language: transcribeOptions.language }
            : {}),
        });
        return {
          text: result.text,
          engine: "local",
          ...(transcribeOptions.language !== undefined
            ? { language: transcribeOptions.language }
            : {}),
        };
      } catch (error) {
        throw mapRuntimeError(error, transcribeOptions.signal);
      }
    },

    async transcribeForModel(
      modelId: string,
      clip: NormalizedVoiceClip,
      transcribeOptions: TranscribeOptions,
    ): Promise<VoiceTranscript> {
      transcribeOptions.signal.throwIfAborted();
      if (isMaintenanceActive()) {
        throw new VoiceTranscriptionError({
          kind: "backend-unavailable",
          fallbackAllowed: false,
          safeMessage: "Wait for offline voice model maintenance to finish.",
        });
      }

      const status = await requireManager(managers, modelId).getStatus();
      const modelPath =
        status.state === "ready"
          ? status.modelPath
          : status.state === "downloading"
            ? status.readyModelPath
            : undefined;
      if (!modelPath) {
        throw new VoiceTranscriptionError({
          kind: "model-missing",
          fallbackAllowed: false,
          safeMessage: "Set up offline voice transcription before using the microphone.",
        });
      }

      try {
        const result = await runtime.transcribe(modelPath, clip, {
          signal: transcribeOptions.signal,
          ...(transcribeOptions.language !== undefined
            ? { language: transcribeOptions.language }
            : {}),
        });
        return {
          text: result.text,
          engine: "local",
          ...(transcribeOptions.language !== undefined
            ? { language: transcribeOptions.language }
            : {}),
        };
      } catch (error) {
        throw mapRuntimeError(error, transcribeOptions.signal);
      }
    },

    dispose(): Promise<void> {
      return runtime.dispose();
    },
  };
}

function requireManager(
  managers: ReadonlyMap<string, VoiceModelManager>,
  modelId: string,
): VoiceModelManager {
  const manager = managers.get(modelId);
  if (!manager) throw new Error(`Unknown offline voice model: ${modelId}`);
  return manager;
}

function mapRuntimeError(error: unknown, signal: AbortSignal): VoiceTranscriptionError {
  if (error instanceof VoiceTranscriptionError) {
    return error;
  }
  if (signal.aborted) {
    return new VoiceTranscriptionError({
      kind: "cancelled",
      fallbackAllowed: false,
      safeMessage: "Voice transcription was cancelled.",
      cause: error,
    });
  }
  if (error instanceof WhisperRuntimeError && error.kind === "timeout") {
    return new VoiceTranscriptionError({
      kind: "timeout",
      fallbackAllowed: false,
      safeMessage: "Offline voice transcription timed out.",
      cause: error,
    });
  }
  if (error instanceof WhisperRuntimeError && error.kind === "disposed") {
    return new VoiceTranscriptionError({
      kind: "backend-unavailable",
      fallbackAllowed: false,
      safeMessage: "Offline voice transcription is shutting down.",
      cause: error,
    });
  }
  return new VoiceTranscriptionError({
    kind: "provider-error",
    fallbackAllowed: false,
    safeMessage: "Offline voice transcription failed.",
    cause: error,
  });
}
