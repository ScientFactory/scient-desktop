import type { MessageId, ThreadId } from "@synara/contracts";
import { create } from "zustand";

import { revokeUserMessagePreviewUrls } from "./components/ChatView.logic";
import type { ChatMessage } from "./types";

export type OwnedOptimisticUserMessage = ChatMessage & {
  ownerThreadId: ThreadId;
};

interface OptimisticUserMessageStoreState {
  messagesByThreadId: Partial<Record<ThreadId, OwnedOptimisticUserMessage[]>>;
  addMessage: (message: OwnedOptimisticUserMessage) => void;
  removeMessage: (
    ownerThreadId: ThreadId,
    messageId: MessageId,
    options?: { revokePreviews?: boolean },
  ) => OwnedOptimisticUserMessage | null;
  clearThread: (threadId: ThreadId) => void;
  clearAll: () => void;
}

export const useOptimisticUserMessageStore = create<OptimisticUserMessageStoreState>(
  (set, get) => ({
    messagesByThreadId: {},
    addMessage: (message) => {
      set((state) => {
        const existing = state.messagesByThreadId[message.ownerThreadId] ?? [];
        if (existing.some((candidate) => candidate.id === message.id)) {
          return state;
        }
        return {
          messagesByThreadId: {
            ...state.messagesByThreadId,
            [message.ownerThreadId]: [...existing, message],
          },
        };
      });
    },
    removeMessage: (ownerThreadId, messageId, options) => {
      let removed: OwnedOptimisticUserMessage | null = null;
      set((state) => {
        const existing = state.messagesByThreadId[ownerThreadId];
        if (!existing) return state;
        const next = existing.filter((message) => {
          if (message.id !== messageId) return true;
          removed = message;
          return false;
        });
        if (!removed) return state;
        const messagesByThreadId = { ...state.messagesByThreadId };
        if (next.length === 0) {
          delete messagesByThreadId[ownerThreadId];
        } else {
          messagesByThreadId[ownerThreadId] = next;
        }
        return { messagesByThreadId };
      });
      if (removed && options?.revokePreviews) {
        revokeUserMessagePreviewUrls(removed);
      }
      return removed;
    },
    clearThread: (threadId) => {
      const messages = get().messagesByThreadId[threadId];
      if (!messages) return;
      set((state) => {
        const messagesByThreadId = { ...state.messagesByThreadId };
        delete messagesByThreadId[threadId];
        return { messagesByThreadId };
      });
      for (const message of messages) {
        revokeUserMessagePreviewUrls(message);
      }
    },
    clearAll: () => {
      const messages = Object.values(get().messagesByThreadId).flatMap((value) => value ?? []);
      set({ messagesByThreadId: {} });
      for (const message of messages) {
        revokeUserMessagePreviewUrls(message);
      }
    },
  }),
);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    useOptimisticUserMessageStore.getState().clearAll();
  });
}
