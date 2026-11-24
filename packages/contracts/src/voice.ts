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

/** Local speech catalog languages and English names for clients with limited ICU data. */
export const VOICE_LANGUAGE_NAMES = {
  af: "Afrikaans",
  am: "Amharic",
  ar: "Arabic",
  as: "Assamese",
  az: "Azerbaijani",
  ba: "Bashkir",
  be: "Belarusian",
  bg: "Bulgarian",
  bn: "Bangla",
  bo: "Tibetan",
  br: "Breton",
  bs: "Bosnian",
  ca: "Catalan",
  cs: "Czech",
  cy: "Welsh",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  eu: "Basque",
  fa: "Persian",
  fi: "Finnish",
  fil: "Filipino",
  fo: "Faroese",
  fr: "French",
  ga: "Irish",
  gl: "Galician",
  gu: "Gujarati",
  ha: "Hausa",
  haw: "Hawaiian",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  ht: "Haitian Creole",
  hu: "Hungarian",
  hy: "Armenian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  jw: "Javanese",
  ka: "Georgian",
  kk: "Kazakh",
  km: "Khmer",
  kn: "Kannada",
  ko: "Korean",
  la: "Latin",
  lb: "Luxembourgish",
  ln: "Lingala",
  lo: "Lao",
  lt: "Lithuanian",
  lv: "Latvian",
  mg: "Malagasy",
  mi: "Māori",
  mk: "Macedonian",
  ml: "Malayalam",
  mn: "Mongolian",
  mr: "Marathi",
  ms: "Malay",
  mt: "Maltese",
  my: "Burmese",
  nb: "Norwegian Bokmål",
  ne: "Nepali",
  nl: "Dutch",
  nn: "Norwegian Nynorsk",
  no: "Norwegian",
  oc: "Occitan",
  pa: "Punjabi",
  pl: "Polish",
  ps: "Pashto",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sa: "Sanskrit",
  sd: "Sindhi",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  sn: "Shona",
  so: "Somali",
  sq: "Albanian",
  sr: "Serbian",
  su: "Sundanese",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  tg: "Tajik",
  th: "Thai",
  tk: "Turkmen",
  tl: "Tagalog",
  tr: "Turkish",
  tt: "Tatar",
  uk: "Ukrainian",
  ur: "Urdu",
  uz: "Uzbek",
  vi: "Vietnamese",
  yi: "Yiddish",
  yo: "Yoruba",
  yue: "Cantonese",
  zh: "Chinese",
} as const;
export const VOICE_TRANSCRIPTION_LANGUAGE_CODES = Object.keys(
  VOICE_LANGUAGE_NAMES,
) as ReadonlyArray<keyof typeof VOICE_LANGUAGE_NAMES>;
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
