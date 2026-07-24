// FILE: desktopVoiceService.ts
// Purpose: Composes ChatGPT-first routing, verified local fallback, and model lifecycle.
// Layer: Desktop voice application service

import type {
  DesktopVoiceState,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import {
  isVoiceTranscriptionBackendError,
  type VoiceTranscriptionBackend,
} from "@synara/shared/voiceTranscription";
import {
  VoiceTranscriptionRouter,
  VoiceTranscriptionRoutingError,
} from "@synara/shared/voiceTranscriptionRouter";

import {
  createDesktopChatGptVoiceTranscriptionBackend,
  type DesktopVoiceProcessContext,
} from "./chatGptVoiceTranscription";
import { LocalVoiceModelManager } from "./localVoiceModelManager";
import { LOCAL_VOICE_MODEL } from "./localVoiceModelManifest";
import { LocalWhisperBackend, type LocalWhisperRuntimeLike } from "./localWhisperBackend";
import { normalizeDesktopVoiceRequest } from "./voiceRequest";

export interface DesktopVoiceServiceOptions {
  readonly modelManager: LocalVoiceModelManager;
  readonly runtime: LocalWhisperRuntimeLike;
  readonly createRemoteBackend?: (cwd: string) => VoiceTranscriptionBackend;
  readonly resolveRemoteProcessContext?: () => Promise<DesktopVoiceProcessContext>;
}

export class DesktopVoiceService {
  private readonly localBackend: LocalWhisperBackend;
  private readonly createRemoteBackend: (cwd: string) => VoiceTranscriptionBackend;
  private readonly routers = new Map<string, VoiceTranscriptionRouter>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeTranscriptions = new Set<Promise<ServerVoiceTranscriptionResult>>();
  private disposed = false;
  private modelMutationActive = false;

  constructor(private readonly options: DesktopVoiceServiceOptions) {
    this.localBackend = new LocalWhisperBackend(
      options.modelManager,
      options.runtime,
      () => this.modelMutationActive,
    );
    this.createRemoteBackend =
      options.createRemoteBackend ??
      ((cwd) =>
        createDesktopChatGptVoiceTranscriptionBackend({
          cwd,
          ...(options.resolveRemoteProcessContext
            ? { resolveProcessContext: options.resolveRemoteProcessContext }
            : {}),
        }));
  }

  async getState(): Promise<DesktopVoiceState> {
    const [runtimeAvailable, status] = await Promise.all([
      this.options.runtime.isInstalled(),
      this.options.modelManager.getStatus(),
    ]);
    return {
      runtimeAvailable,
      model: toDesktopModelStatus(status),
      modelName: LOCAL_VOICE_MODEL.displayName,
      modelByteSize: LOCAL_VOICE_MODEL.byteSize,
    };
  }

  async downloadModel(): Promise<DesktopVoiceState> {
    return this.withModelMutation(async () => {
      await this.options.modelManager.ensureInstalled(new AbortController().signal);
      return this.getState();
    });
  }

  async removeModel(): Promise<DesktopVoiceState> {
    if (this.options.runtime.isBusy() || this.options.modelManager.isDownloading()) {
      throw new Error(
        "Wait for the current voice transcription to finish before removing the model.",
      );
    }
    return this.withModelMutation(async () => {
      await this.options.runtime.stopIdle();
      await this.options.modelManager.remove();
      return this.getState();
    });
  }

  async repairModel(): Promise<DesktopVoiceState> {
    if (this.options.runtime.isBusy() || this.options.modelManager.isDownloading()) {
      throw new Error("Wait for current voice activity to finish before repairing the model.");
    }
    return this.withModelMutation(async () => {
      await this.options.runtime.stopIdle();
      await this.options.modelManager.repair(new AbortController().signal);
      return this.getState();
    });
  }

  transcribe(input: unknown): Promise<ServerVoiceTranscriptionResult> {
    if (this.disposed) return Promise.reject(new Error("Voice transcription is shutting down."));
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const transcription = this.transcribeWithSignal(input, controller.signal).finally(() => {
      this.activeControllers.delete(controller);
      this.activeTranscriptions.delete(transcription);
    });
    this.activeTranscriptions.add(transcription);
    return transcription;
  }

  cancelActiveTranscriptions(): void {
    for (const controller of this.activeControllers) {
      controller.abort(new Error("Voice transcription was cancelled."));
    }
  }

  private async transcribeWithSignal(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ServerVoiceTranscriptionResult> {
    const request = normalizeDesktopVoiceRequest(input);
    const router = this.getRouter(request.clip.cwd);
    try {
      const transcript = await router.transcribe(request.clip, {
        signal,
        mode: request.mode,
      });
      return {
        text: transcript.text,
        engine: transcript.engine,
        fallbackUsed: transcript.fallbackUsed,
        ...(transcript.fallbackReason ? { fallbackReason: transcript.fallbackReason } : {}),
      };
    } catch (error) {
      if (signal.aborted) {
        throw new Error("Voice transcription was cancelled.", { cause: error });
      }
      throw new Error(safeVoiceErrorMessage(error), { cause: error });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActiveTranscriptions();
    this.routers.clear();
    await Promise.allSettled([...this.activeTranscriptions]);
    await this.localBackend.dispose();
  }

  private async withModelMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Voice transcription is shutting down.");
    if (
      this.modelMutationActive ||
      this.activeTranscriptions.size > 0 ||
      this.options.runtime.isBusy() ||
      this.options.modelManager.isDownloading()
    ) {
      throw new Error("Wait for current voice activity to finish before changing the model.");
    }
    this.modelMutationActive = true;
    try {
      return await operation();
    } finally {
      this.modelMutationActive = false;
    }
  }

  private getRouter(cwd: string): VoiceTranscriptionRouter {
    const existing = this.routers.get(cwd);
    if (existing) return existing;
    const router = new VoiceTranscriptionRouter({
      remote: this.createRemoteBackend(cwd),
      local: this.localBackend,
    });
    this.routers.set(cwd, router);
    return router;
  }
}

function toDesktopModelStatus(
  status: Awaited<ReturnType<LocalVoiceModelManager["getStatus"]>>,
): DesktopVoiceState["model"] {
  switch (status.state) {
    case "missing":
      return { state: "missing" };
    case "downloading":
      return {
        state: "downloading",
        downloadedBytes: status.downloadedBytes,
        totalBytes: status.totalBytes,
      };
    case "ready":
      return { state: "ready", byteSize: status.byteSize };
    case "error":
      return { state: "error", message: status.message };
  }
}

function safeVoiceErrorMessage(error: unknown): string {
  if (isVoiceTranscriptionBackendError(error)) return error.safeMessage;
  if (error instanceof VoiceTranscriptionRoutingError) {
    const localMessage = safeVoiceErrorMessage(error.localError);
    if (localMessage !== "Voice transcription failed.") return localMessage;
    const remoteMessage = safeVoiceErrorMessage(error.remoteError);
    if (remoteMessage !== "Voice transcription failed.") return remoteMessage;
  }
  return "Voice transcription failed.";
}

export type DesktopVoiceTranscriptionInput = ServerVoiceTranscriptionInput;
