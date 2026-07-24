import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import type { NormalizedVoiceClip } from "@synara/shared/voiceTranscription";
import { net } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "test" },
  net: { request: vi.fn() },
}));

import {
  createDesktopChatGptVoiceTranscriptionBackend,
  requestDesktopVoiceTranscription,
} from "./chatGptVoiceTranscription";

function chatGptToken(accountId: string | null = "account-123"): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode(
    accountId === null
      ? { subject: "user-123" }
      : {
          "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        },
  )}.`;
}

const clip: NormalizedVoiceClip = {
  audioBytes: Buffer.from("RIFF0000WAVE", "ascii"),
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1_000,
  cwd: "/tmp/project",
};

describe("createDesktopChatGptVoiceTranscriptionBackend", () => {
  it("passes token-bound account context to the desktop upload", async () => {
    const upload = vi.fn(async () => ({ statusCode: 200, body: '{"text":" hello "}' }));
    const backend = createDesktopChatGptVoiceTranscriptionBackend({
      cwd: clip.cwd,
      resolveAuth: async () => ({ token: chatGptToken() }),
      upload,
    });

    await expect(
      backend.transcribe(clip, { signal: new AbortController().signal }),
    ).resolves.toEqual({ text: "hello" });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        token: chatGptToken(),
        accountId: "account-123",
      }),
    );
  });

  it("reuses the successful eligibility account context for the immediate transcription", async () => {
    const resolveAuth = vi.fn(async () => ({ token: chatGptToken() }));
    const upload = vi.fn(async () => ({ statusCode: 200, body: '{"text":"hello"}' }));
    const backend = createDesktopChatGptVoiceTranscriptionBackend({
      cwd: clip.cwd,
      resolveAuth,
      upload,
    });
    const signal = new AbortController().signal;

    await expect(backend.getAvailability({ signal })).resolves.toMatchObject({ state: "ready" });
    await expect(backend.transcribe(clip, { signal })).resolves.toEqual({ text: "hello" });

    expect(resolveAuth).toHaveBeenCalledOnce();
  });

  it("refreshes auth exactly once after a forbidden response", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 403, body: "{}" })
      .mockResolvedValueOnce({ statusCode: 200, body: '{"transcript":"hello"}' });
    const resolveAuth = vi.fn(async (refreshToken: boolean) => ({
      token: chatGptToken(refreshToken ? "fresh-account" : "stale-account"),
    }));
    const backend = createDesktopChatGptVoiceTranscriptionBackend({
      cwd: clip.cwd,
      resolveAuth,
      upload,
    });

    await backend.transcribe(clip, { signal: new AbortController().signal });

    expect(resolveAuth).toHaveBeenNthCalledWith(1, false, expect.any(AbortSignal));
    expect(resolveAuth).toHaveBeenNthCalledWith(2, true, expect.any(AbortSignal));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]?.[0]).toMatchObject({ accountId: "fresh-account" });
  });

  it("does not upload without a token-bound account context", async () => {
    const upload = vi.fn();
    const backend = createDesktopChatGptVoiceTranscriptionBackend({
      cwd: clip.cwd,
      resolveAuth: async () => ({ token: chatGptToken(null) }),
      upload,
    });

    await expect(
      backend.transcribe(clip, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ kind: "authentication", fallbackAllowed: true });
    expect(upload).not.toHaveBeenCalled();
  });

  it("marks persistent entitlement failures as safe to fall back", async () => {
    const backend = createDesktopChatGptVoiceTranscriptionBackend({
      cwd: clip.cwd,
      resolveAuth: async () => ({ token: chatGptToken() }),
      upload: async () => ({ statusCode: 403, body: "{}" }),
    });

    await expect(
      backend.transcribe(clip, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ kind: "entitlement", fallbackAllowed: true });
  });

  it("propagates cancellation while checking ChatGPT eligibility", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const backend = createDesktopChatGptVoiceTranscriptionBackend({
      cwd: clip.cwd,
      resolveAuth: (_refreshToken, signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      upload: vi.fn(),
    });

    const availability = backend.getAvailability({ signal: controller.signal });
    controller.abort(new Error("cancelled"));

    await expect(availability).resolves.toMatchObject({ state: "unavailable" });
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("requestDesktopVoiceTranscription", () => {
  it("lets Electron frame the request body without setting restricted Content-Length", async () => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
    });
    const setHeader = vi.fn((name: string) => {
      if (name.toLowerCase() === "content-length") {
        throw new Error("Electron forbids setting Content-Length");
      }
    });
    const request = Object.assign(new EventEmitter(), {
      abort: vi.fn(),
      setHeader,
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          request.emit("response", response);
          response.emit("data", Buffer.from('{"text":"hello"}', "utf8"));
          response.emit("end");
        });
      }),
    });
    vi.mocked(net.request).mockReturnValue(request as never);

    await expect(
      requestDesktopVoiceTranscription({
        clip,
        token: chatGptToken(),
        accountId: "account-123",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ statusCode: 200, body: '{"text":"hello"}' });

    expect(setHeader).not.toHaveBeenCalledWith("Content-Length", expect.any(String));
  });
});
