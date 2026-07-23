// FILE: messageFork.ts
// Purpose: Validate server-authoritative message boundaries and imported fork prefixes.
// Layer: Server orchestration domain logic

import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessage,
  OrchestrationThread,
  ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { stripEmbeddedAssistantSelections } from "@synara/shared/assistantSelections";
import { compareProjectionMessageOrderValues } from "@synara/shared/messageOrder";

import { isAssistantTurnTerminal } from "./assistantMessageLifecycle.ts";

export type MessageForkValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "invalid-source" | "import-mismatch";
      readonly expectedImportedMessageCount: number;
    };

export interface ImportedMessageIdValidation {
  readonly ok: boolean;
  readonly conflictingMessageId: MessageId | null;
}

type MessageForkSourceThread = Pick<OrchestrationThread, "messages" | "latestTurn">;

// The renderer intentionally retains only the newest 2,000 message rows. Fork
// validation loads uncapped persistence so it can derive that same authoritative
// window instead of requiring a prefix the production client cannot construct.
const MESSAGE_FORK_SOURCE_WINDOW_MAX_MESSAGES = 2_000;

function resolveRunningTurnBoundaryIndex(thread: MessageForkSourceThread): number | null {
  if (thread.latestTurn?.state !== "running") {
    return null;
  }

  const activeAssistantIndex = thread.messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === thread.latestTurn?.turnId,
  );
  const requestedUserIndex = thread.messages.findIndex(
    (message) => message.role === "user" && message.createdAt === thread.latestTurn?.requestedAt,
  );

  const knownUnsafeIndexes = [
    ...(activeAssistantIndex >= 0 ? [activeAssistantIndex] : []),
    ...(requestedUserIndex >= 0 ? [requestedUserIndex + 1] : []),
  ];
  if (knownUnsafeIndexes.length > 0) {
    return Math.min(...knownUnsafeIndexes);
  }

  // A running turn without a projected prompt or assistant is an incomplete
  // lifecycle snapshot. Fail closed until the authoritative boundary appears.
  return 0;
}

function isCompletedConversationMessage(
  thread: MessageForkSourceThread,
  message: OrchestrationMessage,
  messageIndex: number,
  runningTurnBoundaryIndex: number | null,
): message is OrchestrationMessage & { readonly role: "user" | "assistant" } {
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }
  if (runningTurnBoundaryIndex !== null && messageIndex >= runningTurnBoundaryIndex) {
    return false;
  }
  if (
    message.role === "assistant" &&
    message.turnId != null &&
    thread.latestTurn?.turnId === message.turnId &&
    thread.latestTurn.state === "running"
  ) {
    return false;
  }
  if (!message.streaming) {
    return true;
  }
  return message.role === "assistant" && isAssistantTurnTerminal(thread, message.turnId);
}

function attachmentsEqual(
  left: ReadonlyArray<ChatAttachment> | undefined,
  right: ReadonlyArray<ChatAttachment> | undefined,
): boolean {
  const leftAttachments = left ?? [];
  const rightAttachments = right ?? [];
  if (leftAttachments.length !== rightAttachments.length) {
    return false;
  }

  return leftAttachments.every((leftAttachment, index) => {
    const rightAttachment = rightAttachments[index];
    if (
      !rightAttachment ||
      leftAttachment.type !== rightAttachment.type ||
      leftAttachment.id !== rightAttachment.id
    ) {
      return false;
    }
    if (
      leftAttachment.type === "assistant-selection" &&
      rightAttachment.type === "assistant-selection"
    ) {
      return (
        leftAttachment.assistantMessageId === rightAttachment.assistantMessageId &&
        leftAttachment.text === rightAttachment.text
      );
    }
    if (
      leftAttachment.type === "assistant-selection" ||
      rightAttachment.type === "assistant-selection"
    ) {
      return false;
    }
    return (
      leftAttachment.name === rightAttachment.name &&
      leftAttachment.mimeType === rightAttachment.mimeType &&
      leftAttachment.sizeBytes === rightAttachment.sizeBytes
    );
  });
}

function importedMessageMatchesSource(
  importedMessage: ThreadHandoffImportedMessage,
  sourceMessage: OrchestrationMessage & { readonly role: "user" | "assistant" },
): boolean {
  const expectedText =
    sourceMessage.role === "user"
      ? stripEmbeddedAssistantSelections(sourceMessage.text)
      : sourceMessage.text;
  return (
    importedMessage.role === sourceMessage.role &&
    importedMessage.text === expectedText &&
    importedMessage.createdAt === sourceMessage.createdAt &&
    attachmentsEqual(importedMessage.attachments, sourceMessage.attachments)
  );
}

export function validateMessageForkImport(input: {
  readonly sourceThread: MessageForkSourceThread;
  readonly sourceMessageId: MessageId;
  readonly importedMessages: ReadonlyArray<ThreadHandoffImportedMessage>;
}): MessageForkValidation {
  const runningTurnBoundaryIndex = resolveRunningTurnBoundaryIndex(input.sourceThread);
  const sourceMessageIndex = input.sourceThread.messages.findIndex(
    (message) => message.id === input.sourceMessageId,
  );
  const sourceMessage = input.sourceThread.messages[sourceMessageIndex];
  if (
    sourceMessageIndex < 0 ||
    !sourceMessage ||
    sourceMessageIndex <
      Math.max(0, input.sourceThread.messages.length - MESSAGE_FORK_SOURCE_WINDOW_MAX_MESSAGES) ||
    !isCompletedConversationMessage(
      input.sourceThread,
      sourceMessage,
      sourceMessageIndex,
      runningTurnBoundaryIndex,
    )
  ) {
    return {
      ok: false,
      reason: "invalid-source",
      expectedImportedMessageCount: 0,
    };
  }

  const sourceWindowStartIndex = Math.max(
    0,
    input.sourceThread.messages.length - MESSAGE_FORK_SOURCE_WINDOW_MAX_MESSAGES,
  );
  const conversationPrefix = input.sourceThread.messages
    .slice(sourceWindowStartIndex, sourceMessageIndex + 1)
    .filter(
      (message): message is OrchestrationMessage & { readonly role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    );
  if (
    conversationPrefix.some((message) => {
      const messageIndex = input.sourceThread.messages.indexOf(message);
      return !isCompletedConversationMessage(
        input.sourceThread,
        message,
        messageIndex,
        runningTurnBoundaryIndex,
      );
    })
  ) {
    return {
      ok: false,
      reason: "invalid-source",
      expectedImportedMessageCount: 0,
    };
  }

  const importOrderIsPersistent = input.importedMessages.every((message, index, messages) => {
    const previous = messages[index - 1];
    if (!previous) {
      return true;
    }
    return (
      compareProjectionMessageOrderValues(
        previous.createdAt,
        previous.messageId,
        message.createdAt,
        message.messageId,
      ) < 0
    );
  });
  if (!importOrderIsPersistent) {
    return {
      ok: false,
      reason: "import-mismatch",
      expectedImportedMessageCount: conversationPrefix.length,
    };
  }

  const expectedMessages = conversationPrefix;
  const importedMessagesMatch =
    input.importedMessages.length === expectedMessages.length &&
    input.importedMessages.every((message, index) => {
      const expectedMessage = expectedMessages[index];
      return expectedMessage ? importedMessageMatchesSource(message, expectedMessage) : false;
    });
  return importedMessagesMatch
    ? { ok: true }
    : {
        ok: false,
        reason: "import-mismatch",
        expectedImportedMessageCount: expectedMessages.length,
      };
}

/**
 * Imported transcript rows must never reuse a projected message id. Projection message ids are
 * globally keyed, so accepting a duplicate would either collapse the imported prefix or reassign
 * an existing source row to the destination thread.
 */
export function validateImportedMessageIds(input: {
  readonly importedMessages: ReadonlyArray<ThreadHandoffImportedMessage>;
  readonly existingMessageIds: ReadonlySet<MessageId>;
}): ImportedMessageIdValidation {
  const importedMessageIds = new Set<MessageId>();
  for (const message of input.importedMessages) {
    if (
      importedMessageIds.has(message.messageId) ||
      input.existingMessageIds.has(message.messageId)
    ) {
      return {
        ok: false,
        conflictingMessageId: message.messageId,
      };
    }
    importedMessageIds.add(message.messageId);
  }
  return { ok: true, conflictingMessageId: null };
}
