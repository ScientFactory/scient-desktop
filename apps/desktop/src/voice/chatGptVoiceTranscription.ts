// FILE: chatGptVoiceTranscription.ts
// Purpose: Implements ChatGPT-subscription transcription in the Electron main process.
// Layer: Desktop voice backend
// Depends on: Codex auth discovery, Electron net, and shared voice contracts.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";

import { app, net } from "electron";
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
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";

export const CHATGPT_TRANSCRIPTIONS_URL = "https://chatgpt.com/backend-api/transcribe";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const AUTH_DISCOVERY_TIMEOUT_MS = 10_000;
const AUTH_CONTEXT_CACHE_MS = 15_000;

interface ChatGptAccountContext {
  readonly token: string;
  readonly accountId: string;
}

interface DesktopVoiceUploadResult {
  readonly statusCode: number;
  readonly body: string;
  readonly retryAfter?: string;
}

type ResolveDesktopVoiceAuth = (
  refreshToken: boolean,
  signal?: AbortSignal,
) => Promise<{ readonly token: string }>;

export interface DesktopVoiceProcessContext {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

type UploadDesktopVoice = (input: {
  readonly clip: NormalizedVoiceClip;
  readonly token: string;
  readonly accountId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<DesktopVoiceUploadResult>;

export interface DesktopChatGptVoiceBackendOptions {
  readonly cwd: string;
  readonly resolveAuth?: ResolveDesktopVoiceAuth;
  readonly resolveProcessContext?: () => Promise<DesktopVoiceProcessContext>;
  readonly upload?: UploadDesktopVoice;
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

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
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

function requireAccountContext(auth: { readonly token: string }): ChatGptAccountContext {
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
  resolveAuth: ResolveDesktopVoiceAuth,
  refreshToken: boolean,
  signal?: AbortSignal,
): Promise<ChatGptAccountContext> {
  try {
    return requireAccountContext(await resolveAuth(refreshToken, signal));
  } catch (cause) {
    if (cause instanceof VoiceTranscriptionBackendError) throw cause;
    throw backendError({
      kind: "authentication",
      safeMessage: "Scient could not read the ChatGPT session from Codex.",
      cause,
    });
  }
}

export async function resolveDesktopVoiceAuth(
  cwd: string,
  refreshToken: boolean,
  processContext: DesktopVoiceProcessContext = { binaryPath: "codex", env: process.env },
  signal?: AbortSignal,
): Promise<{ readonly token: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const prepared = prepareWindowsSafeProcess(processContext.binaryPath, ["app-server"], {
      cwd,
      env: processContext.env,
    });
    const child = ChildProcess.spawn(prepared.command, prepared.args, {
      cwd,
      env: processContext.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: prepared.shell,
      windowsHide: prepared.windowsHide,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });

    let settled = false;
    let refreshAttempted = refreshToken;
    let stdoutBuffer = "";
    const initializeTimer = setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "scient-desktop",
            title: "Scient Desktop",
            version: app.getVersion(),
          },
          capabilities: { experimentalApi: true },
        },
      });
    }, 100);
    const discoveryTimer = setTimeout(() => {
      rejectOnce(new Error("Timed out while reading ChatGPT auth from Codex."));
    }, AUTH_DISCOVERY_TIMEOUT_MS);
    discoveryTimer.unref();

    function cleanup(): void {
      clearTimeout(initializeTimer);
      clearTimeout(discoveryTimer);
      child.kill();
      signal?.removeEventListener("abort", abortAuthDiscovery);
    }
    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function resolveOnce(value: { readonly token: string }): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function send(payload: Record<string, unknown>): void {
      if (!settled && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    }
    function abortAuthDiscovery(): void {
      rejectOnce(new Error("ChatGPT auth discovery was cancelled."));
    }

    signal?.addEventListener("abort", abortAuthDiscovery, { once: true });

    child.once("error", (error) => {
      rejectOnce(new Error(`Could not start Codex auth discovery: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        rejectOnce(
          new Error(`Codex auth discovery exited before responding (${signal ?? String(code)}).`),
        );
      }
    });
    child.stderr.on("data", () => {
      // Codex may log to stderr; the JSON-RPC response remains authoritative.
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\n/u);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "getAuthStatus",
            params: { includeToken: true, refreshToken },
          });
          continue;
        }
        if (message.id !== 2 && message.id !== 3) continue;

        const result =
          typeof message.result === "object" && message.result !== null
            ? (message.result as Record<string, unknown>)
            : null;
        const authMethod = readNonEmptyString(result?.authMethod);
        const token = readNonEmptyString(result?.authToken);
        if (!token) {
          if (!refreshAttempted) {
            refreshAttempted = true;
            send({
              jsonrpc: "2.0",
              id: 3,
              method: "getAuthStatus",
              params: { includeToken: true, refreshToken: true },
            });
            continue;
          }
          rejectOnce(
            new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex."),
          );
          return;
        }
        if (authMethod !== "chatgpt" && authMethod !== "chatgptAuthTokens") {
          rejectOnce(
            new Error("Voice transcription requires a ChatGPT-authenticated Codex session."),
          );
          return;
        }
        resolveOnce({ token });
      }
    });
  });
}

export async function requestDesktopVoiceTranscription(input: {
  readonly clip: NormalizedVoiceClip;
  readonly token: string;
  readonly accountId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<DesktopVoiceUploadResult> {
  if (input.signal.aborted) {
    throw backendError({
      kind: "cancelled",
      fallbackAllowed: false,
      safeMessage: "Voice transcription was cancelled.",
      cause: input.signal.reason,
    });
  }

  const boundary = `ScientVoice-${Crypto.randomUUID()}`;
  const audioBuffer = Buffer.from(
    input.clip.audioBytes.buffer,
    input.clip.audioBytes.byteOffset,
    input.clip.audioBytes.byteLength,
  );
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: ${input.clip.mimeType}\r\n\r\n`,
    "utf8",
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([preamble, audioBuffer, closing]);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const request = net.request({ method: "POST", url: CHATGPT_TRANSCRIPTIONS_URL });
    const timeout = setTimeout(() => {
      timedOut = true;
      request.abort();
      rejectOnce(
        backendError({
          kind: "timeout",
          safeMessage: "ChatGPT voice transcription timed out.",
        }),
      );
    }, input.timeoutMs);
    const abortFromCaller = () => {
      request.abort();
      rejectOnce(
        backendError({
          kind: "cancelled",
          fallbackAllowed: false,
          safeMessage: "Voice transcription was cancelled.",
          cause: input.signal.reason,
        }),
      );
    };

    function cleanup(): void {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abortFromCaller);
    }
    function rejectOnce(error: VoiceTranscriptionBackendError): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function resolveOnce(value: DesktopVoiceUploadResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    input.signal.addEventListener("abort", abortFromCaller, { once: true });
    request.setHeader("Accept", "application/json");
    request.setHeader("Authorization", `Bearer ${input.token}`);
    request.setHeader("ChatGPT-Account-Id", input.accountId);
    request.setHeader("Origin", "https://chatgpt.com");
    request.setHeader("User-Agent", "Scient Desktop");
    request.setHeader("originator", "scient-desktop");
    request.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
    request.setHeader("Content-Length", String(body.byteLength));

    request.once("error", (cause) => {
      if (settled || timedOut) return;
      rejectOnce(
        backendError({
          kind: "network",
          safeMessage: "Scient could not reach ChatGPT voice transcription.",
          cause,
        }),
      );
    });
    request.on("response", (response) => {
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk.toString();
      });
      response.once("end", () => {
        const retryAfterHeader = response.headers["retry-after"];
        const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
        resolveOnce({
          statusCode: response.statusCode,
          body: responseBody,
          ...(retryAfter ? { retryAfter } : {}),
        });
      });
      response.once("error", (cause) => {
        rejectOnce(
          backendError({
            kind: "network",
            safeMessage: "ChatGPT voice transcription response was interrupted.",
            cause,
          }),
        );
      });
    });

    request.write(body);
    request.end();
  });
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function statusFailure(response: DesktopVoiceUploadResult): VoiceTranscriptionBackendError {
  if (response.statusCode === 401) {
    return backendError({
      kind: "authentication",
      safeMessage: "ChatGPT rejected the current login. Sign in to ChatGPT in Codex again.",
    });
  }
  if (response.statusCode === 403) {
    return backendError({
      kind: "entitlement",
      safeMessage: "ChatGPT voice transcription is not available for this session.",
    });
  }
  if (response.statusCode === 429) {
    const retryAfterMs = parseRetryAfterMs(response.retryAfter);
    return backendError({
      kind: "rate-limit",
      safeMessage: "ChatGPT voice transcription is temporarily rate limited.",
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return backendError({
    kind: "provider-error",
    safeMessage: `ChatGPT voice transcription failed with status ${response.statusCode}.`,
  });
}

function parseTranscript(response: DesktopVoiceUploadResult): VoiceTranscript {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch (cause) {
    throw backendError({
      kind: "malformed-response",
      safeMessage: "ChatGPT returned an invalid transcription response.",
      cause,
    });
  }
  const record =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const value =
    typeof record?.text === "string"
      ? record.text
      : typeof record?.transcript === "string"
        ? record.transcript
        : "";
  const text = value.trim();
  if (!text) {
    throw backendError({
      kind: "malformed-response",
      safeMessage: "ChatGPT returned an empty transcription response.",
    });
  }
  return { text };
}

export function createDesktopChatGptVoiceTranscriptionBackend(
  options: DesktopChatGptVoiceBackendOptions,
): VoiceTranscriptionBackend {
  const cwd = options.cwd.trim() || process.cwd();
  const resolveAuth =
    options.resolveAuth ??
    (async (refreshToken: boolean, signal?: AbortSignal) =>
      resolveDesktopVoiceAuth(
        cwd,
        refreshToken,
        options.resolveProcessContext
          ? await options.resolveProcessContext()
          : { binaryPath: "codex", env: process.env },
        signal,
      ));
  const upload = options.upload ?? requestDesktopVoiceTranscription;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cachedAccount: {
    readonly account: ChatGptAccountContext;
    readonly expiresAt: number;
  } | null = null;

  const takeCachedAccount = (): ChatGptAccountContext | null => {
    const cached = cachedAccount;
    cachedAccount = null;
    return cached && cached.expiresAt > Date.now() ? cached.account : null;
  };

  return {
    id: "chatgpt",
    async getAvailability({ signal }: { readonly signal?: AbortSignal } = {}) {
      try {
        const account = await resolveAccountContext(resolveAuth, false, signal);
        signal?.throwIfAborted();
        cachedAccount = { account, expiresAt: Date.now() + AUTH_CONTEXT_CACHE_MS };
        return { state: "ready" };
      } catch (cause) {
        cachedAccount = null;
        return {
          state: "unavailable",
          reason: cause instanceof VoiceTranscriptionBackendError ? cause.kind : "authentication",
        };
      }
    },
    async transcribe(clip, { signal }) {
      validateClip(clip);
      let account =
        takeCachedAccount() ?? (await resolveAccountContext(resolveAuth, false, signal));
      let response = await upload({ clip, ...account, signal, timeoutMs });

      if (response.statusCode === 401 || response.statusCode === 403) {
        cachedAccount = null;
        account = await resolveAccountContext(resolveAuth, true, signal);
        response = await upload({ clip, ...account, signal, timeoutMs });
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw statusFailure(response);
      }
      return parseTranscript(response);
    },
  };
}

function decodeDesktopRequest(request: ServerVoiceTranscriptionInput): NormalizedVoiceClip {
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

export async function transcribeVoiceViaDesktopBridge(
  input: ServerVoiceTranscriptionInput,
): Promise<ServerVoiceTranscriptionResult> {
  const backend = createDesktopChatGptVoiceTranscriptionBackend({ cwd: input.cwd });
  return backend.transcribe(decodeDesktopRequest(input), {
    signal: new AbortController().signal,
  });
}
