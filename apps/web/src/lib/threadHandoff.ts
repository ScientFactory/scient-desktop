// FILE: threadHandoff.ts
// Purpose: Builds client-side handoff commands and imported transcript payloads.
// Layer: Web handoff utilities
// Exports: target-provider, title, transcript, and model-selection helpers.

import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
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
): ReadonlyArray<ThreadHandoffImportedMessage> {
  return messages
    .filter(
      (message): message is Thread["messages"][number] & { role: "user" | "assistant" } =>
        isImportable(message) && (message.role === "user" || message.role === "assistant"),
    )
    .map((message) => {
      const importedText =
        message.role === "user" ? stripEmbeddedAssistantSelections(message.text) : message.text;
      const importedMessage: ThreadHandoffImportedMessage = {
        messageId: MessageId.makeUnsafe(randomUUID()),
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
): ReadonlyArray<ThreadHandoffImportedMessage> {
  const sourceMessageIndex = thread.messages.findIndex((message) => message.id === sourceMessageId);
  const sourceMessage = thread.messages[sourceMessageIndex];
  const isForkImportable = (message: Thread["messages"][number]) =>
    isImportableThreadMessage(message) || isSettledTerminalTurnAssistantMessage(thread, message);
  if (sourceMessageIndex < 0 || !sourceMessage || !isForkImportable(sourceMessage)) {
    return [];
  }

  return buildImportedMessages(thread.messages.slice(0, sourceMessageIndex + 1), isForkImportable);
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
