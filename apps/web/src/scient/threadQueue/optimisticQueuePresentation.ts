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

/** Admission previews belong to the queue strip until the receipt selects ordinary delivery. */
export function optimisticTimelineMessages(messages: ReadonlyArray<OptimisticUserMessage>) {
  return messages.filter((message) => message.queueAdmission === undefined);
}
