import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { VOICE_AUDIO_BASE64_MAX_CHARS, VoiceTranscriptionLanguage } from "../voice.ts";

/**
 * Dictation with ChatGPT: a provider instance (Scient Agent or Codex) sends the recording to
 * ChatGPT's own transcription service with its ChatGPT sign-in, and returns the text.
 */
export const ChatGptDictationInput = Schema.Struct({
  /** The provider instance whose ChatGPT sign-in transcribes. */
  instanceId: ProviderInstanceId,
  /** A 16-bit mono WAV recording. */
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_AUDIO_BASE64_MAX_CHARS)),
  language: Schema.optionalKey(VoiceTranscriptionLanguage),
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
