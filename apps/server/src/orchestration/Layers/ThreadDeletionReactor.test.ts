import { ThreadId, TurnId, type OrchestrationReadModel } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  cleanupSucceededUnlessInterrupted,
  logCleanupCauseUnlessInterrupted,
  resolveDeletedThreadProviderCleanup,
} from "./ThreadDeletionReactor";

function cleanupReadModel(
  threads: Array<{
    readonly id: ThreadId;
    readonly parentThreadId?: ThreadId;
    readonly activeTurnId?: TurnId;
  }>,
): OrchestrationReadModel {
  return {
    threads: threads.map((thread) => ({
      id: thread.id,
      ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
      session: thread.activeTurnId
        ? {
            threadId: thread.id,
            status: "running",
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

  it("falls back to direct session cleanup for missing or corrupt lineage", () => {
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
    ).toEqual({ kind: "stop-session", threadId: childId });
    expect(
      resolveDeletedThreadProviderCleanup(
        cleanupReadModel([
          { id: childId, parentThreadId: cycleId, activeTurnId: turnId },
          { id: cycleId, parentThreadId: childId },
        ]),
        childId,
      ),
    ).toEqual({ kind: "stop-session", threadId: childId });
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
