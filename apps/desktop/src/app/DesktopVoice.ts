// @effect-diagnostics nodeBuiltinImport:off
//
// Desktop main-process owner of the local (offline) voice transcription
// runtime. All behavior lives in the host-independent
// `@scientfactory/scient-voice` core; this service only resolves host paths,
// owns the whisper.cpp child-process lifecycle, and exposes an Effect surface
// the IPC layer registers. It is a deliberate, isolated Scient divergence on
// top of the T3 host — no T3 file learns anything about voice beyond a single
// mount/registration point.

import * as NodePath from "node:path";

import {
  createLocalWhisperEngine,
  DEFAULT_VOICE_MODEL_ID,
  isVoiceTranscriptionError,
  normalizeVoiceClip,
  requireVoiceModelDefinition,
  type TranscriptionEngine,
  type VoiceModelState as CoreVoiceModelState,
} from "@scientfactory/scient-voice";
import type { VoiceModelState, VoiceTranscribeRequest, VoiceTranscript } from "@t3tools/contracts";
import { VoiceTranscriptionErrorKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * A transcription/model-operation failure projected to a safe, user-facing
 * message. It crosses the IPC boundary as the rejection of the renderer's
 * promise, so `message` is deliberately the already-sanitized copy.
 */
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

function toVoiceRequestError(cause: unknown): VoiceRequestError {
  if (isVoiceRequestError(cause)) return cause;
  if (isVoiceTranscriptionError(cause)) {
    return new VoiceRequestError({ kind: cause.kind, safeMessage: cause.safeMessage });
  }
  return new VoiceRequestError({
    kind: "provider-error",
    safeMessage: "Offline voice transcription failed.",
  });
}

export function toVoiceModelRequestError(
  cause: unknown,
  operation: "download" | "remove",
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

export class DesktopVoice extends Context.Service<
  DesktopVoice,
  {
    readonly getModelState: Effect.Effect<VoiceModelState>;
    readonly downloadModel: Effect.Effect<VoiceModelState, VoiceRequestError>;
    readonly cancelModelDownload: Effect.Effect<void>;
    readonly removeModel: Effect.Effect<VoiceModelState, VoiceRequestError>;
    readonly cancelTranscription: Effect.Effect<void>;
    readonly transcribe: (
      request: VoiceTranscribeRequest,
    ) => Effect.Effect<VoiceTranscript, VoiceRequestError>;
  }
>()("@t3tools/desktop/app/DesktopVoice") {}

const RUNTIME_UNAVAILABLE_MESSAGE =
  "Offline voice transcription is not available in this desktop build.";

export function projectVoiceModelState(state: CoreVoiceModelState): VoiceModelState {
  switch (state.state) {
    case "missing":
      return { state: "missing" };
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

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const manifest = requireVoiceModelDefinition(DEFAULT_VOICE_MODEL_ID);

  // Dev resolves the runtime from the repo (staged by the build script in
  // production); packaged resolves it from the app's resources, outside the
  // asar. Mirrors the resource-monitor sidecar pattern.
  const runtimeDir = environment.isDevelopment
    ? NodePath.join(environment.rootDir, "native", "whisper-runtime")
    : NodePath.join(environment.resourcesPath, "whisper-runtime");
  // The model is candidate-isolated device state; never seeded from T3.
  const modelDir = NodePath.join(environment.stateDir, "voice", "models");

  let maintenanceActive = false;
  let downloadInFlight = false;
  let downloadController: AbortController | null = null;
  let activeController: AbortController | null = null;
  let activeTranscription: Promise<unknown> | null = null;

  // The engine is the single owner of both the model manager and native
  // runtime. Keeping one owner prevents removal/repair from racing a helper
  // process that has the same model file open.
  const engine: TranscriptionEngine = createLocalWhisperEngine({
    runtimeDir,
    modelDir,
    manifest,
    isMaintenanceActive: () => maintenanceActive,
  });

  // Tear the whisper child process down with the app. Swallow disposal errors
  // in the promise itself so the finalizer never dies.
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      downloadController?.abort();
      activeController?.abort();
      await engine.dispose().catch(() => undefined);
    }),
  );

  const getPublicModelState = async (): Promise<VoiceModelState> => {
    if (!(await engine.isRuntimeInstalled())) {
      return { state: "unavailable", message: RUNTIME_UNAVAILABLE_MESSAGE };
    }
    return projectVoiceModelState(await engine.getModelState());
  };

  return DesktopVoice.of({
    getModelState: Effect.promise(getPublicModelState),

    downloadModel: Effect.gen(function* () {
      if (downloadInFlight) {
        return yield* Effect.promise(getPublicModelState);
      }
      const controller = new AbortController();
      downloadInFlight = true;
      downloadController = controller;
      return yield* Effect.tryPromise({
        try: async () => {
          if (!(await engine.isRuntimeInstalled())) {
            throw new VoiceRequestError({
              kind: "backend-unavailable",
              safeMessage: RUNTIME_UNAVAILABLE_MESSAGE,
            });
          }
          await engine.ensureModel(undefined, controller.signal);
          return getPublicModelState();
        },
        catch: (cause) => toVoiceModelRequestError(cause, "download"),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            downloadInFlight = false;
            if (downloadController === controller) downloadController = null;
          }),
        ),
      );
    }),

    cancelModelDownload: Effect.sync(() => {
      downloadController?.abort();
    }),

    removeModel: Effect.gen(function* () {
      maintenanceActive = true;
      return yield* Effect.tryPromise({
        try: async () => {
          activeController?.abort();
          await activeTranscription?.catch(() => undefined);
          await engine.removeModel();
          return getPublicModelState();
        },
        catch: (cause) => toVoiceModelRequestError(cause, "remove"),
      }).pipe(Effect.ensuring(Effect.sync(() => (maintenanceActive = false))));
    }),

    cancelTranscription: Effect.sync(() => {
      activeController?.abort();
    }),

    transcribe: (request: VoiceTranscribeRequest) =>
      Effect.gen(function* () {
        // normalizeVoiceClip owns base64 decode + strict WAV validation; hand it
        // the raw request shape ({ audioBase64, mimeType, sampleRateHz, durationMs }).
        const clip = yield* Effect.try({
          try: () => normalizeVoiceClip(request),
          catch: toVoiceRequestError,
        });

        // Only one clip in flight; a new request supersedes the previous.
        activeController?.abort();
        const controller = new AbortController();
        activeController = controller;

        const transcription = engine.transcribe(clip, {
          signal: controller.signal,
          ...(request.language !== undefined ? { language: request.language } : {}),
        });
        activeTranscription = transcription;

        return yield* Effect.tryPromise({
          try: () => transcription,
          catch: toVoiceRequestError,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeController === controller) {
                activeController = null;
              }
              if (activeTranscription === transcription) {
                activeTranscription = null;
              }
            }),
          ),
        );
      }),
  });
});

export const layer = Layer.effect(DesktopVoice, make);
