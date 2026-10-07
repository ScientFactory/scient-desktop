import type { UserInputAttachmentAnswerPayload } from "./providerPolicy.ts";

/** The ID of the user message chat folds into this submitted answer. */
export function questionAnswerMessageId(answer: UserInputAttachmentAnswerPayload): string {
  return answer.messageId ?? `async-answer:${answer.requestId}`;
}
