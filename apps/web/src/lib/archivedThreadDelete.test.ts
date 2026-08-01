// FILE: archivedThreadDelete.test.ts
// Purpose: Verifies archived-thread delete coordination without rendering settings UI.
// Layer: Web orchestration helper tests

import type { NativeApi, ThreadBrowserState } from "@synara/contracts";
import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserStateStore } from "../browserStateStore";
import { createMemoryStorage } from "./storage";

import {
  archivedThreadDeleteConfirmation,
  buildArchivedThreadFamilyScopes,
  buildArchivedThreadDeletionFamilies,
  buildArchivedWorktreeDeletionPlan,
  deleteArchivedThreadFromClient,
  deleteArchivedThreadsFromClient,
} from "./archivedThreadDelete";

const PROJECT_ID = ProjectId.makeUnsafe("project-archived-delete");

function snapshotThread(threadId: ThreadId, parentThreadId: ThreadId | null = null) {
  return { id: threadId, parentThreadId, projectId: PROJECT_ID };
}

function worktreeSnapshotThread(
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
  options: {
    readonly archived?: boolean;
    readonly worktreePath?: string | null;
    readonly associatedWorktreePath?: string | null;
  } = {},
) {
  return {
    ...snapshotThread(threadId, parentThreadId),
    archivedAt: options.archived === false ? null : "2026-08-01T00:00:00.000Z",
    worktreePath: options.worktreePath ?? null,
    associatedWorktreePath: options.associatedWorktreePath ?? null,
  };
}

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

describe("buildArchivedThreadFamilyScopes", () => {
  it("keeps restore and destructive counts distinct for a legacy mixed family", () => {
    const parent = ThreadId.makeUnsafe("thread-archived-parent");
    const archivedChild = ThreadId.makeUnsafe("thread-archived-child");
    const liveChild = ThreadId.makeUnsafe("thread-live-child");
    const threads = [
      { ...snapshotThread(parent), archivedAt: "2026-08-01T00:00:00.000Z" },
      {
        ...snapshotThread(archivedChild, parent),
        archivedAt: "2026-08-01T00:00:00.000Z",
      },
      { ...snapshotThread(liveChild, parent), archivedAt: null },
    ];

    const scopes = buildArchivedThreadFamilyScopes(threads);

    expect(scopes.archivedRoots.map((thread) => thread.id)).toEqual([parent]);
    expect(scopes.restoreCountByRootId.get(parent)).toBe(2);
    expect(scopes.deleteCountByRootId.get(parent)).toBe(3);
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

  it("derives one exact cascade for a selected archived parent and child", async () => {
    const parent = ThreadId.makeUnsafe("thread-archived-parent");
    const child = ThreadId.makeUnsafe("thread-archived-child");
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadsFromClient({
      api: archivedDeleteApi(dispatchCommand),
      threadIds: [parent, child],
      snapshotThreads: [snapshotThread(parent), snapshotThread(child, parent)],
      removeDeletedThreadFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: parent,
      cascadeDescendants: true,
      expectedDescendantThreadIds: [child],
    });
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[child], [parent]]);
  });

  it("includes unselected snapshot descendants in a selected root's exact cascade", () => {
    const parent = ThreadId.makeUnsafe("thread-selected-parent");
    const child = ThreadId.makeUnsafe("thread-unselected-child");

    expect(
      buildArchivedThreadDeletionFamilies({
        selectedThreadIds: [parent],
        snapshotThreads: [snapshotThread(parent), snapshotThread(child, parent)],
      }),
    ).toEqual([{ rootThreadId: parent, descendantThreadIds: [child] }]);
  });

  it("honors a selected ancestor through an omitted intermediate and emits one command", async () => {
    const parent = ThreadId.makeUnsafe("thread-selected-parent");
    const omittedChild = ThreadId.makeUnsafe("thread-omitted-child");
    const selectedGrandchild = ThreadId.makeUnsafe("thread-selected-grandchild");
    const snapshotThreads = [
      snapshotThread(parent),
      snapshotThread(omittedChild, parent),
      snapshotThread(selectedGrandchild, omittedChild),
    ];
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    expect(
      buildArchivedThreadDeletionFamilies({
        selectedThreadIds: [parent, selectedGrandchild],
        snapshotThreads,
      }),
    ).toEqual([
      {
        rootThreadId: parent,
        descendantThreadIds: [selectedGrandchild, omittedChild],
      },
    ]);

    await deleteArchivedThreadsFromClient({
      api: archivedDeleteApi(dispatchCommand),
      threadIds: [parent, selectedGrandchild],
      snapshotThreads,
      removeDeletedThreadFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: parent,
      cascadeDescendants: true,
      expectedDescendantThreadIds: [selectedGrandchild, omittedChild],
    });
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([
      [selectedGrandchild],
      [omittedChild],
      [parent],
    ]);
  });

  it.each([
    {
      name: "unlinked archived",
      child: (child: ThreadId, parent: ThreadId) => worktreeSnapshotThread(child, parent),
    },
    {
      name: "live linked",
      child: (child: ThreadId, parent: ThreadId) =>
        worktreeSnapshotThread(child, parent, { archived: false, worktreePath: "/target" }),
    },
    {
      name: "other-worktree archived",
      child: (child: ThreadId, parent: ThreadId) =>
        worktreeSnapshotThread(child, parent, { worktreePath: "/other" }),
    },
  ])("refuses a selected worktree root with a $name descendant", ({ child: makeChild }) => {
    const parent = ThreadId.makeUnsafe("thread-worktree-parent");
    const child = ThreadId.makeUnsafe("thread-outside-child");
    const plan = buildArchivedWorktreeDeletionPlan({
      worktreePath: "/target",
      snapshotThreads: [
        worktreeSnapshotThread(parent, null, { worktreePath: "/target" }),
        makeChild(child, parent),
      ],
    });

    expect(plan.families).toEqual([{ rootThreadId: parent, descendantThreadIds: [child] }]);
    expect(plan.threadIds).toEqual([child, parent]);
    expect(plan.linkedArchivedThreadIds).toEqual([parent]);
    expect(plan.unexpectedDescendantThreadIds).toEqual([child]);
  });

  it("counts the unique destructive union when every descendant is linked and archived", () => {
    const parent = ThreadId.makeUnsafe("thread-linked-parent");
    const child = ThreadId.makeUnsafe("thread-linked-child");
    const plan = buildArchivedWorktreeDeletionPlan({
      worktreePath: " /target ",
      snapshotThreads: [
        worktreeSnapshotThread(parent, null, { worktreePath: "/target" }),
        worktreeSnapshotThread(child, parent, { associatedWorktreePath: "/target" }),
      ],
    });

    expect(plan.threadIds).toEqual([child, parent]);
    expect(plan.linkedArchivedThreadIds).toEqual([parent, child]);
    expect(plan.linkedActiveThreadCount).toBe(0);
    expect(plan.unexpectedDescendantThreadIds).toEqual([]);
  });

  it("reconciles a complete independent family when a later family fails", async () => {
    const threadA = ThreadId.makeUnsafe("thread-archived-a");
    const childA = ThreadId.makeUnsafe("thread-archived-a-child");
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
        threadIds: [threadA, childA, threadB],
        snapshotThreads: [
          snapshotThread(threadA),
          snapshotThread(childA, threadA),
          snapshotThread(threadB),
        ],
        removeDeletedThreadFromClientState,
      }),
    ).rejects.toThrow(dispatchError);

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(dispatchCommand).toHaveBeenNthCalledWith(1, {
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: threadA,
      cascadeDescendants: true,
      expectedDescendantThreadIds: [childA],
    });
    expect(dispatchCommand).toHaveBeenNthCalledWith(2, {
      type: "thread.delete",
      commandId: expect.any(String),
      threadId: threadB,
      cascadeDescendants: true,
      expectedDescendantThreadIds: [],
    });
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[childA], [threadA]]);
  });

  it("keeps selected roots independent across projects even when parent ids collide", () => {
    const parent = ThreadId.makeUnsafe("thread-parent");
    const child = ThreadId.makeUnsafe("thread-child");
    const otherProject = ProjectId.makeUnsafe("project-other");

    expect(
      buildArchivedThreadDeletionFamilies({
        selectedThreadIds: [parent, child],
        snapshotThreads: [
          snapshotThread(parent),
          { id: child, parentThreadId: parent, projectId: otherProject },
        ],
      }),
    ).toEqual([
      { rootThreadId: parent, descendantThreadIds: [] },
      { rootThreadId: child, descendantThreadIds: [] },
    ]);
  });
});
