import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  correctVoiceTranscript,
  makeVoiceTranscriptCorrectionClient,
  type VoiceTranscriptCorrectionClient,
} from "./voiceTranscriptCorrectionClient.ts";

const environmentId = EnvironmentId.make("primary");

describe("correctVoiceTranscript", () => {
  it("does not call a provider while correction is disabled", async () => {
    const correct = vi.fn<VoiceTranscriptCorrectionClient["correct"]>();
    const result = await correctVoiceTranscript({
      enabled: false,
      client: { correct },
      environmentId,
      transcript: "helo",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "disabled", text: "helo" });
    expect(correct).not.toHaveBeenCalled();
  });

  it("returns a successful provider correction", async () => {
    const result = await correctVoiceTranscript({
      enabled: true,
      client: {
        correct: async () => ({
          text: "Hello.",
          provider: ProviderDriverKind.make("codex"),
        }),
      },
      environmentId,
      transcript: "helo",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      kind: "corrected",
      text: "Hello.",
      provider: "codex",
    });
  });

  it("falls back to the exact local transcript on every provider failure", async () => {
    const result = await correctVoiceTranscript({
      enabled: true,
      client: { correct: async () => Promise.reject(new Error("offline")) },
      environmentId,
      transcript: "keep  this raw",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "fallback", text: "keep  this raw" });
  });
});

describe("makeVoiceTranscriptCorrectionClient", () => {
  it("forwards a successful environment RPC result", async () => {
    const run = vi.fn().mockResolvedValue(
      AsyncResult.success({
        text: "Hello.",
        provider: ProviderDriverKind.make("claude"),
      }),
    );
    const client = makeVoiceTranscriptCorrectionClient(run);

    await expect(
      client.correct({
        environmentId,
        transcript: "helo",
        language: "en",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ text: "Hello.", provider: "claude" });
    expect(run).toHaveBeenCalledWith({
      environmentId,
      input: { transcript: "helo", language: "en" },
    });
  });

  it("lets Use original stop waiting without waiting for the RPC", async () => {
    const run = vi.fn(() => new Promise<never>(() => undefined));
    const client = makeVoiceTranscriptCorrectionClient(run);
    const abortController = new AbortController();
    const pending = client.correct({
      environmentId,
      transcript: "raw",
      signal: abortController.signal,
    });

    abortController.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
