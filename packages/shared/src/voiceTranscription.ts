// FILE: voiceTranscription.ts
// Purpose: Defines the provider-neutral voice backend boundary and typed failure taxonomy.
// Layer: Shared runtime contract
// Exports: VoiceTranscriptionBackend, normalized clip/result types, and typed backend errors.

export type VoiceTranscriptionBackendId = "chatgpt" | "local";

export type VoiceTranscriptionBackendAvailability =
  | { readonly state: "ready" }
  | { readonly state: "requires-setup"; readonly reason: string }
  | {
      readonly state: "temporarily-unavailable";
      readonly reason?: string;
      readonly retryAt?: number;
    }
  | { readonly state: "unavailable"; readonly reason?: string };

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
  | "backend-unavailable";

export interface NormalizedVoiceClip {
  readonly audioBytes: Uint8Array;
  readonly mimeType: "audio/wav";
  readonly sampleRateHz: number;
  readonly durationMs: number;
  readonly cwd: string;
  readonly threadId?: string;
}

export interface VoiceTranscript {
  readonly text: string;
}

export interface VoiceTranscriptionBackend {
  readonly id: VoiceTranscriptionBackendId;

  /**
   * Reports whether this backend can currently be attempted without doing a
   * consuming transcription probe. For remote backends this proves only
   * authentication eligibility; observed endpoint health remains router-owned.
   */
  getAvailability(): Promise<VoiceTranscriptionBackendAvailability>;

  transcribe(
    clip: NormalizedVoiceClip,
    options: { readonly signal: AbortSignal },
  ): Promise<VoiceTranscript>;
}

export interface VoiceTranscriptionBackendErrorOptions {
  readonly kind: VoiceTranscriptionErrorKind;
  readonly fallbackAllowed: boolean;
  readonly safeMessage: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class VoiceTranscriptionBackendError extends Error {
  readonly kind: VoiceTranscriptionErrorKind;
  readonly fallbackAllowed: boolean;
  readonly safeMessage: string;
  readonly retryAfterMs?: number;

  constructor(options: VoiceTranscriptionBackendErrorOptions) {
    super(
      options.safeMessage,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "VoiceTranscriptionBackendError";
    this.kind = options.kind;
    this.fallbackAllowed = options.fallbackAllowed;
    this.safeMessage = options.safeMessage;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export function isVoiceTranscriptionBackendError(
  value: unknown,
): value is VoiceTranscriptionBackendError {
  return value instanceof VoiceTranscriptionBackendError;
}

export function voiceTranscriptionFailureAllowsFallback(
  value: unknown,
): boolean {
  return isVoiceTranscriptionBackendError(value) && value.fallbackAllowed;
}
