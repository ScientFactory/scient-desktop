// FILE: threadHandoff.ts
// Purpose: Builds client-side handoff commands and imported transcript payloads.
// Layer: Web handoff utilities
// Exports: target-provider, title, transcript, and model-selection helpers.

import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { compareProjectionMessageOrderValues } from "@synara/shared/messageOrder";
import { getDefaultModel } from "@synara/shared/model";
import { isLatestTurnSettled } from "../session-logic";
import { type Thread } from "../types";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { randomUUID } from "./utils";

const HANDOFF_PROVIDER_ORDER: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
];
const IMPORTABLE_THREAD_ACTIVITY_KINDS = new Set([
  "account.rate-limits.updated",
  "account.rate-limited",
  "context-window.updated",
  "context-window.configured",
]);

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

type ForkSourceThread = Pick<Thread, "messages"> & Partial<Pick<Thread, "latestTurn" | "session">>;

function inProjectionMessageOrder(thread: ForkSourceThread): ForkSourceThread {
  return {
    ...thread,
    messages: thread.messages.toSorted((left, right) =>
      compareProjectionMessageOrderValues(left.createdAt, left.id, right.createdAt, right.id),
    ),
  };
}

function resolveRunningTurnBoundaryIndex(thread: ForkSourceThread): number | null {
  if (!thread.latestTurn || isLatestTurnSettled(thread.latestTurn, thread.session ?? null)) {
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

  return 0;
}

function isSettledTerminalTurnAssistantMessage(
  thread: ForkSourceThread,
  message: Thread["messages"][number],
): message is Thread["messages"][number] & { role: "assistant" } {
  return (
    message.role === "assistant" &&
    message.streaming === true &&
    message.turnId != null &&
    thread.latestTurn?.turnId === message.turnId &&
    isLatestTurnSettled(thread.latestTurn, thread.session ?? null)
  );
}

function isForkImportableThreadMessage(
  thread: ForkSourceThread,
  message: Thread["messages"][number],
): message is Thread["messages"][number] & { role: "user" | "assistant" } {
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }
  if (
    message.role === "assistant" &&
    message.turnId != null &&
    thread.latestTurn?.turnId === message.turnId &&
    !isLatestTurnSettled(thread.latestTurn, thread.session ?? null)
  ) {
    return false;
  }
  return (
    isImportableThreadMessage(message) || isSettledTerminalTurnAssistantMessage(thread, message)
  );
}

function isImportableThreadActivity(
  activity: Thread["activities"][number],
): activity is OrchestrationThreadActivity {
  return IMPORTABLE_THREAD_ACTIVITY_KINDS.has(activity.kind);
}

export function resolveAvailableHandoffTargetProviders(
  sourceProvider: ProviderKind,
): ReadonlyArray<ProviderKind> {
  return HANDOFF_PROVIDER_ORDER.filter((provider) => provider !== sourceProvider);
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Handoff from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
}

// Preserve the visible source thread name when creating the destination thread.
export function resolveThreadHandoffTitle(thread: Pick<Thread, "title">): string {
  const title = thread.title.trim().replace(/\s+/g, " ");
  return title.length > 0 ? title : "Handoff";
}

export function buildThreadHandoffImportedMessages(
  thread: Pick<Thread, "messages">,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  return buildImportedMessages(thread.messages);
}

function buildImportedMessages(
  messages: ReadonlyArray<Thread["messages"][number]>,
  isImportable: (message: Thread["messages"][number]) => boolean = isImportableThreadMessage,
  makeMessageId: (index: number) => MessageId = () => MessageId.makeUnsafe(randomUUID()),
): ReadonlyArray<ThreadHandoffImportedMessage> {
  return messages
    .filter(
      (message): message is Thread["messages"][number] & { role: "user" | "assistant" } =>
        isImportable(message) && (message.role === "user" || message.role === "assistant"),
    )
    .map((message, index) => {
      const importedText =
        message.role === "user" ? stripEmbeddedAssistantSelections(message.text) : message.text;
      const importedMessage: ThreadHandoffImportedMessage = {
        messageId: makeMessageId(index),
        role: message.role,
        text: importedText,
        createdAt: message.createdAt,
        updatedAt: message.completedAt ?? message.createdAt,
      };
      const attachments =
        message.attachments && message.attachments.length > 0
          ? message.attachments.map((attachment) =>
              attachment.type === "assistant-selection"
                ? {
                    type: attachment.type,
                    id: attachment.id,
                    assistantMessageId: attachment.assistantMessageId,
                    text: attachment.text,
                  }
                : {
                    type: attachment.type,
                    id: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  },
            )
          : null;
      return attachments ? Object.assign(importedMessage, { attachments }) : importedMessage;
    });
}

export function buildThreadForkImportedMessagesThrough(
  thread: ForkSourceThread,
  sourceMessageId: MessageId,
  destinationThreadId: ThreadId,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  const orderedThread = inProjectionMessageOrder(thread);
  const sourceMessageIndex = orderedThread.messages.findIndex(
    (message) => message.id === sourceMessageId,
  );
  const sourceMessage = orderedThread.messages[sourceMessageIndex];
  const runningTurnBoundaryIndex = resolveRunningTurnBoundaryIndex(orderedThread);
  if (
    sourceMessageIndex < 0 ||
    !sourceMessage ||
    (runningTurnBoundaryIndex !== null && sourceMessageIndex >= runningTurnBoundaryIndex)
  ) {
    return [];
  }

  const conversationPrefix = orderedThread.messages
    .slice(0, sourceMessageIndex + 1)
    .filter((message) => message.role === "user" || message.role === "assistant");
  if (
    conversationPrefix.length === 0 ||
    conversationPrefix.some((message) => !isForkImportableThreadMessage(orderedThread, message)) ||
    conversationPrefix.some((message, index, messages) => {
      const previous = messages[index - 1];
      return previous !== undefined && previous.createdAt > message.createdAt;
    })
  ) {
    return [];
  }

  return buildImportedMessages(
    conversationPrefix,
    (message) => isForkImportableThreadMessage(orderedThread, message),
    (index) =>
      MessageId.makeUnsafe(
        `fork:${destinationThreadId}:${String(index).padStart(8, "0")}:${randomUUID()}`,
      ),
  );
}

/**
 * Message actions are offered only while the entire conversation prefix is safe
 * to import. Once a live assistant row appears, that row and every later user
 * or assistant boundary stay hidden until the lifecycle settles.
 */
export function resolveThreadForkableMessageIds(thread: ForkSourceThread): ReadonlySet<MessageId> {
  const orderedThread = inProjectionMessageOrder(thread);
  const forkableMessageIds = new Set<MessageId>();
  let prefixIsImportable = true;
  const runningTurnBoundaryIndex = resolveRunningTurnBoundaryIndex(orderedThread);

  for (const [messageIndex, message] of orderedThread.messages.entries()) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    prefixIsImportable =
      prefixIsImportable &&
      (runningTurnBoundaryIndex === null || messageIndex < runningTurnBoundaryIndex) &&
      isForkImportableThreadMessage(orderedThread, message);
    if (prefixIsImportable) {
      forkableMessageIds.add(message.id);
    }
  }

  return forkableMessageIds;
}

export function buildThreadHandoffImportedActivities(
  thread: Pick<Thread, "activities">,
): ReadonlyArray<OrchestrationThreadActivity> {
  return thread.activities.filter(isImportableThreadActivity).map((activity) => {
    const { sequence: _sequence, ...rest } = activity;
    return {
      ...rest,
      id: EventId.makeUnsafe(randomUUID()),
    };
  });
}

// Used by: ChatView fork command gating.
export function hasTransferableThreadMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(isImportableThreadMessage);
}

export function hasNativeThreadHandoffMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(
    (message) => isImportableThreadMessage(message) && message.source === "native",
  );
}

export function canCreateThreadHandoff(input: {
  readonly thread: Pick<Thread, "handoff" | "messages" | "session">;
  readonly isBusy?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  if (input.isBusy || input.hasPendingApprovals || input.hasPendingUserInput) {
    return false;
  }
  const sessionStatus = input.thread.session?.orchestrationStatus;
  if (sessionStatus === "starting" || sessionStatus === "running") {
    return false;
  }
  const importedMessages = buildThreadHandoffImportedMessages(input.thread);
  if (importedMessages.length === 0) {
    return false;
  }
  if (input.thread.handoff !== null) {
    return hasNativeThreadHandoffMessages(input.thread);
  }
  return true;
}

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "modelSelection">;
  readonly targetProvider: ProviderKind;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
}): ModelSelection {
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    if (!selection || selection.provider !== input.targetProvider) {
      return false;
    }
    return input.targetProvider !== "kilo" || selection.model.startsWith("kilo/");
  };

  const stickySelection = input.stickyModelSelectionByProvider[input.targetProvider];
  if (isCompatibleSelection(stickySelection)) {
    return stickySelection;
  }
  if (isCompatibleSelection(input.projectDefaultModelSelection)) {
    return input.projectDefaultModelSelection;
  }
  const defaultModel = getDefaultModel(input.targetProvider);
  if (!defaultModel) {
    throw new Error("Select a Pi model before handing off to Pi.");
  }
  return {
    provider: input.targetProvider,
    model: defaultModel,
  };
}
