import { AccountId } from "./accounts.ts";
import { DictationRecognitionHints } from "../transcriptionWords.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { VOICE_AUDIO_BASE64_MAX_CHARS, voiceLanguageRequestSchemaFields } from "../voice.ts";

/**
 * Dictation with ChatGPT: a provider instance (Scient Agent or Codex) sends the recording to
 * ChatGPT's own transcription service with its ChatGPT sign-in, and returns the text.
 */
export const ChatGptDictationInput = Schema.Struct({
  /** The provider instance whose ChatGPT sign-in transcribes. */
  instanceId: ProviderInstanceId,
  /** A 16-bit mono WAV recording. */
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_AUDIO_BASE64_MAX_CHARS)),
  language: voiceLanguageRequestSchemaFields.language,
});
export type ChatGptDictationInput = typeof ChatGptDictationInput.Type;

export const ChatGptDictationErrorReason = Schema.Literals([
  "signed-out",
  "invalid-audio",
  "rate-limited",
  "unavailable",
  /** The installed Scient Agent predates dictation. */
  "update-required",
  /** No such provider instance, or it could not run. */
  "agent-unavailable",
]);
export type ChatGptDictationErrorReason = typeof ChatGptDictationErrorReason.Type;

export class ChatGptDictationError extends Schema.TaggedError<ChatGptDictationError>()(
  "ChatGptDictationError",
  { reason: ChatGptDictationErrorReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "signed-out":
        return "Sign in to ChatGPT in Scient Agent or Codex to dictate with ChatGPT.";
      case "invalid-audio":
        return "ChatGPT couldn't hear any speech in that recording.";
      case "rate-limited":
        return "ChatGPT is limiting dictation right now. Try again in a moment.";
      case "unavailable":
        return "ChatGPT dictation isn't responding. Try again.";
      case "update-required":
        return "Update Scient Agent to dictate with ChatGPT.";
      case "agent-unavailable":
        return "The provider signed in to ChatGPT couldn't run to dictate. Try again.";
    }
  }
}

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_CHATGPT_DICTATION_WS_METHODS = {
  voiceDictate: "voice.dictate",
  voiceCloudChoices: "voice.cloudChoices",
  voiceSavedKeys: "voice.savedKeys",
  voiceConfigureCloud: "voice.configureCloud",
  voiceChooseCloud: "voice.chooseCloud",
  voiceDictationWait: "voice.dictationWait",
  voiceDictateWithChatGpt: "voice.dictateWithChatGpt",
} as const;

export const WsVoiceDictateWithChatGptRpc = Rpc.make(
  SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceDictateWithChatGpt,
  {
    payload: ChatGptDictationInput,
    success: Schema.Struct({ text: Schema.String }),
    error: Schema.Union([ChatGptDictationError, EnvironmentAuthorizationError]),
  },
);

export const DictationSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), modelId: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("cloud"), engineId: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("chatgpt"), instanceId: ProviderInstanceId }),
]);

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  reason: Schema.Literals([
    "invalid-audio",
    "model-not-found",
    "unsupported-language",
    "consent-required",
    "key-rejected",
    "rate-limited",
    "local-unavailable",
    "cloud-unavailable",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-audio":
        return "The recording is not a valid dictation clip.";
      case "model-not-found":
        return "Install the selected speech model before dictating.";
      case "unsupported-language":
        return "The selected speech model does not support this language.";
      case "consent-required":
        return "Allow audio uploads for this cloud engine before dictating.";
      case "key-rejected":
        return "The speech provider rejected the account key.";
      case "rate-limited":
        return "The speech provider is limiting requests. Try again shortly.";
      case "local-unavailable":
        return "Local speech transcription is unavailable.";
      case "cloud-unavailable":
        return "The selected cloud speech engine is unavailable.";
    }
  }
}

const DictationInput = Schema.Struct({
  audioBase64: ChatGptDictationInput.fields.audioBase64,
  ...voiceLanguageRequestSchemaFields,
  selection: DictationSelection,
  hints: Schema.optionalKey(DictationRecognitionHints),
  silenceFiltering: Schema.optionalKey(Schema.Boolean),
  removeFillerWords: Schema.optionalKey(Schema.Boolean),
});
export type DictationInput = typeof DictationInput.Type;

export const WsVoiceDictateRpc = Rpc.make(SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceDictate, {
  payload: DictationInput,
  success: Schema.Struct({ text: Schema.String }),
  error: Schema.Union([DictationError, ChatGptDictationError, EnvironmentAuthorizationError]),
});

export const WsVoiceDictationWaitRpc = Rpc.make(
  SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceDictationWait,
  {
    success: Schema.Struct({ waiting: Schema.Boolean }),
    error: EnvironmentAuthorizationError,
  },
);

const cloudDictationBindingFields = {
  id: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
};
const CloudDictationChoice = Schema.Struct({
  ...cloudDictationBindingFields,
  model: Schema.String,
  migrated: Schema.optionalKey(Schema.Boolean),
  reconnect: Schema.optionalKey(Schema.Boolean),
  needsModel: Schema.optionalKey(Schema.Boolean),
  uploadConsent: Schema.optionalKey(Schema.Boolean),
  provider: Schema.optionalKey(Schema.Literals(["compatible", "openai", "xai", "openrouter"])),
  baseUrl: Schema.optionalKey(Schema.String),
  keyLabel: Schema.optionalKey(Schema.String),
  customModelConnectionId: Schema.optionalKey(Schema.String),
});
export type CloudDictationChoice = typeof CloudDictationChoice.Type;

export const WsVoiceCloudChoicesRpc = Rpc.make(
  SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceCloudChoices,
  {
    success: Schema.Array(CloudDictationChoice),
    error: Schema.Union([DictationError, EnvironmentAuthorizationError]),
  },
);

export const WsVoiceChooseCloudRpc = Rpc.make(
  SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceChooseCloud,
  {
    payload: Schema.Struct(cloudDictationBindingFields),
    success: Schema.Void,
    error: Schema.Union([DictationError, EnvironmentAuthorizationError]),
  },
);

export const CloudEngineBindingFields = {
  provider: Schema.Literals(["compatible", "openai", "xai", "openrouter"]),
  model: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/)),
  accountId: Schema.optionalKey(AccountId),
  customModelConnectionId: Schema.optionalKey(TrimmedNonEmptyString),
  baseUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
};

const SpeechKeyCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  kind: Schema.Literals(["account", "custom-model"]),
  hint: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4))),
});
export type SpeechKeyCandidate = typeof SpeechKeyCandidate.Type;

export const WsVoiceSavedKeysRpc = Rpc.make(SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceSavedKeys, {
  payload: Schema.Struct({ origin: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)) }),
  success: Schema.Array(SpeechKeyCandidate),
  error: Schema.Union([DictationError, EnvironmentAuthorizationError]),
});

export const WsVoiceConfigureCloudRpc = Rpc.make(
  SCIENT_CHATGPT_DICTATION_WS_METHODS.voiceConfigureCloud,
  {
    payload: Schema.Union([
      Schema.Struct({ action: Schema.Literal("add"), ...CloudEngineBindingFields }),
      Schema.Struct({
        action: Schema.Literal("update"),
        id: TrimmedNonEmptyString,
        ...CloudEngineBindingFields,
      }),
      Schema.Struct({
        action: Schema.Literals(["test", "remove"]),
        id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
      }),
    ]),
    success: Schema.Void,
    error: Schema.Union([DictationError, EnvironmentAuthorizationError]),
  },
);
