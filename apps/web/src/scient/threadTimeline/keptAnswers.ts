import { isSubstantiveAnswer } from "@scientfactory/conversation/answer-visibility";

import { type ChatMessage, isImageAttachment } from "~/types";

// Message objects are reused across timeline derivations, so each is read once.
const verdicts = new WeakMap<ChatMessage, boolean>();

/**
 * A finished assistant message that reads as a real answer stays visible when
 * its turn folds behind "Worked for…", and carries the answer's copy row; short
 * progress notes fold with the work. The turn's last answer is unaffected.
 */
export function keepsSettledAnswerVisible(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.streaming) return false;
  let verdict = verdicts.get(message);
  if (verdict === undefined) {
    verdict = isSubstantiveAnswer(message.text, {
      hasImages: (message.attachments ?? []).some(isImageAttachment),
    });
    verdicts.set(message, verdict);
  }
  return verdict;
}
