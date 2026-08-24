// @effect-diagnostics nodeBuiltinImport:off
//
// Desktop main-process owner of local voice. The renderer only sees the safe
// catalog snapshot; this service owns model selection, persistence, downloads,
// removal, and the single shared whisper.cpp runtime.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createLocalWhisperEngine,
  getVoiceModelDefinition,
  isVoiceTranscriptionError,
  normalizeVoiceClip,
  VOICE_MODEL_DEFINITIONS,
  type TranscriptionEngine,
  type VoiceModelState as CoreVoiceModelState,
} from "@scientfactory/scient-voice";
import type {
  VoiceModelDownloadRequest,
  VoiceModelId,
  VoiceModelOperationRequest,
  VoiceModelRemoveRequest,
  VoiceModelsSnapshot,
  VoiceModelState,
  VoiceModelSummary,
  VoiceTranscribeRequest,
  VoiceTranscript,
  VoiceModelRecommendation,
} from "@t3tools/contracts";
import {
  VoiceModelId as VoiceModelIdSchema,
  VoiceTranscriptionErrorKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export class VoiceRequestError extends Schema.TaggedErrorClass<VoiceRequestError>()(
  "VoiceRequestError",
  {
    kind: VoiceTranscriptionErrorKind,
    safeMessage: Schema.String,
  },
) {
  override get message(): string {
    return this.safeMessage;
  }
}

const isVoiceRequestError = Schema.is(VoiceRequestError);
const isVoiceModelId = Schema.is(VoiceModelIdSchema);

function toVoiceRequestError(
  cause: unknown,
  operation: "download" | "remove" = "download",
): VoiceRequestError {
  if (isVoiceRequestError(cause)) return cause;
  if (isVoiceTranscriptionError(cause)) {
    return new VoiceRequestError({ kind: cause.kind, safeMessage: cause.safeMessage });
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    return new VoiceRequestError({
      kind: "cancelled",
      safeMessage: "Offline voice setup was cancelled.",
    });
  }
  return new VoiceRequestError({
    kind: "provider-error",
    safeMessage:
      operation === "download"
        ? "Offline voice setup failed. Please try again."
        : "The offline voice model could not be removed. Please try again.",
  });
}

export function toVoiceModelRequestError(
  cause: unknown,
  operation: "download" | "remove",
): VoiceRequestError {
  return toVoiceRequestError(cause, operation);
}

export class DesktopVoice extends Context.Service<
  DesktopVoice,
  {
    readonly getModelsState: Effect.Effect<VoiceModelsSnapshot>;
    readonly downloadModel: (
      request: VoiceModelDownloadRequest,
    ) => Effect.Effect<VoiceModelsSnapshot, VoiceRequestError>;
    readonly cancelModelDownload: (request: VoiceModelOperationRequest) => Effect.Effect<void>;
    readonly selectModel: (
      request: VoiceModelOperationRequest,
    ) => Effect.Effect<VoiceModelsSnapshot, VoiceRequestError>;
    readonly removeModel: (
      request: VoiceModelRemoveRequest,
    ) => Effect.Effect<VoiceModelsSnapshot, VoiceRequestError>;
    readonly cancelTranscription: Effect.Effect<void>;
    readonly transcribe: (
      request: VoiceTranscribeRequest,
    ) => Effect.Effect<VoiceTranscript, VoiceRequestError>;
  }
>()("@t3tools/desktop/app/DesktopVoice") {}

const RUNTIME_UNAVAILABLE_MESSAGE =
  "Offline voice transcription is not available in this desktop build.";

const MODEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "whisper-small-multilingual-q5_1": "Faster and lighter for everyday dictation.",
  "whisper-medium-multilingual-q5_0": "Higher accuracy with a larger local model.",
};

function isReady(state: CoreVoiceModelState): boolean {
  return state.state === "ready";
}

function toPublicModelId(id: string): VoiceModelId {
  if (!isVoiceModelId(id)) throw new Error(`Unsupported offline voice model: ${id}`);
  return id;
}

export function projectVoiceModelState(state: CoreVoiceModelState): VoiceModelState {
  switch (state.state) {
    case "missing":
      return {
        state: "missing",
        ...(state.partialBytes !== undefined ? { partialBytes: state.partialBytes } : {}),
      };
    case "downloading":
      return {
        state: "downloading",
        downloadedBytes: state.downloadedBytes,
        totalBytes: state.totalBytes,
      };
    case "ready":
      return { state: "ready", byteSize: state.byteSize };
    case "error":
      return { state: "error", message: state.message };
  }
}

async function resolveFreeBytes(path: string): Promise<number> {
  for (const candidate of [path, NodePath.dirname(path)]) {
    try {
      const stats = await NodeFSP.statfs(candidate);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // The model directory may not exist on a first install; its parent is
      // the same filesystem and is sufficient for a conservative preflight.
    }
  }
  return Number.POSITIVE_INFINITY;
}

async function resolveRecommendation(
  modelDir: string,
  runtimeAvailable: boolean,
  platform: NodeJS.Platform,
  runningUnderArm64Translation: boolean,
): Promise<VoiceModelRecommendation | null> {
  if (!runtimeAvailable) return null;
  const medium = getVoiceModelDefinition("whisper-medium-multilingual-q5_0");
  if (!medium) return null;
  const freeBytes = await resolveFreeBytes(modelDir);
  const requiredBytes = medium.byteSize + 512 * 1024 * 1024;
  const native = platform !== "darwin" || !runningUnderArm64Translation;
  const enoughCompute = NodeOS.availableParallelism() >= 8 && NodeOS.totalmem() >= 16 * 1024 ** 3;
  return native && enoughCompute && freeBytes >= requiredBytes
    ? {
        modelId: toPublicModelId(medium.id),
        reason: "Recommended for this device: higher accuracy should remain responsive.",
      }
    : {
        modelId: toPublicModelId("whisper-small-multilingual-q5_1"),
        reason: "Recommended for this device: faster startup and lower memory use.",
      };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const runtimeDir = environment.isDevelopment
    ? NodePath.join(environment.rootDir, "native", "whisper-runtime")
    : NodePath.join(environment.resourcesPath, "whisper-runtime");
  const modelDir = NodePath.join(environment.stateDir, "voice", "models");

  let maintenanceActive = false;
  let downloadController: AbortController | null = null;
  let downloadModelId: VoiceModelId | null = null;
  let activeDownload: Promise<unknown> | null = null;
  let activeController: AbortController | null = null;
  let activeTranscription: Promise<unknown> | null = null;
  let selectedModelId = (yield* appSettings.load).voiceSelectedModelId ?? null;
  const persistSelectedModel = (
    modelId: VoiceModelId | null,
  ): Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError> =>
    appSettings.setVoiceSelectedModelId(modelId).pipe(Effect.asVoid);

  const engine: TranscriptionEngine = createLocalWhisperEngine({
    runtimeDir,
    modelDir,
    manifests: VOICE_MODEL_DEFINITIONS,
    platform: environment.platform,
    isMaintenanceActive: () => maintenanceActive,
  });
  const runtimeAvailable = yield* Effect.promise(() => engine.isRuntimeInstalled());

  // Existing installs retain their current Small model without another download.
  if (selectedModelId === null) {
    const smallState = yield* Effect.promise(() =>
      engine.getModelStateForModel("whisper-small-multilingual-q5_1"),
    );
    if (isReady(smallState)) {
      selectedModelId = toPublicModelId("whisper-small-multilingual-q5_1");
      yield* persistSelectedModel(selectedModelId);
    }
  }

  const recommendation = yield* Effect.promise(() =>
    resolveRecommendation(
      modelDir,
      runtimeAvailable,
      environment.platform,
      environment.runtimeInfo.runningUnderArm64Translation,
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      downloadController?.abort();
      activeController?.abort();
      await engine.dispose().catch(() => undefined);
    }),
  );

  const getPublicState = async (): Promise<VoiceModelsSnapshot> => {
    const states = await engine.getModelStates();
    const models: VoiceModelSummary[] = VOICE_MODEL_DEFINITIONS.map((definition) => {
      const id = toPublicModelId(definition.id);
      return {
        id,
        displayName: definition.displayName,
        description: MODEL_DESCRIPTIONS[definition.id] ?? "Local multilingual transcription.",
        byteSize: definition.byteSize,
        state: projectVoiceModelState(states[definition.id] ?? { state: "missing" }),
      };
    });
    return {
      runtimeAvailable,
      ...(runtimeAvailable ? {} : { runtimeMessage: RUNTIME_UNAVAILABLE_MESSAGE }),
      selectedModelId,
      recommendation,
      activeDownloadModelId: downloadModelId,
      models,
    };
  };

  return DesktopVoice.of({
    getModelsState: Effect.promise(getPublicState),

    downloadModel: (request) =>
      Effect.gen(function* () {
        if (!runtimeAvailable) {
          return yield* new VoiceRequestError({
            kind: "backend-unavailable",
            safeMessage: RUNTIME_UNAVAILABLE_MESSAGE,
          });
        }
        if (downloadController !== null) {
          return yield* new VoiceRequestError({
            kind: "provider-error",
            safeMessage: "Another offline voice model is downloading.",
          });
        }
        const controller = new AbortController();
        downloadController = controller;
        downloadModelId = request.modelId;
        return yield* Effect.gen(function* () {
          const definition = getVoiceModelDefinition(request.modelId);
          if (!definition) {
            return yield* new VoiceRequestError({
              kind: "provider-error",
              safeMessage: "This offline voice model is not supported by this build.",
            });
          }
          const currentState = yield* Effect.tryPromise({
            try: () => engine.getModelStateForModel(request.modelId),
            catch: (cause) => toVoiceRequestError(cause, "download"),
          });
          if (currentState.state !== "ready") {
            const freeBytes = yield* Effect.promise(() => resolveFreeBytes(modelDir));
            const requiredBytes = definition.byteSize + 512 * 1024 * 1024;
            if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
              return yield* new VoiceRequestError({
                kind: "insufficient-storage",
                safeMessage: `Not enough free space for ${definition.displayName}. Free at least ${Math.ceil(requiredBytes / 1024 / 1024)} MiB and try again.`,
              });
            }
          }
          const ensurePromise = engine.ensureModelForModel(request.modelId, controller.signal);
          activeDownload = ensurePromise;
          yield* Effect.tryPromise({
            try: () => ensurePromise,
            catch: (cause) => toVoiceRequestError(cause, "download"),
          });
          if (request.selectOnSuccess === true) {
            yield* persistSelectedModel(request.modelId).pipe(
              Effect.mapError((cause) => toVoiceRequestError(cause, "download")),
            );
            selectedModelId = request.modelId;
          }
          return yield* Effect.promise(getPublicState);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (downloadController === controller) downloadController = null;
              activeDownload = null;
              downloadModelId = null;
            }),
          ),
        );
      }),

    cancelModelDownload: (request) =>
      Effect.sync(() => {
        if (downloadModelId === request.modelId) downloadController?.abort();
      }),

    selectModel: (request) =>
      Effect.gen(function* () {
        const state = yield* Effect.tryPromise({
          try: () => engine.getModelStateForModel(request.modelId),
          catch: (cause) => toVoiceRequestError(cause, "download"),
        });
        if (!isReady(state)) {
          return yield* new VoiceRequestError({
            kind: "model-missing",
            safeMessage: "Download this offline voice model before selecting it.",
          });
        }
        yield* persistSelectedModel(request.modelId).pipe(
          Effect.mapError((cause) => toVoiceRequestError(cause, "download")),
        );
        selectedModelId = request.modelId;
        return yield* Effect.promise(getPublicState);
      }),

    removeModel: (request) =>
      Effect.gen(function* () {
        maintenanceActive = true;
        return yield* Effect.gen(function* () {
          if (downloadModelId === request.modelId) downloadController?.abort();
          yield* Effect.promise(() => activeDownload?.catch(() => undefined) ?? Promise.resolve());
          activeController?.abort();
          yield* Effect.promise(
            () => activeTranscription?.catch(() => undefined) ?? Promise.resolve(),
          );

          let replacement = request.replacementModelId ?? null;
          if (replacement === request.modelId) {
            return yield* new VoiceRequestError({
              kind: "model-missing",
              safeMessage: "Choose a different installed voice model as the fallback.",
            });
          }
          if (selectedModelId === request.modelId && replacement === null) {
            const states = yield* Effect.promise(() => engine.getModelStates());
            replacement =
              VOICE_MODEL_DEFINITIONS.map((definition) => toPublicModelId(definition.id)).find(
                (id) => id !== request.modelId && isReady(states[id] ?? { state: "missing" }),
              ) ?? null;
          }
          if (replacement !== null) {
            const replacementState = yield* Effect.promise(() =>
              engine.getModelStateForModel(replacement),
            );
            if (!isReady(replacementState)) {
              return yield* new VoiceRequestError({
                kind: "model-missing",
                safeMessage: "The selected fallback voice model is not installed.",
              });
            }
          }
          if (selectedModelId === request.modelId) {
            yield* persistSelectedModel(replacement).pipe(
              Effect.mapError((cause) => toVoiceRequestError(cause, "remove")),
            );
            selectedModelId = replacement;
          }
          yield* Effect.promise(() => engine.removeModelForModel(request.modelId));
          return yield* Effect.promise(getPublicState);
        }).pipe(
          Effect.mapError((cause) => toVoiceRequestError(cause, "remove")),
          Effect.ensuring(Effect.sync(() => (maintenanceActive = false))),
        );
      }),

    cancelTranscription: Effect.sync(() => {
      activeController?.abort();
    }),

    transcribe: (request) =>
      Effect.gen(function* () {
        const clip = yield* Effect.try({
          try: () => normalizeVoiceClip(request),
          catch: (cause) =>
            new VoiceRequestError({ kind: "invalid-audio", safeMessage: String(cause) }),
        });
        if (selectedModelId === null) {
          return yield* new VoiceRequestError({
            kind: "model-missing",
            safeMessage: "Set up offline voice transcription before using the microphone.",
          });
        }
        activeController?.abort();
        const controller = new AbortController();
        activeController = controller;
        const transcription = engine.transcribeForModel(selectedModelId, clip, {
          signal: controller.signal,
          ...(request.language !== undefined ? { language: request.language } : {}),
        });
        activeTranscription = transcription;
        const modelId = selectedModelId;
        return yield* Effect.tryPromise({
          try: async () => ({ ...(await transcription), modelId }),
          catch: (cause) => toVoiceRequestError(cause),
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeController === controller) activeController = null;
              if (activeTranscription === transcription) activeTranscription = null;
            }),
          ),
        );
      }),
  });
});

export const layer = Layer.effect(DesktopVoice, make);
