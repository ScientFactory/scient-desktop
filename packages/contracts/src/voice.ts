// Engine-neutral wire contract for local voice transcription.
//
// This is the serializable boundary between the renderer/host IPC layer and the
// host-independent transcription core (`@scientfactory/scient-voice`). It is
// LOCAL-ONLY today — only the `local` engine ships — but every shape is kept
// engine-neutral (results carry `engine`, the failure taxonomy is complete) so a
// remote engine could be added later without a wire break.
//
// Schema-only: no runtime logic lives here. The `@scientfactory/scient-voice`
// package keeps a structurally identical plain-TypeScript mirror of the
// `VoiceEngineId`, `VoiceTranscriptionErrorKind`, capability, and benchmark
// shapes; the two MUST be kept in sync.

import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
]);
export type VoiceTranscriptionErrorKind = typeof VoiceTranscriptionErrorKind.Type;

/** The only accepted recorded-audio container. */
export const VoiceAudioMimeType = Schema.Literal("audio/wav");
export type VoiceAudioMimeType = typeof VoiceAudioMimeType.Type;

/**
 * Untrusted transcribe request as it crosses the IPC boundary. Audio is
 * base64-encoded so it survives JSON transport; the core decodes and strictly
 * validates it (24 kHz mono 16-bit PCM WAV) before inference.
 */
export const VoiceTranscribeRequest = Schema.Struct({
  audioBase64: TrimmedNonEmptyString,
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
});
export type VoiceTranscript = typeof VoiceTranscript.Type;

/** Progress of a resumable model download. */
export const VoiceModelDownloadProgress = Schema.Struct({
  downloadedBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type VoiceModelDownloadProgress = typeof VoiceModelDownloadProgress.Type;

/** Lifecycle state of a locally installed model. */
export const VoiceModelState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    state: Schema.Literal("downloading"),
    downloadedBytes: NonNegativeInt,
    totalBytes: NonNegativeInt,
    // Present only when a verified copy is still usable while a repair downloads.
    readyModelPath: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    modelPath: TrimmedNonEmptyString,
    byteSize: NonNegativeInt,
  }),
  Schema.Struct({ state: Schema.Literal("error"), message: TrimmedNonEmptyString }),
]);
export type VoiceModelState = typeof VoiceModelState.Type;

/** Public description of a pinned model (no download URL over the wire). */
export const VoiceModelDescriptor = Schema.Struct({
  id: TrimmedNonEmptyString,
  fileName: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  byteSize: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  sourceRevision: TrimmedNonEmptyString,
  license: TrimmedNonEmptyString,
});
export type VoiceModelDescriptor = typeof VoiceModelDescriptor.Type;

/** Coarse capability tier hint used to steer model/thread choices. */
export const VoiceCapabilityTier = Schema.Literals(["fast", "ok", "slow"]);
export type VoiceCapabilityTier = typeof VoiceCapabilityTier.Type;

/** Static machine capabilities gathered without running inference. */
export const VoiceCapabilityProbe = Schema.Struct({
  arch: TrimmedNonEmptyString,
  cpuCount: NonNegativeInt,
  totalMemBytes: NonNegativeInt,
  hasAvx2: Schema.Boolean,
});
export type VoiceCapabilityProbe = typeof VoiceCapabilityProbe.Type;

/** Static machine probe paired with its coarse tier score. */
export const VoiceCapabilitySnapshot = Schema.Struct({
  probe: VoiceCapabilityProbe,
  tier: VoiceCapabilityTier,
});
export type VoiceCapabilitySnapshot = typeof VoiceCapabilitySnapshot.Type;

/**
 * Result of a runtime micro-benchmark. `rtf` is the whisper.cpp "real time
 * factor": processing time divided by audio duration — lower is faster, and a
 * value below 1 means the machine transcribes faster than real time. The
 * benchmark itself is run in the host layer; only its shape lives on the wire.
 */
export const VoiceBenchmarkResult = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  rtf: Schema.Number,
  loadMs: Schema.Number,
  sampleDurationMs: Schema.Number,
});
export type VoiceBenchmarkResult = typeof VoiceBenchmarkResult.Type;

/** Serializable projection of a transcription failure. */
export const VoiceTranscriptionErrorPayload = Schema.Struct({
  kind: VoiceTranscriptionErrorKind,
  safeMessage: TrimmedNonEmptyString,
  fallbackAllowed: Schema.Boolean,
  retryAfterMs: Schema.optionalKey(NonNegativeInt),
});
export type VoiceTranscriptionErrorPayload = typeof VoiceTranscriptionErrorPayload.Type;
