import { DictationRecognitionHints } from "./transcriptionWords.ts";
// Scient dictation preferences and recorded-audio job payloads.

import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/** Maximum encoded length for a 10 MiB recording. */
export const VOICE_AUDIO_BASE64_MAX_CHARS = 4 * Math.ceil((10 * 1024 * 1024) / 3);

/**
 * A three-minute recording is normally far smaller than this. The bound is
 * deliberately generous while still preventing an untrusted client from
 * turning transcript correction into an unbounded provider request.
 */
export const VOICE_TRANSCRIPT_CORRECTION_MAX_CHARS = 20_000;

/** Languages Scient can explicitly pin for local catalog transcription. */
const VOICE_TRANSCRIPTION_LANGUAGE_CODES = [
  "ar",
  "de",
  "el",
  "en",
  "es",
  "fa",
  "fr",
  "he",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "tr",
  "uk",
  "vi",
  "zh",
] as const;
export const VoiceTranscriptionLanguage = Schema.Literals(VOICE_TRANSCRIPTION_LANGUAGE_CODES);
export type VoiceTranscriptionLanguage = typeof VoiceTranscriptionLanguage.Type;

/** Saved preference. `auto` uses automatic language detection. */
export const VoiceLanguagePreference = Schema.Literals([
  "auto",
  ...VOICE_TRANSCRIPTION_LANGUAGE_CODES,
]);
export type VoiceLanguagePreference = typeof VoiceLanguagePreference.Type;

/**
 * Who turns dictation into text. `local` is the local environment's speech worker and `chatgpt` is ChatGPT through
 * a provider's ChatGPT sign-in (Scient Agent or Codex). `auto` has not chosen yet: it dictates with
 * a local model that is already set up, and otherwise offers ChatGPT, when a sign-in exists, beside
 * the local models the first time the microphone is used.
 */
export const VoiceDictationEngine = Schema.Literals(["auto", "local", "cloud", "chatgpt", "off"]);
export type VoiceDictationEngine = typeof VoiceDictationEngine.Type;

export const VOICE_LANGUAGE_NAMES = {
  auto: "Automatic",
  ar: "Arabic",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fa: "Persian",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese",
} as const satisfies Record<VoiceLanguagePreference, string>;

export const VoiceTranscriptCorrectionText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VOICE_TRANSCRIPT_CORRECTION_MAX_CHARS),
);
export type VoiceTranscriptCorrectionText = typeof VoiceTranscriptCorrectionText.Type;

export const VoiceTranscriptCorrectionRequest = Schema.Struct({
  hints: Schema.optionalKey(DictationRecognitionHints),
  transcript: VoiceTranscriptCorrectionText,
  language: Schema.optionalKey(VoiceTranscriptionLanguage),
});
export type VoiceTranscriptCorrectionRequest = typeof VoiceTranscriptCorrectionRequest.Type;

export const VoiceTranscriptCorrectionResult = Schema.Struct({
  text: VoiceTranscriptCorrectionText,
  provider: ProviderDriverKind,
});
export type VoiceTranscriptCorrectionResult = typeof VoiceTranscriptCorrectionResult.Type;

export const VoiceTranscriptCorrectionFailureKind = Schema.Literals([
  "unsupported",
  "provider-unavailable",
  "authentication",
  "timeout",
  "provider-error",
  "malformed-response",
]);
export type VoiceTranscriptCorrectionFailureKind = typeof VoiceTranscriptCorrectionFailureKind.Type;

/** Safe, content-free failure returned to the client before it falls back. */
export class VoiceTranscriptCorrectionError extends Schema.TaggedError<VoiceTranscriptCorrectionError>()(
  "VoiceTranscriptCorrectionError",
  {
    kind: VoiceTranscriptCorrectionFailureKind,
    message: TrimmedNonEmptyString,
  },
) {}

/** Transcription engine identifier. Engine-neutral; only `local` ships now. */
export const VoiceEngineId = Schema.Literals(["local"]);
export type VoiceEngineId = typeof VoiceEngineId.Type;

/** Host-level microphone authorization state used before renderer capture begins. */
export const VoiceMicrophoneAccessStatus = Schema.Literals([
  "granted",
  "denied",
  "restricted",
  "unavailable",
]);
export type VoiceMicrophoneAccessStatus = typeof VoiceMicrophoneAccessStatus.Type;

/**
 * Provider-neutral failure taxonomy. Kept complete (including remote-shaped
 * kinds) so any current or future engine maps cleanly into a single wire type.
 */
export const VoiceTranscriptionErrorKind = Schema.Literals([
  "cancelled",
  "invalid-audio",
  "authentication",
  "entitlement",
  "rate-limit",
  "network",
  "timeout",
  "provider-error",
  "malformed-response",
  "backend-unavailable",
  "model-missing",
  "insufficient-storage",
]);
export type VoiceTranscriptionErrorKind = typeof VoiceTranscriptionErrorKind.Type;

/** The only accepted recorded-audio container. */
export const VoiceAudioMimeType = Schema.Literal("audio/wav");
export type VoiceAudioMimeType = typeof VoiceAudioMimeType.Type;

const VoiceTranscriptionRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const VoiceCancelTranscriptionRequest = Schema.Struct({
  requestId: VoiceTranscriptionRequestId,
});
export type VoiceCancelTranscriptionRequest = typeof VoiceCancelTranscriptionRequest.Type;

/** Recorded clip passed by the dictation controller to the selected engine adapter. */
export const VoiceTranscribeRequest = Schema.Struct({
  hints: Schema.optionalKey(DictationRecognitionHints),
  requestId: Schema.optionalKey(VoiceTranscriptionRequestId),
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_AUDIO_BASE64_MAX_CHARS)),
  mimeType: VoiceAudioMimeType,
  sampleRateHz: NonNegativeInt,
  durationMs: NonNegativeInt,
  language: Schema.optionalKey(VoiceTranscriptionLanguage),
});
export type VoiceTranscribeRequest = typeof VoiceTranscribeRequest.Type;

/** A finished transcript. Carries `engine` so the origin is never ambiguous. */
export const VoiceTranscript = Schema.Struct({
  text: Schema.String,
  engine: VoiceEngineId,
  language: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceTranscript = typeof VoiceTranscript.Type;
