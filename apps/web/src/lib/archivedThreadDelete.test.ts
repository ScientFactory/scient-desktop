// FILE: archivedThreadDelete.test.ts
// Purpose: Verifies archived-thread delete coordination without rendering settings UI.
// Layer: Web orchestration helper tests

import type { NativeApi, ThreadBrowserState } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserStateStore } from "../browserStateStore";
import { createMemoryStorage } from "./storage";

import {
  archivedThreadDeleteConfirmation,
  deleteArchivedThreadFromClient,
  deleteArchivedThreadsFromClient,
} from "./archivedThreadDelete";

describe("archivedThreadDeleteConfirmation", () => {
  it("states the complete destructive scope for a subtree", () => {
    expect(archivedThreadDeleteConfirmation("Main analysis", 3)).toBe(
      'Permanently delete "Main analysis" and its 2 sub-agent conversations?\n\n' +
        "This will remove all 3 conversations and their histories forever.",
    );
  });

  it("keeps the singular copy for a leaf conversation", () => {
    expect(archivedThreadDeleteConfirmation("Leaf", 1)).toContain(
      "remove the conversation and its history forever",
    );
  });
});

const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  globalThis.localStorage = createMemoryStorage() as Storage;
});

afterEach(() => {
  useBrowserStateStore.setState({ threadStatesByThreadId: {}, recentHistoryByThreadId: {} });
  globalThis.localStorage = originalLocalStorage;
});

function archivedDeleteApi(dispatchCommand: ReturnType<typeof vi.fn>) {
  return {
    orchestration: { dispatchCommand },
    browser: {
      getState: vi.fn(async ({ threadId }: { threadId: ThreadId }) => ({
        threadId,
        version: 0,
        open: false,
        activeTabId: null,
        tabs: [],
        lastError: null,
      })) as unknown as NativeApi["browser"]["getState"],
      close: vi.fn(
        async ({ threadId }: { threadId: ThreadId }) =>
          ({
            threadId,
            version: 1,
            open: false,
            activeTabId: null,
            tabs: [],
            lastError: null,
          }) satisfies ThreadBrowserState,
      ) as unknown as NativeApi["browser"]["close"],
    },
    projects: {
      revokeHtmlArtifactPreview: vi.fn(async () => ({ revoked: true })),
    },
  } as unknown as Pick<NativeApi, "browser" | "orchestration" | "projects">;
}

describe("deleteArchivedThreadFromClient", () => {
  it("dispatches one server-authoritative subtree delete, then removes every local row", async () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const childId = ThreadId.makeUnsafe("thread-archived-child");
    const grandchildId = ThreadId.makeUnsafe("thread-archived-grandchild");
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadFromClient({
      api: archivedDeleteApi(dispatchCommand),
      threadId,
      descendantThreadIds: [grandchildId, childId],
      removeDeletedThreadFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: expect.any(String),
      threadId,
      cascadeDescendants: true,
      expectedDescendantThreadIds: [grandchildId, childId],
    });
    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([
      [grandchildId],
      [childId],
      [threadId],
    ]);
    const dispatchOrder = dispatchCommand.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const removeOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(dispatchOrder).toBeLessThan(removeOrder);
  });

  it("deletes multiple archived threads and removes each locally once", async () => {
    const threadA = ThreadId.makeUnsafe("thread-archived-a");
    const threadB = ThreadId.makeUnsafe("thread-archived-b");
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadsFromClient({
      api: archivedDeleteApi(dispatchCommand),
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(dispatchCommand).toHaveBeenNthCalledWith(1, {
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: threadA,
    });
    expect(dispatchCommand).toHaveBeenNthCalledWith(2, {
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: threadB,
    });
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA], [threadB]]);
  });

  it("reconciles successful archived deletes when a later bulk delete fails", async () => {
    const threadA = ThreadId.makeUnsafe("thread-archived-a");
    const threadB = ThreadId.makeUnsafe("thread-archived-b");
    const dispatchError = new Error("delete failed");
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({ sequence: 11 })
      .mockRejectedValueOnce(dispatchError);
    const removeDeletedThreadFromClientState = vi.fn();

    await expect(
      deleteArchivedThreadsFromClient({
        api: archivedDeleteApi(dispatchCommand),
        threadIds: [threadA, threadB],
        removeDeletedThreadFromClientState,
      }),
    ).rejects.toThrow(dispatchError);

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA]]);
  });
});
