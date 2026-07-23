// FILE: voiceTranscription.test.ts
// Purpose: Verifies ChatGPT-session voice transcription behavior without contacting OpenAI.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceTranscription utility and mocked fetch responses.

import type { ServerVoiceTranscriptionInput } from "@synara/contracts";
import { VoiceTranscriptionBackendError } from "@synara/shared/voiceTranscription";
import { describe, expect, it, vi } from "vitest";

import { transcribeVoiceWithChatGptSession } from "./voiceTranscription";

const WAV_BASE64 = Buffer.from("RIFF0000WAVE", "ascii").toString("base64");

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function chatGptToken(accountId = "account-123"): string {
  return `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.`;
}

function tokenWithoutAccount(): string {
  return `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart({ subject: "user-123" })}.`;
}

const baseRequest: ServerVoiceTranscriptionInput = {
  provider: "codex",
  cwd: "/tmp/project",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1_000,
  audioBase64: WAV_BASE64,
};

describe("transcribeVoiceWithChatGptSession", () => {
  it("uses the ChatGPT transcription backend", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl,
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(init).toBeDefined();
    expect(url).toBe("https://chatgpt.com/backend-api/transcribe");
    expect((init?.body as FormData | undefined)?.get("model")).toBeNull();
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-123");
    expect(new Headers(init?.headers).get("originator")).toBe("scient-desktop");
  });

  it("refreshes the ChatGPT session once when the upload is unauthorized", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    const resolveAuth = vi.fn(async (refreshToken: boolean) => ({
      token: refreshToken ? chatGptToken("fresh-account") : chatGptToken("stale-account"),
    }));

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(resolveAuth).toHaveBeenNthCalledWith(1, false);
    expect(resolveAuth).toHaveBeenNthCalledWith(2, true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondRequest = vi.mocked(fetchImpl).mock.calls[1]?.[1];
    expect(new Headers(secondRequest?.headers).get("chatgpt-account-id")).toBe("fresh-account");
  });

  it("refreshes once when the first request is forbidden", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    const resolveAuth = vi.fn(async () => ({ token: chatGptToken() }));

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(resolveAuth).toHaveBeenNthCalledWith(1, false);
    expect(resolveAuth).toHaveBeenNthCalledWith(2, true);
  });

  it("fails before upload when the session has no account context", async () => {
    const fetchImpl = vi.fn();

    const promise = transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: tokenWithoutAccount() }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(promise).rejects.toMatchObject({
      kind: "authentication",
      fallbackAllowed: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies a persistent forbidden response as an entitlement failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));

    const promise = transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(promise).rejects.toMatchObject({
      kind: "entitlement",
      fallbackAllowed: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves retry timing for rate limits", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
    );

    const promise = transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(promise).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 3_000 });
  });

  it("reports malformed successful responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));

    const promise = transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(promise).rejects.toMatchObject({ kind: "malformed-response" });
  });

  it("preserves caller cancellation without falling back", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    const promise = transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({
      kind: "cancelled",
      fallbackAllowed: false,
    });
  });

  it("classifies an expired request deadline as a fallback-safe timeout", async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });

    const promise = transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 1,
    });

    await expect(promise).rejects.toMatchObject({ kind: "timeout", fallbackAllowed: true });
  });

  it("does not allow fallback for invalid audio", async () => {
    const promise = transcribeVoiceWithChatGptSession({
      request: { ...baseRequest, mimeType: "audio/webm" },
      resolveAuth: async () => ({ token: chatGptToken() }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionBackendError);
    expect(error).toMatchObject({ kind: "invalid-audio", fallbackAllowed: false });
  });
});
