// FILE: threadRetention.test.ts
// Purpose: Verifies inactive-thread selection without running the server loop.
// Layer: Server maintenance tests
// Exports: Vitest coverage for threadRetention helpers.

import { ProjectId, ThreadId, type OrchestrationReadModel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { getInactiveThreadIdsForRetention, THREAD_RETENTION_UNUSED_MS } from "./threadRetention";

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
});
