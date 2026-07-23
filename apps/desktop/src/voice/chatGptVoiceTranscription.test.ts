import { Buffer } from "node:buffer";

import type { NormalizedVoiceClip } from "@synara/shared/voiceTranscription";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "test" },
  net: { request: vi.fn() },
}));

import { createDesktopChatGptVoiceTranscriptionBackend } from "./chatGptVoiceTranscription";

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

    expect(resolveAuth).toHaveBeenNthCalledWith(1, false);
    expect(resolveAuth).toHaveBeenNthCalledWith(2, true);
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
});
