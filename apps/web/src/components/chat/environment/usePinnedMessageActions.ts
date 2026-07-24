// FILE: usePinnedMessageActions.ts
// Purpose: Centralize sidepanel pin and notes command dispatch with optimistic rollback guards.
// Layer: Environment panel hook
// Exports: usePinnedMessageActions

import {
  PINNED_MESSAGES_MAX_COUNT,
  type MessageId,
  type PinnedMessage,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { activityManager } from "~/notifications/activityStore";
import {
  addPin,
  dispatchPinnedMessageAdd,
  dispatchPinnedMessageDoneSet,
  dispatchPinnedMessageLabelSet,
  dispatchPinnedMessageRemove,
  dispatchThreadNotes,
  isMessagePinned,
  normalizePinLabel,
  removePin,
  restorePinAtIndex,
  setPinDone,
  setPinLabel,
  togglePinDone,
} from "~/pinnedMessages";

interface UsePinnedMessageActionsInput {
  readonly activeThreadId: ThreadId | null;
  readonly pinnedMessages: readonly PinnedMessage[];
}

interface UsePinnedMessageActionsResult {
  readonly pinLimitMessageId: MessageId | null;
  readonly handleTogglePinMessage: (messageId: MessageId) => void;
  readonly handleTogglePinnedMessageDone: (messageId: MessageId) => void;
  readonly handleUnpinMessage: (messageId: MessageId) => void;
  readonly handleRenamePinnedMessage: (messageId: MessageId, label: string | null) => void;
  readonly handleNotesChange: (threadId: ThreadId, notes: string) => Promise<void>;
}

function matchesPinState(pin: PinnedMessage | undefined, expected: PinnedMessage): boolean {
  return (
    pin !== undefined &&
    pin.messageId === expected.messageId &&
    (pin.label ?? null) === (expected.label ?? null) &&
    pin.done === expected.done &&
    pin.pinnedAt === expected.pinnedAt
  );
}

function pinnedMessageActivityKey(threadId: ThreadId, messageId: MessageId): string {
  return `thread:${threadId}:pinned-message:${messageId}`;
}

function threadNotesActivityKey(threadId: ThreadId): string {
  return `thread:${threadId}:notes`;
}

// Keeps rapid pin clicks based on the latest optimistic ref until server events reconcile the store.
export function usePinnedMessageActions({
  activeThreadId,
  pinnedMessages,
}: UsePinnedMessageActionsInput): UsePinnedMessageActionsResult {
  const pinnedMessagesRef = useRef<readonly PinnedMessage[]>(pinnedMessages);
  const activePinnedThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  const activityOperationVersionRef = useRef(new Map<string, number>());
  const [pinLimitMessageId, setPinLimitMessageId] = useState<MessageId | null>(null);

  useEffect(() => {
    pinnedMessagesRef.current = pinnedMessages;
    activePinnedThreadIdRef.current = activeThreadId;
  }, [activeThreadId, pinnedMessages]);

  useEffect(() => {
    setPinLimitMessageId(null);
  }, [activeThreadId]);

  useEffect(() => {
    if (!pinLimitMessageId) return;
    const timeoutId = window.setTimeout(() => setPinLimitMessageId(null), 4_000);
    return () => window.clearTimeout(timeoutId);
  }, [pinLimitMessageId]);

  const beginActivityOperation = useCallback((key: string): number => {
    const version = (activityOperationVersionRef.current.get(key) ?? 0) + 1;
    activityOperationVersionRef.current.set(key, version);
    return version;
  }, []);

  const clearActivityAfterLatestOperation = useCallback((key: string, version: number) => {
    if (activityOperationVersionRef.current.get(key) === version) {
      activityManager.remove(key);
    }
  }, []);

  const handlePinnedMessageDispatchError = useCallback(
    (threadId: ThreadId, messageId: MessageId, version: number, error: unknown) => {
      const dedupeKey = pinnedMessageActivityKey(threadId, messageId);
      if (activityOperationVersionRef.current.get(dedupeKey) !== version) return;
      activityManager.publish({
        dedupeKey,
        source: "thread",
        status: "needs_attention",
        tone: "error",
        title: "Pinned message change was not saved",
        description:
          error instanceof Error ? error.message : "The pinned message change could not be saved.",
        destination: { type: "thread", threadId },
      });
    },
    [],
  );

  const handleThreadNotesDispatchError = useCallback(
    (threadId: ThreadId, version: number, error: unknown) => {
      const dedupeKey = threadNotesActivityKey(threadId);
      if (activityOperationVersionRef.current.get(dedupeKey) !== version) return;
      activityManager.publish({
        dedupeKey,
        source: "thread",
        status: "needs_attention",
        tone: "error",
        title: "Thread notes were not saved",
        description: error instanceof Error ? error.message : "The note change could not be saved.",
        destination: { type: "thread", threadId },
      });
    },
    [],
  );

  const handleTogglePinMessage = useCallback(
    (messageId: MessageId) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const pins = pinnedMessagesRef.current;
      if (isMessagePinned(pins, messageId)) {
        setPinLimitMessageId(null);
        const removedPinIndex = pins.findIndex((pin) => pin.messageId === messageId);
        const removedPin = removedPinIndex >= 0 ? pins[removedPinIndex] : undefined;
        const activityKey = pinnedMessageActivityKey(threadId, messageId);
        const operationVersion = beginActivityOperation(activityKey);
        pinnedMessagesRef.current = removePin(pins, messageId);
        void dispatchPinnedMessageRemove(threadId, messageId)
          .then(() => clearActivityAfterLatestOperation(activityKey, operationVersion))
          .catch((error) => {
            if (
              removedPin &&
              activityOperationVersionRef.current.get(activityKey) === operationVersion
            ) {
              pinnedMessagesRef.current = restorePinAtIndex(
                pinnedMessagesRef.current,
                removedPin,
                removedPinIndex,
              );
            }
            handlePinnedMessageDispatchError(threadId, messageId, operationVersion, error);
          });
        return;
      }
      if (pins.length >= PINNED_MESSAGES_MAX_COUNT) {
        setPinLimitMessageId(messageId);
        return;
      }
      setPinLimitMessageId(null);
      const pinnedAt = new Date().toISOString();
      const optimisticPin = { messageId, label: null, done: false, pinnedAt };
      const activityKey = pinnedMessageActivityKey(threadId, messageId);
      const operationVersion = beginActivityOperation(activityKey);
      pinnedMessagesRef.current = addPin(pins, messageId, pinnedAt);
      void dispatchPinnedMessageAdd(threadId, messageId)
        .then(() => clearActivityAfterLatestOperation(activityKey, operationVersion))
        .catch((error) => {
          const currentPin = pinnedMessagesRef.current.find(
            (candidate) => candidate.messageId === messageId,
          );
          if (matchesPinState(currentPin, optimisticPin)) {
            pinnedMessagesRef.current = removePin(pinnedMessagesRef.current, messageId);
          }
          handlePinnedMessageDispatchError(threadId, messageId, operationVersion, error);
        });
    },
    [beginActivityOperation, clearActivityAfterLatestOperation, handlePinnedMessageDispatchError],
  );

  const handleTogglePinnedMessageDone = useCallback(
    (messageId: MessageId) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const pin = pinnedMessagesRef.current.find((candidate) => candidate.messageId === messageId);
      if (!pin) {
        return;
      }
      const previousDone = pin.done === true;
      const done = !previousDone;
      const activityKey = pinnedMessageActivityKey(threadId, messageId);
      const operationVersion = beginActivityOperation(activityKey);
      pinnedMessagesRef.current = togglePinDone(pinnedMessagesRef.current, messageId);
      void dispatchPinnedMessageDoneSet(threadId, messageId, done)
        .then(() => clearActivityAfterLatestOperation(activityKey, operationVersion))
        .catch((error) => {
          const currentPin = pinnedMessagesRef.current.find(
            (candidate) => candidate.messageId === messageId,
          );
          if (currentPin?.done === done) {
            pinnedMessagesRef.current = setPinDone(
              pinnedMessagesRef.current,
              messageId,
              previousDone,
            );
          }
          handlePinnedMessageDispatchError(threadId, messageId, operationVersion, error);
        });
    },
    [beginActivityOperation, clearActivityAfterLatestOperation, handlePinnedMessageDispatchError],
  );

  const handleUnpinMessage = useCallback(
    (messageId: MessageId) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const removedPinIndex = pinnedMessagesRef.current.findIndex(
        (candidate) => candidate.messageId === messageId,
      );
      const removedPin =
        removedPinIndex >= 0 ? pinnedMessagesRef.current[removedPinIndex] : undefined;
      if (!removedPin) {
        return;
      }
      const activityKey = pinnedMessageActivityKey(threadId, messageId);
      const operationVersion = beginActivityOperation(activityKey);
      pinnedMessagesRef.current = removePin(pinnedMessagesRef.current, messageId);
      void dispatchPinnedMessageRemove(threadId, messageId)
        .then(() => clearActivityAfterLatestOperation(activityKey, operationVersion))
        .catch((error) => {
          if (activityOperationVersionRef.current.get(activityKey) === operationVersion) {
            pinnedMessagesRef.current = restorePinAtIndex(
              pinnedMessagesRef.current,
              removedPin,
              removedPinIndex,
            );
          }
          handlePinnedMessageDispatchError(threadId, messageId, operationVersion, error);
        });
    },
    [beginActivityOperation, clearActivityAfterLatestOperation, handlePinnedMessageDispatchError],
  );

  const handleRenamePinnedMessage = useCallback(
    (messageId: MessageId, label: string | null) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const previousPin = pinnedMessagesRef.current.find(
        (candidate) => candidate.messageId === messageId,
      );
      const previousLabel = previousPin?.label ?? null;
      const nextLabel = normalizePinLabel(label);
      const activityKey = pinnedMessageActivityKey(threadId, messageId);
      const operationVersion = beginActivityOperation(activityKey);
      pinnedMessagesRef.current = setPinLabel(pinnedMessagesRef.current, messageId, label);
      void dispatchPinnedMessageLabelSet(threadId, messageId, label)
        .then(() => clearActivityAfterLatestOperation(activityKey, operationVersion))
        .catch((error) => {
          const currentPin = pinnedMessagesRef.current.find(
            (candidate) => candidate.messageId === messageId,
          );
          if ((currentPin?.label ?? null) === nextLabel) {
            pinnedMessagesRef.current = setPinLabel(
              pinnedMessagesRef.current,
              messageId,
              previousLabel,
            );
          }
          handlePinnedMessageDispatchError(threadId, messageId, operationVersion, error);
        });
    },
    [beginActivityOperation, clearActivityAfterLatestOperation, handlePinnedMessageDispatchError],
  );

  const handleNotesChange = useCallback(
    async (threadId: ThreadId, notes: string) => {
      const activityKey = threadNotesActivityKey(threadId);
      const operationVersion = beginActivityOperation(activityKey);
      try {
        await dispatchThreadNotes(threadId, notes);
        clearActivityAfterLatestOperation(activityKey, operationVersion);
      } catch (error) {
        handleThreadNotesDispatchError(threadId, operationVersion, error);
        throw error;
      }
    },
    [beginActivityOperation, clearActivityAfterLatestOperation, handleThreadNotesDispatchError],
  );

  return {
    pinLimitMessageId,
    handleTogglePinMessage,
    handleTogglePinnedMessageDone,
    handleUnpinMessage,
    handleRenamePinnedMessage,
    handleNotesChange,
  };
}
