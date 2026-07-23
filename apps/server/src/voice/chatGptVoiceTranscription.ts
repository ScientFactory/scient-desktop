// FILE: chatGptVoiceTranscription.ts
// Purpose: Implements the isolated ChatGPT-subscription voice backend.
// Layer: Server voice backend
// Depends on: Codex-provided ChatGPT OAuth tokens and the private transcription endpoint.

import { Buffer } from "node:buffer";

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { extractChatGptAccountIdFromToken } from "@synara/shared/chatGptVoiceAuth";
import {
  type NormalizedVoiceClip,
  type VoiceTranscript,
  type VoiceTranscriptionBackend,
  VoiceTranscriptionBackendError,
  type VoiceTranscriptionErrorKind,
} from "@synara/shared/voiceTranscription";

export const CHATGPT_TRANSCRIPTIONS_URL = "https://chatgpt.com/backend-api/transcribe";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ChatGptVoiceAuthContext {
  readonly token: string;
}

type ResolveChatGptVoiceAuth = (refreshToken: boolean) => Promise<ChatGptVoiceAuthContext>;

interface ChatGptVoiceBackendOptions {
  readonly resolveAuth: ResolveChatGptVoiceAuth;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

function backendError(input: {
  kind: VoiceTranscriptionErrorKind;
  fallbackAllowed?: boolean;
  safeMessage: string;
  retryAfterMs?: number;
  cause?: unknown;
}): VoiceTranscriptionBackendError {
  return new VoiceTranscriptionBackendError({
    kind: input.kind,
    fallbackAllowed: input.fallbackAllowed ?? true,
    safeMessage: input.safeMessage,
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

function requireChatGptAccountContext(auth: ChatGptVoiceAuthContext): {
  readonly token: string;
  readonly accountId: string;
} {
  const token = auth.token.trim();
  if (!token) {
    throw backendError({
      kind: "authentication",
      safeMessage: "No ChatGPT session is available. Sign in to ChatGPT in Codex.",
    });
  }

  const accountId = extractChatGptAccountIdFromToken(token);
  if (!accountId) {
    throw backendError({
      kind: "authentication",
      safeMessage:
        "The ChatGPT session does not include an account context. Sign in to ChatGPT in Codex again.",
    });
  }

  return { token, accountId };
}

async function resolveAccountContext(
  resolveAuth: ResolveChatGptVoiceAuth,
  refreshToken: boolean,
): Promise<{ readonly token: string; readonly accountId: string }> {
  try {
    return requireChatGptAccountContext(await resolveAuth(refreshToken));
  } catch (cause) {
    if (cause instanceof VoiceTranscriptionBackendError) throw cause;
    throw backendError({
      kind: "authentication",
      safeMessage: "Scient could not read the ChatGPT session from Codex.",
      cause,
    });
  }
}

function validateClip(clip: NormalizedVoiceClip): void {
  if (clip.mimeType !== "audio/wav") {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "Only WAV audio is supported for voice transcription.",
    });
  }
  if (clip.sampleRateHz !== 24_000) {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "Voice transcription requires 24 kHz mono WAV audio.",
    });
  }
  if (clip.durationMs <= 0 || clip.durationMs > MAX_DURATION_MS) {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage:
        clip.durationMs <= 0
          ? "Voice messages must include a positive duration."
          : "Voice messages are limited to 120 seconds.",
    });
  }
  if (clip.audioBytes.byteLength === 0 || clip.audioBytes.byteLength > MAX_AUDIO_BYTES) {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage:
        clip.audioBytes.byteLength === 0
          ? "The recorded audio is empty."
          : "Voice messages are limited to 10 MB.",
    });
  }
  const header = Buffer.from(
    clip.audioBytes.buffer,
    clip.audioBytes.byteOffset,
    clip.audioBytes.byteLength,
  );
  if (
    header.byteLength < 12 ||
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "The recorded audio is not a valid WAV file.",
    });
  }
}

function parseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function statusFailure(response: Response): VoiceTranscriptionBackendError {
  if (response.status === 401) {
    return backendError({
      kind: "authentication",
      safeMessage: "ChatGPT rejected the current login. Sign in to ChatGPT in Codex again.",
    });
  }
  if (response.status === 403) {
    return backendError({
      kind: "entitlement",
      safeMessage: "ChatGPT voice transcription is not available for this session.",
    });
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response);
    return backendError({
      kind: "rate-limit",
      safeMessage: "ChatGPT voice transcription is temporarily rate limited.",
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return backendError({
    kind: "provider-error",
    safeMessage: `ChatGPT voice transcription failed with status ${response.status}.`,
  });
}

async function postTranscription(input: {
  readonly fetchImpl: typeof fetch;
  readonly clip: NormalizedVoiceClip;
  readonly token: string;
  readonly accountId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<Response> {
  if (input.signal.aborted) {
    throw backendError({
      kind: "cancelled",
      fallbackAllowed: false,
      safeMessage: "Voice transcription was cancelled.",
      cause: input.signal.reason,
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);

  try {
    const bytes = Buffer.from(
      input.clip.audioBytes.buffer,
      input.clip.audioBytes.byteOffset,
      input.clip.audioBytes.byteLength,
    );
    const formData = new FormData();
    formData.append("file", new Blob([bytes], { type: input.clip.mimeType }), "voice.wav");
    return await input.fetchImpl(CHATGPT_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
        "ChatGPT-Account-Id": input.accountId,
        Origin: "https://chatgpt.com",
        "User-Agent": "Scient Desktop",
        originator: "scient-desktop",
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (cause) {
    if (input.signal.aborted) {
      throw backendError({
        kind: "cancelled",
        fallbackAllowed: false,
        safeMessage: "Voice transcription was cancelled.",
        cause,
      });
    }
    if (timedOut) {
      throw backendError({
        kind: "timeout",
        safeMessage: "ChatGPT voice transcription timed out.",
        cause,
      });
    }
    throw backendError({
      kind: "network",
      safeMessage: "Scient could not reach ChatGPT voice transcription.",
      cause,
    });
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abortFromCaller);
  }
}

async function parseTranscript(response: Response): Promise<VoiceTranscript> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch (cause) {
    throw backendError({
      kind: "malformed-response",
      safeMessage: "ChatGPT returned an invalid transcription response.",
      cause,
    });
  }

  const record =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const textValue =
    typeof record?.text === "string"
      ? record.text
      : typeof record?.transcript === "string"
        ? record.transcript
        : "";
  const text = textValue.trim();
  if (!text) {
    throw backendError({
      kind: "malformed-response",
      safeMessage: "ChatGPT returned an empty transcription response.",
    });
  }
  return { text };
}

export function createChatGptVoiceTranscriptionBackend(
  options: ChatGptVoiceBackendOptions,
): VoiceTranscriptionBackend {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    id: "chatgpt",
    async getAvailability() {
      if (typeof fetchImpl !== "function") {
        return { state: "unavailable", reason: "fetch-unavailable" };
      }
      try {
        await resolveAccountContext(options.resolveAuth, false);
        return { state: "ready" };
      } catch (cause) {
        return {
          state: "unavailable",
          reason: cause instanceof VoiceTranscriptionBackendError ? cause.kind : "authentication",
        };
      }
    },
    async transcribe(clip, { signal }) {
      validateClip(clip);
      if (typeof fetchImpl !== "function") {
        throw backendError({
          kind: "backend-unavailable",
          safeMessage: "ChatGPT voice transcription is unavailable in this runtime.",
        });
      }

      let account = await resolveAccountContext(options.resolveAuth, false);
      let response = await postTranscription({
        fetchImpl,
        clip,
        ...account,
        signal,
        timeoutMs,
      });

      if (response.status === 401 || response.status === 403) {
        account = await resolveAccountContext(options.resolveAuth, true);
        response = await postTranscription({
          fetchImpl,
          clip,
          ...account,
          signal,
          timeoutMs,
        });
      }

      if (!response.ok) throw statusFailure(response);
      return parseTranscript(response);
    },
  };
}

function decodeServerRequest(request: ServerVoiceTranscriptionInput): NormalizedVoiceClip {
  if (request.mimeType !== "audio/wav") {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "Only WAV audio is supported for voice transcription.",
    });
  }

  const normalized = request.audioBase64.trim().replace(/\s+/gu, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "The recorded audio could not be decoded.",
    });
  }

  const audioBytes = Buffer.from(normalized, "base64");
  if (!audioBytes.byteLength || audioBytes.toString("base64") !== normalized) {
    throw backendError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "The recorded audio could not be decoded.",
    });
  }

  return {
    audioBytes,
    mimeType: request.mimeType,
    sampleRateHz: request.sampleRateHz,
    durationMs: request.durationMs,
    cwd: request.cwd,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  };
}

// Compatibility entrypoint used until the application-level router owns the request.
export async function transcribeVoiceWithChatGptSession(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly resolveAuth: ResolveChatGptVoiceAuth;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
}): Promise<ServerVoiceTranscriptionResult> {
  const backend = createChatGptVoiceTranscriptionBackend({
    resolveAuth: input.resolveAuth,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
  });
  return backend.transcribe(decodeServerRequest(input.request), {
    signal: input.signal ?? new AbortController().signal,
  });
}
