// Core domain types and the typed failure taxonomy for the local voice core.
//
// This module is the lowest layer of `@scientfactory/scient-voice`: it imports
// nothing else in the package, so every other module can depend on it without
// creating an import cycle.
//
// The `VoiceEngineId` and `VoiceTranscriptionErrorKind` unions are a plain-TS
// mirror of the `effect/Schema` wire contract in
// `packages/contracts/src/voice.ts` and MUST be kept in sync with it.

/** Transcription engine identifier. Engine-neutral; only `local` ships now. */
export type VoiceEngineId = "local";

/**
 * Provider-neutral failure taxonomy. Kept complete (including remote-shaped
 * kinds) so any current or future engine maps cleanly into one type.
 */
export type VoiceTranscriptionErrorKind =
  | "cancelled"
  | "invalid-audio"
  | "authentication"
  | "entitlement"
  | "rate-limit"
  | "network"
  | "timeout"
  | "provider-error"
  | "malformed-response"
  | "backend-unavailable"
  | "model-missing";

/**
 * A decoded, strictly validated clip ready for inference. Host concerns (cwd,
 * thread id, routing mode) are deliberately absent — this core is
 * host-independent.
 */
export interface NormalizedVoiceClip {
  readonly audioBytes: Uint8Array;
  readonly mimeType: "audio/wav";
  readonly sampleRateHz: number;
  readonly durationMs: number;
}

/** A finished transcript. Carries `engine` so its origin is never ambiguous. */
export interface VoiceTranscript {
  readonly text: string;
  readonly engine: VoiceEngineId;
  readonly language?: string;
}

export interface VoiceTranscriptionErrorOptions {
  readonly kind: VoiceTranscriptionErrorKind;
  readonly fallbackAllowed: boolean;
  readonly safeMessage: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * The single error type raised across the voice core. `safeMessage` is always
 * safe to surface to a user; `kind` classifies the failure for callers, and
 * `fallbackAllowed` tells a router whether another engine may be attempted.
 */
export class VoiceTranscriptionError extends Error {
  readonly kind: VoiceTranscriptionErrorKind;
  readonly fallbackAllowed: boolean;
  readonly safeMessage: string;
  readonly retryAfterMs?: number;

  constructor(options: VoiceTranscriptionErrorOptions) {
    super(options.safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VoiceTranscriptionError";
    this.kind = options.kind;
    this.fallbackAllowed = options.fallbackAllowed;
    this.safeMessage = options.safeMessage;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export function isVoiceTranscriptionError(value: unknown): value is VoiceTranscriptionError {
  return value instanceof VoiceTranscriptionError;
}

export function voiceTranscriptionFailureAllowsFallback(value: unknown): boolean {
  return isVoiceTranscriptionError(value) && value.fallbackAllowed;
}
