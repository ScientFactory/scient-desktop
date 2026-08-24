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
  MEDIUM_VOICE_MODEL_ID,
  normalizeVoiceClip,
  SMALL_VOICE_MODEL_ID,
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

class VoiceHostProbeError extends Schema.TaggedErrorClass<VoiceHostProbeError>()(
  "VoiceHostProbeError",
  { operation: Schema.Literals(["runtime", "model", "storage"]) },
) {}

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

export interface DesktopVoiceService {
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

export class DesktopVoice extends Context.Service<DesktopVoice, DesktopVoiceService>()(
  "@t3tools/desktop/app/DesktopVoice",
) {}

const RUNTIME_UNAVAILABLE_MESSAGE =
  "Offline voice transcription is not available in this desktop build.";

function isReady(state: CoreVoiceModelState): boolean {
  return state.state === "ready";
}

function findOnlyReadyModelId(
  states: Readonly<Record<string, CoreVoiceModelState>>,
): VoiceModelId | null {
  const readyModelIds = VOICE_MODEL_DEFINITIONS.map((definition) => definition.id).filter((id) =>
    isReady(states[id] ?? { state: "missing" }),
  );
  return readyModelIds.length === 1 ? toPublicModelId(readyModelIds[0]!) : null;
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

export async function resolveVoiceModelFreeBytes(path: string): Promise<number> {
  let candidate = path;
  for (;;) {
    try {
      const stats = await NodeFSP.statfs(candidate);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // A clean install may not have created any of the voice directories yet.
      // Walk to the nearest existing ancestor on the same filesystem.
    }
    const parent = NodePath.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return Number.POSITIVE_INFINITY;
}

export interface VoiceDeviceProfile {
  readonly platform: NodeJS.Platform;
  readonly runningUnderArm64Translation: boolean;
  readonly availableParallelism: number;
  readonly totalMemoryBytes: number;
  readonly freeModelStorageBytes: number;
}

export function recommendVoiceModel(
  runtimeAvailable: boolean,
  device: VoiceDeviceProfile,
): VoiceModelRecommendation | null {
  if (!runtimeAvailable) return null;
  const medium = getVoiceModelDefinition(MEDIUM_VOICE_MODEL_ID);
  if (!medium) return null;
  const requiredBytes = medium.byteSize + 512 * 1024 * 1024;
  const native = device.platform !== "darwin" || !device.runningUnderArm64Translation;
  const enoughCompute =
    device.availableParallelism >= 8 && device.totalMemoryBytes >= 16 * 1024 ** 3;
  return native && enoughCompute && device.freeModelStorageBytes >= requiredBytes
    ? {
        modelId: toPublicModelId(medium.id),
        reason: "Recommended for this device: higher accuracy should remain responsive.",
      }
    : {
        modelId: toPublicModelId(SMALL_VOICE_MODEL_ID),
        reason: "Recommended for this device: faster startup and lower memory use.",
      };
}

export interface DesktopVoiceDependencies {
  readonly createEngine: typeof createLocalWhisperEngine;
  readonly resolveFreeBytes: (path: string) => Promise<number>;
  readonly readDeviceCapacity: () => {
    readonly availableParallelism: number;
    readonly totalMemoryBytes: number;
  };
}

const defaultDependencies: DesktopVoiceDependencies = {
  createEngine: createLocalWhisperEngine,
  resolveFreeBytes: resolveVoiceModelFreeBytes,
  readDeviceCapacity: () => ({
    availableParallelism: NodeOS.availableParallelism(),
    totalMemoryBytes: NodeOS.totalmem(),
  }),
};

export const makeWithDependencies = (dependencies: DesktopVoiceDependencies) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const runtimeDir = environment.isDevelopment
      ? NodePath.join(environment.rootDir, "native", "whisper-runtime")
      : NodePath.join(environment.resourcesPath, "whisper-runtime");
    const modelDir = NodePath.join(environment.stateDir, "voice", "models");

    let activeModelMutation: "select" | "remove" | null = null;
    let downloadController: AbortController | null = null;
    let downloadModelId: VoiceModelId | null = null;
    let activeController: AbortController | null = null;
    let activeTranscription: Promise<unknown> | null = null;
    let selectedModelId = (yield* appSettings.load).voiceSelectedModelId ?? null;
    const persistSelectedModel = (
      modelId: VoiceModelId | null,
    ): Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError> =>
      appSettings.setVoiceSelectedModelId(modelId).pipe(Effect.asVoid);

    const engine: TranscriptionEngine = dependencies.createEngine({
      runtimeDir,
      modelDir,
      manifests: VOICE_MODEL_DEFINITIONS,
      platform: environment.platform,
      isMaintenanceActive: () => activeModelMutation === "remove",
    });
    const runtimeAvailable = yield* Effect.tryPromise({
      try: () => engine.isRuntimeInstalled(),
      catch: () => new VoiceHostProbeError({ operation: "runtime" }),
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not inspect the offline voice runtime.").pipe(Effect.as(false)),
      ),
    );

    // Keep persisted selection aligned with verified files. A sole existing
    // model is the unambiguous fallback, including installations created before
    // model selection was persisted. A transient probe failure must not erase a
    // previously valid preference.
    const existingStates: Readonly<Record<string, CoreVoiceModelState>> | null =
      yield* Effect.tryPromise({
        try: () => engine.getModelStates(),
        catch: () => new VoiceHostProbeError({ operation: "model" }),
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not inspect the existing offline voice models.").pipe(
            Effect.as<Readonly<Record<string, CoreVoiceModelState>> | null>(null),
          ),
        ),
      );
    if (existingStates !== null) {
      const selectedState =
        selectedModelId === null
          ? ({ state: "missing" } as const)
          : (existingStates[selectedModelId] ?? ({ state: "missing" } as const));
      const reconciledModelId = isReady(selectedState)
        ? selectedModelId
        : findOnlyReadyModelId(existingStates);
      if (reconciledModelId !== selectedModelId) {
        selectedModelId = reconciledModelId;
        yield* persistSelectedModel(selectedModelId).pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not persist the reconciled offline voice selection."),
          ),
        );
      }
    }

    const deviceCapacity = dependencies.readDeviceCapacity();
    const freeModelStorageBytes = yield* Effect.tryPromise({
      try: () => dependencies.resolveFreeBytes(modelDir),
      catch: () => new VoiceHostProbeError({ operation: "storage" }),
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not inspect free space for offline voice models.").pipe(
          Effect.as(0),
        ),
      ),
    );
    const recommendation = recommendVoiceModel(runtimeAvailable, {
      ...deviceCapacity,
      platform: environment.platform,
      runningUnderArm64Translation: environment.runtimeInfo.runningUnderArm64Translation,
      freeModelStorageBytes,
    });

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
          description: definition.description,
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
          if (activeModelMutation === "remove") {
            return yield* new VoiceRequestError({
              kind: "provider-error",
              safeMessage: "Wait for the current offline voice model operation to finish.",
            });
          }
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
          const clearDownloadState = Effect.sync(() => {
            if (downloadController === controller) {
              downloadController = null;
              downloadModelId = null;
            }
          });
          return yield* Effect.gen(function* () {
            const definition = getVoiceModelDefinition(request.modelId);
            if (!definition) {
              return yield* new VoiceRequestError({
                kind: "provider-error",
                safeMessage: "This offline voice model is not supported by this build.",
              });
            }
            const currentState = yield* Effect.tryPromise({
              try: () => engine.getModelState(request.modelId),
              catch: (cause) => toVoiceRequestError(cause, "download"),
            });
            if (currentState.state !== "ready") {
              const freeBytes = yield* Effect.tryPromise({
                try: () => dependencies.resolveFreeBytes(modelDir),
                catch: (cause) => toVoiceRequestError(cause, "download"),
              });
              const partialBytes =
                currentState.state === "missing"
                  ? Math.min(currentState.partialBytes ?? 0, definition.byteSize)
                  : 0;
              const requiredBytes = definition.byteSize - partialBytes + 512 * 1024 * 1024;
              if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
                return yield* new VoiceRequestError({
                  kind: "insufficient-storage",
                  safeMessage: `Not enough free space for ${definition.displayName}. Free at least ${Math.ceil(requiredBytes / 1024 / 1024)} MiB and try again.`,
                });
              }
            }
            const ensurePromise = engine.ensureModel(request.modelId, controller.signal);
            yield* Effect.tryPromise({
              try: () => ensurePromise,
              catch: (cause) => toVoiceRequestError(cause, "download"),
            });
            const installedStates = yield* Effect.promise(() => engine.getModelStates());
            const isOnlyInstalledModel = findOnlyReadyModelId(installedStates) === request.modelId;
            if (
              request.selectOnSuccess === true ||
              (selectedModelId === null && isOnlyInstalledModel)
            ) {
              yield* persistSelectedModel(request.modelId).pipe(
                Effect.mapError((cause) => toVoiceRequestError(cause, "download")),
              );
              selectedModelId = request.modelId;
            }
            yield* clearDownloadState;
            return yield* Effect.promise(getPublicState);
          }).pipe(Effect.ensuring(clearDownloadState));
        }),

      cancelModelDownload: (request) =>
        Effect.sync(() => {
          if (downloadModelId === request.modelId) downloadController?.abort();
        }),

      selectModel: (request) =>
        Effect.gen(function* () {
          if (activeModelMutation !== null) {
            return yield* new VoiceRequestError({
              kind: "provider-error",
              safeMessage: "Wait for the current offline voice model operation to finish.",
            });
          }
          activeModelMutation = "select";
          return yield* Effect.gen(function* () {
            const state = yield* Effect.tryPromise({
              try: () => engine.getModelState(request.modelId),
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
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (activeModelMutation === "select") activeModelMutation = null;
              }),
            ),
          );
        }),

      removeModel: (request) =>
        Effect.gen(function* () {
          if (activeModelMutation !== null || downloadController !== null) {
            return yield* new VoiceRequestError({
              kind: "provider-error",
              safeMessage: "Wait for the current offline voice model operation to finish.",
            });
          }
          activeModelMutation = "remove";
          return yield* Effect.gen(function* () {
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
                engine.getModelState(replacement),
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
            yield* Effect.promise(() => engine.removeModel(request.modelId));
            return yield* Effect.promise(getPublicState);
          }).pipe(
            Effect.mapError((cause) => toVoiceRequestError(cause, "remove")),
            Effect.ensuring(
              Effect.sync(() => {
                if (activeModelMutation === "remove") activeModelMutation = null;
              }),
            ),
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
          const transcription = engine.transcribe(selectedModelId, clip, {
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

export const make = makeWithDependencies(defaultDependencies);

export const layer = Layer.effect(DesktopVoice, make);
