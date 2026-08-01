import type { MessageId, ThreadId } from "@synara/contracts";
import { create } from "zustand";

export interface PendingUserMessageEditDraft {
  messageId: MessageId;
  draftText: string;
  originalText: string;
  originalRevision: string;
  phase: "dispatching" | "accepted" | "rejected";
}

interface UserMessageEditDraftStoreState {
  draftsByThreadId: Partial<Record<ThreadId, PendingUserMessageEditDraft>>;
  begin: (threadId: ThreadId, draft: Omit<PendingUserMessageEditDraft, "phase">) => void;
  markAccepted: (threadId: ThreadId, messageId: MessageId) => void;
  markRejected: (threadId: ThreadId, messageId: MessageId) => void;
  clear: (threadId: ThreadId, messageId?: MessageId) => void;
  clearAll: () => void;
}

function updatePhase(
  state: UserMessageEditDraftStoreState,
  threadId: ThreadId,
  messageId: MessageId,
  phase: PendingUserMessageEditDraft["phase"],
): Partial<UserMessageEditDraftStoreState> | UserMessageEditDraftStoreState {
  const current = state.draftsByThreadId[threadId];
  if (!current || current.messageId !== messageId || current.phase === "rejected") {
    return state;
  }
  return {
    draftsByThreadId: {
      ...state.draftsByThreadId,
      [threadId]: { ...current, phase },
    },
  };
}

export const useUserMessageEditDraftStore = create<UserMessageEditDraftStoreState>((set) => ({
  draftsByThreadId: {},
  begin: (threadId, draft) => {
    set((state) => ({
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [threadId]: { ...draft, phase: "dispatching" },
      },
    }));
  },
  markAccepted: (threadId, messageId) => {
    set((state) => updatePhase(state, threadId, messageId, "accepted"));
  },
  markRejected: (threadId, messageId) => {
    set((state) => updatePhase(state, threadId, messageId, "rejected"));
  },
  clear: (threadId, messageId) => {
    set((state) => {
      const current = state.draftsByThreadId[threadId];
      if (!current || (messageId !== undefined && current.messageId !== messageId)) {
        return state;
      }
      const draftsByThreadId = { ...state.draftsByThreadId };
      delete draftsByThreadId[threadId];
      return { draftsByThreadId };
    });
  },
  clearAll: () => set({ draftsByThreadId: {} }),
}));

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    useUserMessageEditDraftStore.getState().clearAll();
  });
}
