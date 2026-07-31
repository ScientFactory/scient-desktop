import { ProjectId, ThreadId, TurnId, type OrchestrationReadModel } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  cleanupSucceededUnlessInterrupted,
  logCleanupCauseUnlessInterrupted,
  providerCleanupCanPurgeImmediately,
  resolveDeletedThreadProviderCleanup,
  waitForDeletedSubagentSettlement,
} from "./ThreadDeletionReactor";

function cleanupReadModel(
  threads: Array<{
    readonly id: ThreadId;
    readonly parentThreadId?: ThreadId;
    readonly activeTurnId?: TurnId;
    readonly status?: "running" | "interrupted";
    readonly projectId?: ProjectId;
    readonly archivedAt?: string;
    readonly deletedAt?: string;
  }>,
): OrchestrationReadModel {
  return {
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId ?? ProjectId.makeUnsafe("project-lifecycle"),
      archivedAt: thread.archivedAt ?? null,
      deletedAt: thread.deletedAt ?? null,
      ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
      session: thread.activeTurnId
        ? {
            threadId: thread.id,
            status: thread.status ?? "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: thread.activeTurnId,
            lastError: null,
            updatedAt: "2026-07-31T08:00:00.000Z",
          }
        : null,
    })) as unknown as OrchestrationReadModel["threads"],
  } as OrchestrationReadModel;
}

describe("resolveDeletedThreadProviderCleanup", () => {
  it("stops an ordinary thread session directly", () => {
    const threadId = ThreadId.makeUnsafe("thread-root");

    expect(
      resolveDeletedThreadProviderCleanup(cleanupReadModel([{ id: threadId }]), threadId),
    ).toEqual({ kind: "stop-session", threadId });
  });

  it("interrupts an active subagent turn through its provider-owning parent", () => {
    const parentId = ThreadId.makeUnsafe("thread-parent");
    const childId = ThreadId.makeUnsafe("subagent:thread-parent:provider-child");
    const turnId = TurnId.makeUnsafe("turn-child");

    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          { id: parentId },
          { id: childId, parentThreadId: parentId, activeTurnId: turnId },
        ]),
        childId,
      ),
    ).toEqual({
      kind: "interrupt-subagent-turn",
      threadId: parentId,
      turnId,
      providerThreadId: "provider-child",
    });
  });

  it("routes a nested active subagent through the highest reachable provider owner", () => {
    const rootId = ThreadId.makeUnsafe("thread-root");
    const childId = ThreadId.makeUnsafe("subagent:thread-root:provider-child");
    const grandchildId = ThreadId.makeUnsafe(
      "subagent:subagent:thread-root:provider-child:provider-grandchild",
    );
    const turnId = TurnId.makeUnsafe("turn-grandchild");

    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          { id: rootId },
          { id: childId, parentThreadId: rootId },
          { id: grandchildId, parentThreadId: childId, activeTurnId: turnId },
        ]),
        grandchildId,
      ),
    ).toEqual({
      kind: "interrupt-subagent-turn",
      threadId: rootId,
      turnId,
      providerThreadId: "provider-grandchild",
    });
  });

  it("defers active subagent purge for missing or corrupt lineage", () => {
    const childId = ThreadId.makeUnsafe("subagent:missing:provider-child");
    const cycleId = ThreadId.makeUnsafe("subagent:child:cycle");
    const turnId = TurnId.makeUnsafe("turn-child");

    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          {
            id: childId,
            parentThreadId: ThreadId.makeUnsafe("missing"),
            activeTurnId: turnId,
          },
        ]),
        childId,
      ),
    ).toEqual({ kind: "defer-active-subagent", threadId: childId });
    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          { id: childId, parentThreadId: cycleId, activeTurnId: turnId },
          { id: cycleId, parentThreadId: childId },
        ]),
        childId,
      ),
    ).toEqual({ kind: "defer-active-subagent", threadId: childId });
  });

  it("defers cleanup when any provider-owner ancestor crosses a lifecycle boundary", () => {
    const rootId = ThreadId.makeUnsafe("thread-root");
    const childId = ThreadId.makeUnsafe("subagent:thread-root:provider-child");
    const grandchildId = ThreadId.makeUnsafe(
      "subagent:subagent:thread-root:provider-child:provider-grandchild",
    );
    const turnId = TurnId.makeUnsafe("turn-grandchild");
    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          { id: rootId, projectId: ProjectId.makeUnsafe("project-other") },
          { id: childId, parentThreadId: rootId },
          { id: grandchildId, parentThreadId: childId, activeTurnId: turnId },
        ]),
        grandchildId,
      ),
    ).toEqual({ kind: "defer-active-subagent", threadId: grandchildId });

    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          { id: rootId, archivedAt: "2026-07-31T08:00:00.000Z" },
          { id: childId, parentThreadId: rootId, activeTurnId: turnId },
        ]),
        childId,
      ),
    ).toEqual({ kind: "defer-active-subagent", threadId: childId });
  });

  it("keeps routing interrupted subagents with an unsettled active turn through their owner", () => {
    const parentId = ThreadId.makeUnsafe("thread-parent");
    const childId = ThreadId.makeUnsafe("subagent:thread-parent:provider-child");
    const turnId = TurnId.makeUnsafe("turn-child");
    const readModel = cleanupReadModel([
      { id: parentId },
      {
        id: childId,
        parentThreadId: parentId,
        activeTurnId: turnId,
        status: "interrupted",
      },
    ]);

    expect(resolveDeletedThreadProviderCleanup(readModel, childId)).toEqual({
      kind: "interrupt-subagent-turn",
      threadId: parentId,
      turnId,
      providerThreadId: "provider-child",
    });
  });
});

describe("providerCleanupCanPurgeImmediately", () => {
  it("keeps active subagent tombstones through interrupt acknowledgement or uncertain lineage", () => {
    const threadId = ThreadId.makeUnsafe("subagent:parent:child");
    expect(
      providerCleanupCanPurgeImmediately({
        kind: "interrupt-subagent-turn",
        threadId: ThreadId.makeUnsafe("parent"),
        turnId: TurnId.makeUnsafe("turn-child"),
        providerThreadId: "child",
      }),
    ).toBe(false);
    expect(providerCleanupCanPurgeImmediately({ kind: "defer-active-subagent", threadId })).toBe(
      false,
    );
    expect(providerCleanupCanPurgeImmediately({ kind: "stop-session", threadId })).toBe(true);
  });
});

describe("waitForDeletedSubagentSettlement", () => {
  it("observes terminal settlement in-process before allowing purge", async () => {
    const threadId = ThreadId.makeUnsafe("subagent:parent:child");
    const turnId = TurnId.makeUnsafe("turn-child");
    let reads = 0;
    const settled = await Effect.runPromise(
      waitForDeletedSubagentSettlement({
        threadId,
        attempts: 3,
        intervalMs: 0,
        getReadModel: () => {
          reads += 1;
          return Effect.succeed(
            cleanupReadModel([
              {
                id: threadId,
                ...(reads < 2 ? { activeTurnId: turnId } : {}),
              },
            ]),
          );
        },
      }),
    );
    expect(settled).toBe(true);
    expect(reads).toBe(2);
  });

  it("times out safely when no terminal settlement arrives", async () => {
    const threadId = ThreadId.makeUnsafe("subagent:parent:child");
    const turnId = TurnId.makeUnsafe("turn-child");
    const settled = await Effect.runPromise(
      waitForDeletedSubagentSettlement({
        threadId,
        attempts: 2,
        intervalMs: 0,
        getReadModel: () =>
          Effect.succeed(cleanupReadModel([{ id: threadId, activeTurnId: turnId }])),
      }),
    );
    expect(settled).toBe(false);
  });
});

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("cleanupSucceededUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("returns true for successful cleanup", async () => {
    const result = await Effect.runPromise(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.void,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(result).toBe(true);
  });

  it("returns false for ordinary cleanup failures", async () => {
    const result = await Effect.runPromise(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(result).toBe(false);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
