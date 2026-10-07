import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { useCallback } from "react";

/** Queue-owned future messages are not conversation history. */
export function hasCommittedConversationMessages(input: {
  readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "runId">>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
  readonly items: ReadonlyArray<Pick<OrchestrationV2TurnItem, "type" | "runId">>;
}): boolean {
  const queuedRunIds = new Set(
    input.runs.filter((run) => run.status === "queued").map((run) => run.id),
  );
  return (
    input.messages.some((message) => message.runId === null || !queuedRunIds.has(message.runId)) ||
    input.items.some(
      (item) =>
        (item.type === "user_message" || item.type === "assistant_message") &&
        (item.runId === null || !queuedRunIds.has(item.runId)),
    )
  );
}

/** Existing conversation forks preserve the ordinary composer draft. */
export function useComposerModelPickerFork(input: {
  readonly hasConversationMessages: boolean;
  readonly onForkConversation: (options?: { readonly preserveComposerDraft?: boolean }) => void;
}): (() => void) | undefined {
  const { onForkConversation } = input;
  const continueInNewChat = useCallback(() => {
    onForkConversation({ preserveComposerDraft: true });
  }, [onForkConversation]);
  return input.hasConversationMessages ? continueInNewChat : undefined;
}
