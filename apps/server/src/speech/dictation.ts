import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  DictationError,
  type DictationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { CloudEngineError, type CloudEngines } from "../transcription/CloudEngines.ts";
import { dictateWithChatGptInstance } from "../transcription/chatgpt.ts";
import { isCloudResponseError } from "../transcription/cloud.ts";
import { RateLimited } from "../transcription/job.ts";
import type { SpeechService } from "./SpeechService.ts";
import { dictationPcm, readDictationWav } from "./dictationAudio.ts";

export interface DictationDependencies {
  speech: Pick<SpeechService["Service"], "dictateLocal" | "waitingForWorker"> | undefined;
  cloud: Pick<CloudEngines["Service"], "resolve"> | undefined;
  providerInstances: Pick<ProviderInstanceRegistry["Service"], "getInstance">;
}
const isCloudEngineError = Schema.is(CloudEngineError);
const isRateLimited = Schema.is(RateLimited);
function mapCloudError(error: unknown) {
  if (isCloudEngineError(error) && error.code === "consent-required")
    return new DictationError({ reason: "consent-required" });
  if (
    (isCloudEngineError(error) || isCloudResponseError(error)) &&
    error.code === "provider-key-rejected"
  )
    return new DictationError({ reason: "key-rejected" });
  return new DictationError({
    reason: isRateLimited(error) ? "rate-limited" : "cloud-unavailable",
  });
}

export const dispatchDictation = Effect.fn("Speech.dispatchDictation")(function* (
  { speech, cloud, providerInstances }: DictationDependencies,
  { selection, audioBase64, language, hints, silenceFiltering, removeFillerWords }: DictationInput,
) {
  const wav = yield* Effect.try({
    try: () => readDictationWav(audioBase64),
    catch: () => new DictationError({ reason: "invalid-audio" }),
  });
  if (selection.kind === "chatgpt") {
    return yield* dictateWithChatGptInstance(
      providerInstances,
      selection.instanceId,
      wav,
      language,
    );
  }
  const pcm = dictationPcm(wav);
  if (selection.kind === "local") {
    if (!speech) return yield* new DictationError({ reason: "local-unavailable" });
    const text = yield* speech
      .dictateLocal(selection.modelId, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: language ?? "auto",
        speechSilenceFiltering:
          silenceFiltering ?? DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS.speechSilenceFiltering,
        speechRemoveFillerWords: removeFillerWords ?? false,
        ...(hints?.length ? { speechHints: hints } : {}),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new DictationError({
              reason:
                error._tag === "SpeechUnsupportedLanguageError"
                  ? "unsupported-language"
                  : error._tag === "SpeechModelNotFoundError"
                    ? "model-not-found"
                    : error._tag === "SpeechInvalidAudioError"
                      ? "invalid-audio"
                      : "local-unavailable",
            }),
        ),
      );
    return { text };
  }
  const unavailable = () => new DictationError({ reason: "cloud-unavailable" });
  if (!cloud) return yield* unavailable();
  const engine = yield* cloud.resolve(selection.engineId).pipe(Effect.mapError(mapCloudError));
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const recognizer = engine.open(language ?? "auto", signal, "dictation");
      try {
        const result = await recognizer.recognize(
          pcm,
          false,
          recognizer.recognitionHints && hints?.length ? { terms: hints } : undefined,
        );
        return { text: result.map(({ text }) => text).join(" ") };
      } finally {
        await recognizer.close();
      }
    },
    catch: mapCloudError,
  });
});
