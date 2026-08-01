import { MessageId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useUserMessageEditDraftStore } from "./userMessageEditDraftStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-edit-draft");
const MESSAGE_ID = MessageId.makeUnsafe("message-edit-draft");

describe("userMessageEditDraftStore", () => {
  beforeEach(() => {
    useUserMessageEditDraftStore.getState().clearAll();
  });

  it("retains rejected text and ignores a late acceptance", () => {
    const store = useUserMessageEditDraftStore.getState();
    store.begin(THREAD_ID, {
      messageId: MESSAGE_ID,
      draftText: "replacement text",
      originalText: "original text",
    });
    store.markRejected(THREAD_ID, MESSAGE_ID);
    store.markAccepted(THREAD_ID, MESSAGE_ID);

    expect(useUserMessageEditDraftStore.getState().draftsByThreadId[THREAD_ID]).toEqual({
      messageId: MESSAGE_ID,
      draftText: "replacement text",
      originalText: "original text",
      phase: "rejected",
    });
  });

  it("does not clear a newer edit for the same thread", () => {
    const store = useUserMessageEditDraftStore.getState();
    store.begin(THREAD_ID, {
      messageId: MESSAGE_ID,
      draftText: "first replacement",
      originalText: "original text",
    });
    const newerMessageId = MessageId.makeUnsafe("message-edit-draft-newer");
    store.begin(THREAD_ID, {
      messageId: newerMessageId,
      draftText: "newer replacement",
      originalText: "newer original",
    });
    store.clear(THREAD_ID, MESSAGE_ID);

    expect(useUserMessageEditDraftStore.getState().draftsByThreadId[THREAD_ID]?.messageId).toBe(
      newerMessageId,
    );
  });
});
