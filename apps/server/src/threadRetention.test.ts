// FILE: threadRetention.test.ts
// Purpose: Verifies inactive-thread selection without running the server loop.
// Layer: Server maintenance tests
// Exports: Vitest coverage for threadRetention helpers.

import { ProjectId, ThreadId, type OrchestrationReadModel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  getInactiveThreadIdsForRetention,
  getRetentionDeleteScope,
  THREAD_RETENTION_UNUSED_MS,
} from "./threadRetention";

function makeReadModelThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-active"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    latestUserMessageAt: null,
    deletedAt: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    ...overrides,
  } as OrchestrationReadModel["threads"][number];
}

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

describe("thread retention", () => {
  it("selects inactive threads older than the seven-day hide window", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const staleThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-stale"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
    });
    const recentThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-recent"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS + 1).toISOString(),
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([staleThread, recentThread]), nowMs),
    ).toEqual([staleThread.id]);
  });

  it("does not select busy or pending threads even when they are old", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();

    expect(
      getInactiveThreadIdsForRetention(
        makeReadModel([
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-running"),
            latestUserMessageAt: oldActivityAt,
            session: {
              threadId: ThreadId.makeUnsafe("thread-running"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: oldActivityAt,
            },
          }),
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-pending"),
            latestUserMessageAt: oldActivityAt,
            hasPendingUserInput: true,
          }),
        ]),
        nowMs,
      ),
    ).toEqual([]);
  });

  it("does not select pinned threads even when they are old", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const pinnedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-pinned"),
      isPinned: true,
      latestUserMessageAt: oldActivityAt,
    });
    const unpinnedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-unpinned"),
      latestUserMessageAt: oldActivityAt,
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([pinnedThread, unpinnedThread]), nowMs),
    ).toEqual([unpinnedThread.id]);
  });

  it("does not select enabled heartbeat automation target threads", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const heartbeatTarget = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-heartbeat-target"),
      latestUserMessageAt: oldActivityAt,
    });
    const ordinaryThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-ordinary"),
      latestUserMessageAt: oldActivityAt,
    });

    expect(
      getInactiveThreadIdsForRetention(
        makeReadModel([heartbeatTarget, ordinaryThread]),
        nowMs,
        new Set([heartbeatTarget.id]),
      ),
    ).toEqual([ordinaryThread.id]);
  });

  it("selects one root for an entirely inactive subtree", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const root = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-root"),
      latestUserMessageAt: oldActivityAt,
    });
    const child = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-child"),
      parentThreadId: root.id,
      latestUserMessageAt: oldActivityAt,
    });
    const grandchild = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-grandchild"),
      parentThreadId: child.id,
      latestUserMessageAt: oldActivityAt,
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([child, grandchild, root]), nowMs),
    ).toEqual([root.id]);
  });

  it.each(["recent", "busy", "pinned", "protected"] as const)(
    "keeps the whole subtree when a descendant is %s",
    (protectedState) => {
      const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
      const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
      const recentActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS + 1).toISOString();
      const root = makeReadModelThread({
        id: ThreadId.makeUnsafe(`thread-root-${protectedState}`),
        latestUserMessageAt: oldActivityAt,
      });
      const child = makeReadModelThread({
        id: ThreadId.makeUnsafe(`thread-child-${protectedState}`),
        parentThreadId: root.id,
        latestUserMessageAt: protectedState === "recent" ? recentActivityAt : oldActivityAt,
        ...(protectedState === "busy" ? { hasPendingApprovals: true } : {}),
        ...(protectedState === "pinned" ? { isPinned: true } : {}),
      });
      const protectedIds =
        protectedState === "protected" ? new Set<ThreadId>([child.id]) : new Set<ThreadId>();

      expect(
        getInactiveThreadIdsForRetention(makeReadModel([root, child]), nowMs, protectedIds),
      ).toEqual([]);
    },
  );

  it("treats an inactive legacy orphan as its own safe retention root", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const orphan = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-orphan"),
      parentThreadId: ThreadId.makeUnsafe("thread-missing-parent"),
      latestUserMessageAt: oldActivityAt,
    });

    expect(getInactiveThreadIdsForRetention(makeReadModel([orphan]), nowMs)).toEqual([orphan.id]);
  });

  it("binds retention deletion to a fresh exact subtree revision", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const root = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-retention-root"),
      latestUserMessageAt: oldActivityAt,
    });
    const child = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-retention-child"),
      parentThreadId: root.id,
      latestUserMessageAt: oldActivityAt,
    });
    const snapshot = {
      ...makeReadModel([root, child]),
      snapshotSequence: 41,
    } as unknown as import("@synara/contracts").OrchestrationShellSnapshot;

    expect(getRetentionDeleteScope(snapshot, root.id, nowMs, new Set())).toEqual({
      expectedDescendantThreadIds: [child.id],
      expectedReadModelSequence: 41,
    });

    const recentChild = {
      ...child,
      latestUserMessageAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    const changedSnapshot = {
      ...snapshot,
      snapshotSequence: 42,
      threads: [root, recentChild],
    } as unknown as import("@synara/contracts").OrchestrationShellSnapshot;
    expect(getRetentionDeleteScope(changedSnapshot, root.id, nowMs, new Set())).toBeNull();
  });

  it("indexes a wide forest once instead of rescanning it for every root", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    let parentLinkReads = 0;
    const threads = Array.from({ length: 1_000 }, (_, index) => {
      const thread = makeReadModelThread({
        id: ThreadId.makeUnsafe(`thread-wide-${index}`),
        latestUserMessageAt: oldActivityAt,
      });
      return new Proxy(thread, {
        get(target, property, receiver) {
          if (property === "parentThreadId") {
            parentLinkReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      });
    });

    expect(getInactiveThreadIdsForRetention(makeReadModel(threads), nowMs)).toHaveLength(1_000);
    expect(parentLinkReads).toBeLessThan(5_000);
  });
});
