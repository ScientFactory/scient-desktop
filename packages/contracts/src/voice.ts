// Engine-neutral wire contract for local voice transcription.
//
// This is the serializable boundary between the renderer/host IPC layer and the
// host-independent transcription core (`@scientfactory/scient-voice`). It is
// LOCAL-ONLY today — only the `local` engine ships — but every shape is kept
// engine-neutral (results carry `engine`) so another implementation can be
// added later without coupling the composer to Electron or whisper.cpp.

import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The decoded request is limited to 10 MiB by the voice core. */
export const VOICE_AUDIO_BASE64_MAX_CHARS = 4 * Math.ceil((10 * 1024 * 1024) / 3);

/** Transcription engine identifier. Engine-neutral; only `local` ships now. */
export const VoiceEngineId = Schema.Literals(["local"]);
export type VoiceEngineId = typeof VoiceEngineId.Type;

/**
 * Provider-neutral failure taxonomy. Kept complete (including remote-shaped
 * kinds) so any current or future engine maps cleanly into a single wire type.
 */
export const VoiceTranscriptionErrorKind = Schema.Literals([
  "cancelled",
  "invalid-audio",
  "authentication",
  "entitlement",
  "rate-limit",
  "network",
  "timeout",
  "provider-error",
  "malformed-response",
  "backend-unavailable",
  "model-missing",
  "insufficient-storage",
]);
export type VoiceTranscriptionErrorKind = typeof VoiceTranscriptionErrorKind.Type;

/** The only accepted recorded-audio container. */
export const VoiceAudioMimeType = Schema.Literal("audio/wav");
export type VoiceAudioMimeType = typeof VoiceAudioMimeType.Type;

/** Built-in local model identifiers. The desktop catalog is authoritative. */
export const VoiceModelId = Schema.Literals([
  "whisper-small-multilingual-q5_1",
  "whisper-medium-multilingual-q5_0",
]);
export type VoiceModelId = typeof VoiceModelId.Type;

/**
 * Untrusted transcribe request as it crosses the IPC boundary. Audio is
 * base64-encoded so it survives JSON transport; the core decodes and strictly
 * validates it (24 kHz mono 16-bit PCM WAV) before inference.
 */
export const VoiceTranscribeRequest = Schema.Struct({
  // Bound the string at the main-process IPC decoder before the core allocates
  // a decode buffer. The core independently validates the exact decoded size.
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_AUDIO_BASE64_MAX_CHARS)),
  mimeType: VoiceAudioMimeType,
  sampleRateHz: NonNegativeInt,
  durationMs: NonNegativeInt,
  language: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceTranscribeRequest = typeof VoiceTranscribeRequest.Type;

/** A finished transcript. Carries `engine` so the origin is never ambiguous. */
export const VoiceTranscript = Schema.Struct({
  text: Schema.String,
  engine: VoiceEngineId,
  language: Schema.optionalKey(TrimmedNonEmptyString),
  modelId: Schema.optionalKey(VoiceModelId),
});
export type VoiceTranscript = typeof VoiceTranscript.Type;

/** Progress of a resumable model download. */
export const VoiceModelDownloadProgress = Schema.Struct({
  modelId: VoiceModelId,
  downloadedBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type VoiceModelDownloadProgress = typeof VoiceModelDownloadProgress.Type;

/** Lifecycle state of a locally installed model. */
export const VoiceModelState = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("missing"),
    partialBytes: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({
    state: Schema.Literal("downloading"),
    downloadedBytes: NonNegativeInt,
    totalBytes: NonNegativeInt,
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    byteSize: NonNegativeInt,
  }),
  Schema.Struct({ state: Schema.Literal("unavailable"), message: TrimmedNonEmptyString }),
  Schema.Struct({ state: Schema.Literal("error"), message: TrimmedNonEmptyString }),
]);
export type VoiceModelState = typeof VoiceModelState.Type;

/** Safe metadata and lifecycle state for one installed/catalog model. */
export const VoiceModelSummary = Schema.Struct({
  id: VoiceModelId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  byteSize: NonNegativeInt,
  state: VoiceModelState,
});
export type VoiceModelSummary = typeof VoiceModelSummary.Type;

export const VoiceModelRecommendation = Schema.Struct({
  modelId: VoiceModelId,
  reason: TrimmedNonEmptyString,
});
export type VoiceModelRecommendation = typeof VoiceModelRecommendation.Type;

/** Complete authoritative snapshot consumed by setup and Settings → Voice. */
export const VoiceModelsSnapshot = Schema.Struct({
  runtimeAvailable: Schema.Boolean,
  runtimeMessage: Schema.optionalKey(TrimmedNonEmptyString),
  selectedModelId: Schema.NullOr(VoiceModelId),
  recommendation: Schema.NullOr(VoiceModelRecommendation),
  activeDownloadModelId: Schema.NullOr(VoiceModelId),
  models: Schema.Array(VoiceModelSummary),
});
export type VoiceModelsSnapshot = typeof VoiceModelsSnapshot.Type;

export const VoiceModelOperationRequest = Schema.Struct({ modelId: VoiceModelId });
export type VoiceModelOperationRequest = typeof VoiceModelOperationRequest.Type;

export const VoiceModelDownloadRequest = Schema.Struct({
  modelId: VoiceModelId,
  selectOnSuccess: Schema.optionalKey(Schema.Boolean),
});
export type VoiceModelDownloadRequest = typeof VoiceModelDownloadRequest.Type;

export const VoiceModelRemoveRequest = Schema.Struct({
  modelId: VoiceModelId,
  replacementModelId: Schema.optionalKey(Schema.NullOr(VoiceModelId)),
});
export type VoiceModelRemoveRequest = typeof VoiceModelRemoveRequest.Type;
