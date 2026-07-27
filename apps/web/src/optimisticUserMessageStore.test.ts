import { MessageId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type OwnedOptimisticUserMessage,
  useOptimisticUserMessageStore,
} from "./optimisticUserMessageStore";

const SOURCE_THREAD_ID = ThreadId.makeUnsafe("thread-optimistic-source");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-optimistic-other");
const MESSAGE_ID = MessageId.makeUnsafe("message-optimistic-source");
const PREVIEW_URL = "blob:optimistic-source-preview";

function createMessage(): OwnedOptimisticUserMessage {
  return {
    ownerThreadId: SOURCE_THREAD_ID,
    id: MESSAGE_ID,
    role: "user",
    text: "owned optimistic message",
    attachments: [
      {
        type: "image",
        id: "optimistic-image",
        name: "optimistic.png",
        mimeType: "image/png",
        sizeBytes: 8,
        previewUrl: PREVIEW_URL,
      },
    ],
    createdAt: "2026-07-26T12:00:00.000Z",
    streaming: false,
    source: "native",
  };
}

describe("optimisticUserMessageStore", () => {
  beforeEach(() => {
    useOptimisticUserMessageStore.setState({ messagesByThreadId: {} });
  });

  afterEach(() => {
    useOptimisticUserMessageStore.setState({ messagesByThreadId: {} });
    vi.restoreAllMocks();
  });

  it("removes and revokes only the exact owner and message once", () => {
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const store = useOptimisticUserMessageStore.getState();
    store.addMessage(createMessage());

    expect(store.removeMessage(OTHER_THREAD_ID, MESSAGE_ID, { revokePreviews: true })).toBeNull();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(
      useOptimisticUserMessageStore.getState().messagesByThreadId[SOURCE_THREAD_ID],
    ).toHaveLength(1);

    expect(
      store.removeMessage(SOURCE_THREAD_ID, MESSAGE_ID, { revokePreviews: true }),
    ).toMatchObject({
      ownerThreadId: SOURCE_THREAD_ID,
      id: MESSAGE_ID,
    });
    expect(store.removeMessage(SOURCE_THREAD_ID, MESSAGE_ID, { revokePreviews: true })).toBeNull();
    expect(revokeObjectUrl.mock.calls.filter(([url]) => url === PREVIEW_URL)).toHaveLength(1);
  });

  it("retains a pending message until explicit acknowledgement or cleanup", () => {
    const store = useOptimisticUserMessageStore.getState();
    store.addMessage(createMessage());

    expect(useOptimisticUserMessageStore.getState().messagesByThreadId[SOURCE_THREAD_ID]).toEqual([
      expect.objectContaining({ id: MESSAGE_ID, ownerThreadId: SOURCE_THREAD_ID }),
    ]);
  });
});
