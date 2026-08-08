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
  probeStaticCapabilities,
  requireVoiceModelDefinition,
  scoreCapability,
  type TranscriptionEngine,
  VoiceModelManager,
} from "@scientfactory/scient-voice";
import type {
  VoiceCapabilitySnapshot,
  VoiceModelState,
  VoiceTranscribeRequest,
  VoiceTranscript,
} from "@t3tools/contracts";
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

function toVoiceRequestError(cause: unknown): VoiceRequestError {
  if (isVoiceTranscriptionError(cause)) {
    return new VoiceRequestError({ kind: cause.kind, safeMessage: cause.safeMessage });
  }
  return new VoiceRequestError({
    kind: "provider-error",
    safeMessage: "Offline voice transcription failed.",
  });
}

export class DesktopVoice extends Context.Service<
  DesktopVoice,
  {
    readonly getCapability: Effect.Effect<VoiceCapabilitySnapshot>;
    readonly getModelState: Effect.Effect<VoiceModelState>;
    readonly downloadModel: Effect.Effect<VoiceModelState, VoiceRequestError>;
    readonly removeModel: Effect.Effect<VoiceModelState, VoiceRequestError>;
    readonly cancelTranscription: Effect.Effect<void>;
    readonly transcribe: (
      request: VoiceTranscribeRequest,
    ) => Effect.Effect<VoiceTranscript, VoiceRequestError>;
  }
>()("@t3tools/desktop/app/DesktopVoice") {}

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
  let activeController: AbortController | null = null;

  const manager = new VoiceModelManager({ modelsDirectory: modelDir, manifest });
  const engine: TranscriptionEngine = createLocalWhisperEngine({
    runtimeDir,
    modelDir,
    manifest,
    isMaintenanceActive: () => maintenanceActive,
  });

  // Tear the whisper child process down with the app. Swallow disposal errors
  // in the promise itself so the finalizer never dies.
  yield* Effect.addFinalizer(() => Effect.promise(() => engine.dispose().catch(() => undefined)));

  return DesktopVoice.of({
    getCapability: Effect.sync(() => {
      const probe = probeStaticCapabilities();
      return { probe, tier: scoreCapability(probe) };
    }),

    getModelState: Effect.promise(() => manager.getStatus()),

    downloadModel: Effect.gen(function* () {
      if (downloadInFlight) {
        return yield* Effect.promise(() => manager.getStatus());
      }
      downloadInFlight = true;
      return yield* Effect.tryPromise({
        try: async () => {
          await manager.ensureInstalled(new AbortController().signal);
          return manager.getStatus();
        },
        catch: toVoiceRequestError,
      }).pipe(Effect.ensuring(Effect.sync(() => (downloadInFlight = false))));
    }),

    removeModel: Effect.gen(function* () {
      maintenanceActive = true;
      return yield* Effect.tryPromise({
        try: async () => {
          await manager.remove();
          return manager.getStatus();
        },
        catch: toVoiceRequestError,
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

        return yield* Effect.tryPromise({
          try: () =>
            engine.transcribe(clip, {
              signal: controller.signal,
              ...(request.language !== undefined ? { language: request.language } : {}),
            }),
          catch: toVoiceRequestError,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeController === controller) {
                activeController = null;
              }
            }),
          ),
        );
      }),
  });
});

export const layer = Layer.effect(DesktopVoice, make);
