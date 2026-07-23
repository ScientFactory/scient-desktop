// FILE: voiceTranscriptionRouter.test.ts
// Purpose: Verifies cloud-first routing, quiet local fallback, cancellation, and cooldown behavior.
// Layer: Shared runtime tests

import { describe, expect, it, vi } from "vitest";
import {
  type NormalizedVoiceClip,
  type VoiceTranscriptionBackend,
  VoiceTranscriptionBackendError,
} from "./voiceTranscription";
import {
  VoiceTranscriptionRouter,
  VoiceTranscriptionRoutingError,
} from "./voiceTranscriptionRouter";

const clip: NormalizedVoiceClip = {
  audioBytes: new Uint8Array([1, 2, 3]),
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 500,
  cwd: "/workspace",
};

function backend(
  id: "chatgpt" | "local",
  overrides: Partial<VoiceTranscriptionBackend> = {},
): VoiceTranscriptionBackend {
  return {
    id,
    getAvailability: vi.fn(async () => ({ state: "ready" as const })),
    transcribe: vi.fn(async () => ({ text: `${id} transcript` })),
    ...overrides,
  };
}

describe("VoiceTranscriptionRouter", () => {
  it("prefers ChatGPT when it is eligible and succeeds", async () => {
    const remote = backend("chatgpt");
    const local = backend("local");
    const router = new VoiceTranscriptionRouter({ remote, local });

    await expect(
      router.transcribe(clip, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      text: "chatgpt transcript",
      engine: "chatgpt",
      fallbackUsed: false,
    });
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it("uses local transcription when ChatGPT is ineligible", async () => {
    const remote = backend("chatgpt", {
      getAvailability: vi.fn(async () => ({
        state: "unavailable" as const,
        reason: "not connected",
      })),
    });
    const router = new VoiceTranscriptionRouter({
      remote,
      local: backend("local"),
    });

    await expect(
      router.transcribe(clip, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      text: "local transcript",
      engine: "local",
      fallbackUsed: true,
      fallbackReason: "ineligible",
    });
  });

  it("falls back quietly after a typed recoverable ChatGPT failure", async () => {
    const remote = backend("chatgpt", {
      transcribe: vi.fn(async () => {
        throw new VoiceTranscriptionBackendError({
          kind: "authentication",
          fallbackAllowed: true,
          safeMessage: "ChatGPT rejected the refreshed session.",
        });
      }),
    });
    const router = new VoiceTranscriptionRouter({
      remote,
      local: backend("local"),
      now: () => 100,
    });

    await expect(
      router.transcribe(clip, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      text: "local transcript",
      engine: "local",
      fallbackUsed: true,
      fallbackReason: "authentication",
    });
    expect(router.getCircuitState()).toEqual({
      consecutiveFailures: 1,
      blockedUntil: 300_100,
      lastFailureKind: "authentication",
    });
  });

  it("does not fallback after cancellation", async () => {
    const local = backend("local");
    const remote = backend("chatgpt", {
      transcribe: vi.fn(async () => {
        throw new VoiceTranscriptionBackendError({
          kind: "cancelled",
          fallbackAllowed: false,
          safeMessage: "Cancelled.",
        });
      }),
    });
    const router = new VoiceTranscriptionRouter({ remote, local });

    await expect(
      router.transcribe(clip, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it("opens a short circuit after repeated transient failures and later probes again", async () => {
    let now = 1_000;
    const remote = backend("chatgpt", {
      transcribe: vi.fn(async () => {
        throw new VoiceTranscriptionBackendError({
          kind: "network",
          fallbackAllowed: true,
          safeMessage: "Network unavailable.",
        });
      }),
    });
    const router = new VoiceTranscriptionRouter({
      remote,
      local: backend("local"),
      now: () => now,
      transientCooldownMs: 10_000,
    });
    const signal = new AbortController().signal;

    await router.transcribe(clip, { signal });
    await router.transcribe(clip, { signal });
    await expect(router.transcribe(clip, { signal })).resolves.toMatchObject({
      engine: "local",
      fallbackReason: "circuit-open",
    });
    expect(remote.transcribe).toHaveBeenCalledTimes(2);

    now += 10_001;
    await router.transcribe(clip, { signal });
    expect(remote.transcribe).toHaveBeenCalledTimes(3);
  });

  it("honors offline-only mode without checking ChatGPT", async () => {
    const remote = backend("chatgpt");
    const router = new VoiceTranscriptionRouter({
      remote,
      local: backend("local"),
    });

    await expect(
      router.transcribe(clip, {
        signal: new AbortController().signal,
        mode: "offline-only",
      }),
    ).resolves.toMatchObject({ engine: "local", fallbackUsed: false });
    expect(remote.getAvailability).not.toHaveBeenCalled();
  });

  it("falls back if checking ChatGPT availability fails", async () => {
    const remote = backend("chatgpt", {
      getAvailability: vi.fn(async () => {
        throw new Error("auth process unavailable");
      }),
    });
    const router = new VoiceTranscriptionRouter({
      remote,
      local: backend("local"),
      now: () => 10,
      transientFailureThreshold: 1,
    });

    await expect(
      router.transcribe(clip, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      engine: "local",
      fallbackReason: "provider-error",
    });
    expect(router.getCircuitState()).toMatchObject({
      blockedUntil: 60_010,
      lastFailureKind: "provider-error",
    });
  });

  it("honors a provider retry interval after rate limiting", async () => {
    const remote = backend("chatgpt", {
      transcribe: vi.fn(async () => {
        throw new VoiceTranscriptionBackendError({
          kind: "rate-limit",
          fallbackAllowed: true,
          safeMessage: "ChatGPT is busy.",
          retryAfterMs: 12_345,
        });
      }),
    });
    const router = new VoiceTranscriptionRouter({
      remote,
      local: backend("local"),
      now: () => 100,
    });

    await router.transcribe(clip, { signal: new AbortController().signal });
    expect(router.getCircuitState().blockedUntil).toBe(12_445);
  });

  it("reports a combined failure only when ChatGPT and local both fail", async () => {
    const remoteFailure = new Error("remote failed");
    const localFailure = new Error("local failed");
    const router = new VoiceTranscriptionRouter({
      remote: backend("chatgpt", {
        transcribe: vi.fn(async () => {
          throw remoteFailure;
        }),
      }),
      local: backend("local", {
        transcribe: vi.fn(async () => {
          throw localFailure;
        }),
      }),
    });

    const error = await router
      .transcribe(clip, { signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceTranscriptionRoutingError);
    expect(error).toMatchObject({
      remoteError: remoteFailure,
      localError: localFailure,
    });
  });
});
