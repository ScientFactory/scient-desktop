// @effect-diagnostics globalDate:off globalTimers:off - The recognizer uses the streaming pipeline’s Promise and AbortSignal boundary.
import * as Schema from "effect/Schema";
import { wave } from "../speech/CloudSpeech.ts";
import { RateLimited, type Engine } from "./job.ts";
import { sampleRate } from "./windows.ts";

export class CloudResponseError extends Schema.TaggedError<CloudResponseError>()(
  "TranscriptionCloudResponseError",
  {
    code: Schema.Literals([
      "provider-key-rejected",
      "provider-response-too-large",
      "recognition-failed",
    ]),
  },
) {}

export const isCloudResponseError = Schema.is(CloudResponseError);

const responseLimit = 1024 * 1024;
async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CloudResponseError({ code: "recognition-failed" });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > responseLimit) {
        throw new CloudResponseError({ code: "provider-response-too-large" });
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function retryDelay(header: string | null) {
  if (!header?.trim()) return;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isFinite(ms) && ms >= 0 && ms <= 30_000) return Math.max(ms, 1000);
}

function failedBeforeSend(error: unknown) {
  if (!(error instanceof TypeError) || !error.cause || typeof error.cause !== "object")
    return false;
  const code = "code" in error.cause ? error.cause.code : undefined;
  return (
    typeof code === "string" &&
    ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
  );
}

type Provider = "openai" | "xai" | "openrouter" | "compatible";

type CloudOptions = {
  provider: Provider;
  endpoint: URL;
  model: string;
  language: string;
  maxAudioBytes: number;
  onRetry?: (reason: "connect" | "rate-limit" | "server-error") => Promise<void>;
};

export function openCloudEngine(
  options: CloudOptions,
  resolveKey: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  request = fetch,
): Engine {
  return {
    commitReceivedOnCancel: true,
    recognitionHints: options.provider === "openai" || options.provider === "xai",
    async recognize(pcm, _retry, hints) {
      if (44 + pcm.length * 2 > options.maxAudioBytes) {
        throw new Error("Transcription window exceeds the configured WAV size limit.");
      }

      const audio = wave(pcm);
      let retriedServerError = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const key = await resolveKey(signal);
        const language = options.language === "auto" ? undefined : options.language;
        const headers = new Headers({ authorization: "Bearer " + key });
        let body: FormData | string;
        if (options.provider === "openrouter") {
          headers.set("content-type", "application/json");
          body = JSON.stringify({
            model: options.model,
            input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
            language,
            provider: { zdr: true },
          });
        } else {
          const form = new FormData();
          form.set("model", options.model);
          if (language)
            form.set(options.provider === "openai" ? "languages[]" : "language", language);
          if (options.provider === "xai") {
            if (language) form.set("format", "true");
            form.set("filler_words", "true");
            form.set("vad_threshold", "0");
          }
          if (options.provider === "openai" || options.provider === "xai") {
            for (const term of hints?.terms?.slice(0, 8) ?? []) {
              if (options.provider === "openai" && /[<>\r\n]/.test(term)) continue;
              form.append(options.provider === "openai" ? "keywords[]" : "keyterm", term);
            }
          }
          form.set("file", new Blob([audio], { type: "audio/wav" }), "window.wav");
          body = form;
        }

        let response: Response;
        try {
          response = await request(options.endpoint, {
            method: "POST",
            headers,
            body,
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          });
        } catch (error) {
          signal.throwIfAborted();
          if (attempt === 2 || !failedBeforeSend(error)) {
            // The transport cause can contain request credentials.
            throw new CloudResponseError({ code: "recognition-failed" });
          }
          await options.onRetry?.("connect");
          await abortableDelay(1000 * 2 ** attempt, signal);
          continue;
        }
        if (response.ok) {
          const value = await readResponse(response).catch((error: unknown) => {
            if (isCloudResponseError(error)) throw error;
            // Do not expose parser messages containing provider response text.
            throw new CloudResponseError({ code: "recognition-failed" });
          });
          if (
            !value ||
            typeof value !== "object" ||
            !("text" in value) ||
            typeof value.text !== "string"
          )
            throw new CloudResponseError({ code: "recognition-failed" });
          return [
            {
              text: value.text.replaceAll(key, "[redacted]").trim(),
              start: 0,
              end: pcm.length / sampleRate,
            },
          ];
        }

        void response.body?.cancel().catch(() => undefined);
        if ([401, 403].includes(response.status))
          throw new CloudResponseError({ code: "provider-key-rejected" });
        if (response.status === 429) {
          const delay = retryDelay(response.headers.get("retry-after"));
          if (attempt === 2 || delay === undefined) throw new RateLimited();
          await options.onRetry?.("rate-limit");
          await abortableDelay(delay, signal);
          continue;
        }
        if (response.status >= 500 && attempt < 2 && !retriedServerError) {
          retriedServerError = true;
          await options.onRetry?.("server-error");
          await abortableDelay(1000, signal);
          continue;
        }
        break;
      }
      throw new Error("Cloud transcription provider unavailable.");
    },
    async close() {},
  };
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
