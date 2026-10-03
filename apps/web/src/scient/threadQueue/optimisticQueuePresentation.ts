import type { ScientThreadQueueItem } from "@t3tools/contracts";

import type { ChatMessage, SessionPhase } from "../../types";

export type OptimisticUserMessage = ChatMessage & {
  readonly queueAdmission?: {
    readonly threadKey: string;
    readonly accepted: boolean;
  };
};

export function shouldPreviewQueueAdmission(input: {
  readonly ordinaryServerSend: boolean;
  readonly phase: SessionPhase;
  readonly hasWaitingItems: boolean;
  readonly awaitingCompletion: boolean;
}) {
  return (
    input.ordinaryServerSend &&
    (input.phase === "running" ||
      input.phase === "connecting" ||
      (input.hasWaitingItems && !input.awaitingCompletion))
  );
}

/** The receipt chooses the final surface; predicting queue placement never admits work. */
export function settleQueueAdmissionPreview(
  messages: OptimisticUserMessage[],
  messageId: string,
  queued: boolean,
): OptimisticUserMessage[] {
  if (!messages.some((message) => message.id === messageId && (queued || message.queueAdmission)))
    return messages;
  return messages.flatMap((message) => {
    if (message.id !== messageId) return [message];
    if (queued) {
      return message.queueAdmission
        ? [{ ...message, queueAdmission: { ...message.queueAdmission, accepted: true } }]
        : [];
    }
    const { queueAdmission: _queueAdmission, ...sentMessage } = message;
    return [sentMessage];
  });
}

/** Hide duplicates immediately, even when the stream beats the command response. */
export function pendingQueueAdmissionPreviews(
  messages: ReadonlyArray<OptimisticUserMessage>,
  threadKey: string,
  items: ReadonlyArray<ScientThreadQueueItem>,
  serverMessages: ReadonlyArray<ChatMessage>,
) {
  const pending = messages.filter((message) => message.queueAdmission?.threadKey === threadKey);
  if (pending.length === 0) return pending;
  const knownIds = new Set([
    ...items.flatMap((item) => (item.messageId ? [item.messageId] : [])),
    ...serverMessages.map((message) => message.id),
  ]);
  return pending.filter((message) => !knownIds.has(message.id));
}
