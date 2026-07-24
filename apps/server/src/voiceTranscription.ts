// Compatibility facade. Application-level routing lives outside the ChatGPT adapter.
export {
  CHATGPT_TRANSCRIPTIONS_URL,
  createChatGptVoiceTranscriptionBackend,
  transcribeVoiceWithChatGptSession,
  type ChatGptVoiceAuthContext,
} from "./voice/chatGptVoiceTranscription.ts";
