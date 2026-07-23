// FILE: voiceTranscriptionRouter.ts
// Purpose: Routes voice transcription through ChatGPT first with reliable local fallback.
// Layer: Shared runtime policy

import {
  isVoiceTranscriptionBackendError,
  type NormalizedVoiceClip,
  type VoiceTranscriptionBackend,
  VoiceTranscriptionBackendError,
  type VoiceTranscriptionErrorKind,
} from "./voiceTranscription";

export type VoiceTranscriptionMode = "automatic" | "offline-only";

export interface RoutedVoiceTranscript {
  readonly text: string;
  readonly engine: "chatgpt" | "local";
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: VoiceTranscriptionErrorKind | "ineligible" | "circuit-open";
}

export interface VoiceTranscriptionCircuitState {
  readonly consecutiveFailures: number;
  readonly blockedUntil: number | null;
  readonly lastFailureKind: VoiceTranscriptionErrorKind | null;
}

export interface VoiceTranscriptionRouterOptions {
  readonly remote: VoiceTranscriptionBackend;
  readonly local: VoiceTranscriptionBackend;
  readonly now?: () => number;
  readonly transientFailureThreshold?: number;
  readonly transientCooldownMs?: number;
  readonly authenticationCooldownMs?: number;
  readonly rateLimitCooldownMs?: number;
}

export class VoiceTranscriptionRoutingError extends Error {
  constructor(
    readonly remoteError: unknown,
    readonly localError: unknown,
  ) {
    super("Neither ChatGPT nor offline voice transcription is available.", {
      cause: localError,
    });
    this.name = "VoiceTranscriptionRoutingError";
  }
}

export class VoiceTranscriptionRouter {
  private readonly now: () => number;
  private readonly transientFailureThreshold: number;
  private readonly transientCooldownMs: number;
  private readonly authenticationCooldownMs: number;
  private readonly rateLimitCooldownMs: number;
  private circuit: VoiceTranscriptionCircuitState = {
    consecutiveFailures: 0,
    blockedUntil: null,
    lastFailureKind: null,
  };

  constructor(private readonly options: VoiceTranscriptionRouterOptions) {
    if (options.remote.id !== "chatgpt") {
      throw new Error("The preferred voice transcription backend must be ChatGPT.");
    }
    if (options.local.id !== "local") {
      throw new Error("The fallback voice transcription backend must be local.");
    }
    this.now = options.now ?? Date.now;
    this.transientFailureThreshold = options.transientFailureThreshold ?? 2;
    this.transientCooldownMs = options.transientCooldownMs ?? 60_000;
    this.authenticationCooldownMs = options.authenticationCooldownMs ?? 5 * 60_000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 5 * 60_000;
  }

  getCircuitState(): VoiceTranscriptionCircuitState {
    return { ...this.circuit };
  }

  resetRemoteHealth(): void {
    this.circuit = {
      consecutiveFailures: 0,
      blockedUntil: null,
      lastFailureKind: null,
    };
  }

  async transcribe(
    clip: NormalizedVoiceClip,
    options: {
      readonly signal: AbortSignal;
      readonly mode?: VoiceTranscriptionMode;
    },
  ): Promise<RoutedVoiceTranscript> {
    options.signal.throwIfAborted();
    if (options.mode === "offline-only") {
      return this.transcribeLocally(clip, options.signal, false);
    }

    let remoteError: unknown = null;
    let fallbackReason: RoutedVoiceTranscript["fallbackReason"];
    if (!this.canAttemptRemote()) {
      fallbackReason = "circuit-open";
    } else {
      let availability: Awaited<ReturnType<VoiceTranscriptionBackend["getAvailability"]>>;
      try {
        availability = await this.options.remote.getAvailability();
        options.signal.throwIfAborted();
      } catch (error) {
        if (options.signal.aborted || isNonFallbackFailure(error)) throw error;
        remoteError = error;
        fallbackReason = failureKind(error);
        this.recordRemoteFailure(error);
        availability = { state: "temporarily-unavailable" };
      }
      if (!remoteError && availability.state === "ready") {
        try {
          const transcript = await this.options.remote.transcribe(clip, {
            signal: options.signal,
          });
          this.resetRemoteHealth();
          return {
            text: transcript.text,
            engine: "chatgpt",
            fallbackUsed: false,
          };
        } catch (error) {
          if (options.signal.aborted || isNonFallbackFailure(error)) {
            throw error;
          }
          remoteError = error;
          fallbackReason = failureKind(error);
          this.recordRemoteFailure(error);
        }
      } else if (!remoteError) {
        fallbackReason = "ineligible";
      }
    }

    try {
      const local = await this.transcribeLocally(clip, options.signal, true);
      return { ...local, ...(fallbackReason ? { fallbackReason } : {}) };
    } catch (localError) {
      if (options.signal.aborted) throw localError;
      throw new VoiceTranscriptionRoutingError(remoteError, localError);
    }
  }

  private async transcribeLocally(
    clip: NormalizedVoiceClip,
    signal: AbortSignal,
    fallbackUsed: boolean,
  ): Promise<RoutedVoiceTranscript> {
    const availability = await this.options.local.getAvailability();
    signal.throwIfAborted();
    if (availability.state !== "ready") {
      throw new VoiceTranscriptionBackendError({
        kind: "backend-unavailable",
        fallbackAllowed: false,
        safeMessage:
          availability.state === "requires-setup"
            ? "Set up offline voice transcription before using the microphone."
            : (availability.reason ?? "Offline voice transcription is unavailable."),
      });
    }
    const transcript = await this.options.local.transcribe(clip, { signal });
    return {
      text: transcript.text,
      engine: "local",
      fallbackUsed,
    };
  }

  private canAttemptRemote(): boolean {
    const blockedUntil = this.circuit.blockedUntil;
    if (blockedUntil === null) return true;
    if (blockedUntil > this.now()) return false;
    this.circuit = { ...this.circuit, blockedUntil: null };
    return true;
  }

  private recordRemoteFailure(error: unknown): void {
    const kind = failureKind(error);
    const consecutiveFailures = this.circuit.consecutiveFailures + 1;
    let blockedUntil: number | null = null;
    const now = this.now();
    if (kind === "authentication" || kind === "entitlement") {
      blockedUntil = now + this.authenticationCooldownMs;
    } else if (kind === "rate-limit") {
      const retryAfterMs =
        isVoiceTranscriptionBackendError(error) && error.retryAfterMs
          ? error.retryAfterMs
          : this.rateLimitCooldownMs;
      blockedUntil = now + retryAfterMs;
    } else if (consecutiveFailures >= this.transientFailureThreshold) {
      blockedUntil = now + this.transientCooldownMs;
    }
    this.circuit = {
      consecutiveFailures,
      blockedUntil,
      lastFailureKind: kind,
    };
  }
}

function isNonFallbackFailure(error: unknown): boolean {
  return isVoiceTranscriptionBackendError(error) && !error.fallbackAllowed;
}

function failureKind(error: unknown): VoiceTranscriptionErrorKind {
  return isVoiceTranscriptionBackendError(error) ? error.kind : "provider-error";
}
