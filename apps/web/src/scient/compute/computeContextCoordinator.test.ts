import type { ComputeSessionRecord } from "@t3tools/contracts";
import {
  AnalysisRunId,
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  closeComputeContext,
  stopComputeContext,
  mergeComputeSessionRecords,
} from "./computeContextCoordinator";
import {
  ComputeContextId,
  ensureComputeContext,
  useComputeContextStore,
} from "./computeContextStore";

const environmentId = EnvironmentId.make("environment-1");
const contextId = "context-close" as Parameters<typeof ensureComputeContext>[0]["contextId"];
const sessionId = ComputeSessionId.make("session-close");
const otherSessionId = ComputeSessionId.make("session-other");

const record = (
  generation: number,
  status: ComputeSessionRecord["status"],
  ownedSessionId = sessionId,
): ComputeSessionRecord =>
  ({
    sessionId: ownedSessionId,
    generation: ComputeSessionGeneration.make(generation),
    status,
  }) as ComputeSessionRecord;

beforeEach(() => {
  useComputeContextStore.setState({ bindings: {} });
  ensureComputeContext({
    contextId,
    environmentId,
    cwd: "/project",
    ownerKey: "owner",
  });
  useComputeContextStore.getState().reserveSession({ sessionId, contextId });
  useComputeContextStore.getState().bindSession({
    contextId,
    sessionId,
    generation: ComputeSessionGeneration.make(1),
  });
});

describe("compute context close coordinator", () => {
  it("stops the displayed session without cancelling independent child runs", async () => {
    const child = ComputeContextId.make("independent-batch");
    ensureComputeContext({
      contextId: child,
      parentContextId: contextId,
      batchRunId: AnalysisRunId.make("batch-still-running"),
      environmentId,
      cwd: "/project",
      ownerKey: contextId,
    });
    const childBefore = useComputeContextStore.getState().bindings[child];
    const stopSession = vi.fn().mockResolvedValue({ _tag: "Success", value: record(1, "stopped") });
    const cancelBatchRun = vi.fn();
    expect(
      (await stopComputeContext({ contextId, stopSession, getSession: vi.fn(), cancelBatchRun }))
        .closed,
    ).toBe(true);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(cancelBatchRun).not.toHaveBeenCalled();
    expect(useComputeContextStore.getState().bindings[child]).toBe(childBefore);
  });
  it("requires native batch cleanup confirmation before dismissing its parent", async () => {
    const child = ComputeContextId.make("batch-child");
    const runId = AnalysisRunId.make("batch-owned");
    ensureComputeContext({
      contextId: child,
      parentContextId: contextId,
      batchRunId: runId,
      environmentId,
      cwd: "/project",
      ownerKey: contextId,
    });
    const stopSession = vi.fn().mockResolvedValue({ _tag: "Success", value: record(1, "stopped") });
    const getSession = vi.fn();
    const cancelBatchRun = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(
      (await closeComputeContext({ contextId, stopSession, getSession, cancelBatchRun })).closed,
    ).toBe(false);
    expect(cancelBatchRun).toHaveBeenCalledWith({
      environmentId,
      cwd: "/project",
      runId,
      waitForExit: true,
    });
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("close-failed");
    expect(
      (await closeComputeContext({ contextId, stopSession, getSession, cancelBatchRun })).closed,
    ).toBe(true);
  });
  it("closes the persistent session and every fresh child, not another tab", async () => {
    const children = ["fresh-one", "fresh-two"].map((name) => {
      const childId = ComputeContextId.make(name);
      const childSessionId = ComputeSessionId.make(name);
      ensureComputeContext({
        contextId: childId,
        parentContextId: contextId,
        environmentId,
        cwd: "/project",
        ownerKey: contextId,
      });
      useComputeContextStore
        .getState()
        .reserveSession({ contextId: childId, sessionId: childSessionId });
      return childSessionId;
    });
    const stopSession = vi
      .fn()
      .mockImplementation(
        async ({ input }: { input: { sessionId: ComputeSessionRecord["sessionId"] } }) => ({
          _tag: "Success" as const,
          value: record(1, "stopped", input.sessionId),
        }),
      );
    const getSession = vi.fn();
    const result = await closeComputeContext({ contextId, stopSession, getSession });
    expect(result.closed).toBe(true);
    expect(stopSession.mock.calls.map(([request]) => request.input.sessionId).sort()).toEqual(
      [sessionId, ...children].sort(),
    );
    expect(getSession).not.toHaveBeenCalled();
    useComputeContextStore.getState().removeContext(contextId);
    expect(Object.keys(useComputeContextStore.getState().bindings)).toEqual([]);
  });

  it("retains the owning tab when a fresh child cannot be stopped", async () => {
    const childId = ComputeContextId.make("fresh-failure");
    ensureComputeContext({
      contextId: childId,
      parentContextId: contextId,
      environmentId,
      cwd: "/project",
      ownerKey: contextId,
    });
    useComputeContextStore
      .getState()
      .reserveSession({ contextId: childId, sessionId: otherSessionId });
    const stopSession = vi
      .fn()
      .mockImplementation(
        async ({ input }: { input: { sessionId: ComputeSessionRecord["sessionId"] } }) =>
          input.sessionId === sessionId
            ? { _tag: "Success" as const, value: record(1, "stopped") }
            : { _tag: "Failure" as const, cause: Cause.fail(new Error("cleanup failed")) },
      );
    const getSession = vi
      .fn()
      .mockResolvedValue({ _tag: "Success", value: record(1, "ready", otherSessionId) });
    expect((await closeComputeContext({ contextId, stopSession, getSession })).closed).toBe(false);
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("close-failed");
    const another = ComputeContextId.make("too-late");
    ensureComputeContext({
      contextId: another,
      parentContextId: contextId,
      environmentId,
      cwd: "/project",
      ownerKey: contextId,
    });
    expect(
      useComputeContextStore
        .getState()
        .reserveSession({ contextId: another, sessionId: ComputeSessionId.make("late") }),
    ).toBe(false);
  });

  it("does not replace a newer observed session with a stale exact-id cache", () => {
    const earlier = { ...record(1, "ready"), lastActivityAt: "2026-09-10T00:00:00Z" };
    const later = {
      ...record(1, "ready"),
      lastActivityAt: "2026-09-10T00:01:00Z",
      activity: "busy" as const,
    };
    expect(mergeComputeSessionRecords([later], [earlier])).toEqual([later]);
    const stopped = { ...later, status: "stopped" as const };
    expect(mergeComputeSessionRecords([stopped], [later])).toEqual([stopped]);
    expect(mergeComputeSessionRecords([record(2, "ready")], [stopped])[0]?.generation).toBe(2);
  });
  it("re-reads the same owner after a generation race and retries stop once", async () => {
    const stopSession = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("stale generation")) })
      .mockResolvedValueOnce({ _tag: "Success", value: record(2, "stopped") });
    const getSession = vi.fn().mockResolvedValue({ _tag: "Success", value: record(2, "ready") });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result).toEqual({ closed: true, contextId, error: null });
    expect(stopSession.mock.calls.map(([input]) => input.input.expectedGeneration)).toEqual([1, 2]);
    expect(getSession).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/project", sessionId },
    });
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("terminal");
  });

  it("keeps a failed close reachable for retry", async () => {
    const stopSession = vi
      .fn()
      .mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("shutdown failed")) });
    const getSession = vi.fn().mockResolvedValue({ _tag: "Success", value: record(1, "ready") });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result.closed).toBe(false);
    expect(useComputeContextStore.getState().bindings[contextId]).toMatchObject({
      lifecycle: "close-failed",
      closeError: expect.any(String),
    });
  });

  it("does not trust a successful stop for another session", async () => {
    const stopSession = vi
      .fn()
      .mockResolvedValue({ _tag: "Success", value: record(1, "stopped", otherSessionId) });
    const getSession = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: record(1, "stopped"),
    });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result.closed).toBe(true);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("terminal");
  });

  it("requires a terminal record even when stop reports success", async () => {
    const stopSession = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: record(1, "ready"),
    });
    const getSession = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: record(1, "stopped"),
    });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result.closed).toBe(true);
    expect(getSession).toHaveBeenCalledOnce();
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("terminal");
  });

  it("catches rejected callbacks and leaves the exact owner retryable", async () => {
    const stopSession = vi.fn().mockRejectedValue(new Error("transport closed"));
    const getSession = vi.fn();

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result).toEqual({
      closed: false,
      contextId,
      error: "transport closed",
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(useComputeContextStore.getState().bindings[contextId]).toMatchObject({
      contextId,
      sessionId,
      lifecycle: "close-failed",
    });
  });

  it("keeps a pending owner for a late start after session-not-found", async () => {
    const pendingContextId = "context-pending" as typeof contextId;
    ensureComputeContext({
      contextId: pendingContextId,
      environmentId,
      cwd: "/project",
      ownerKey: "pending-owner",
    });
    const pendingSessionId = ComputeSessionId.make("session-pending");
    useComputeContextStore.getState().reserveSession({
      contextId: pendingContextId,
      sessionId: pendingSessionId,
    });

    const stopSession = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("session-not-found")),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: record(1, "stopped", pendingSessionId),
      });
    const getSession = vi.fn().mockResolvedValue({ _tag: "Success", value: null });

    const firstClose = await closeComputeContext({
      contextId: pendingContextId,
      stopSession,
      getSession,
    });
    expect(firstClose.closed).toBe(false);
    expect(useComputeContextStore.getState().bindings[pendingContextId]).toMatchObject({
      contextId: pendingContextId,
      sessionId: pendingSessionId,
      lifecycle: "close-failed",
    });

    // The delayed start response must not reclaim an owner already closing.
    expect(
      useComputeContextStore.getState().bindSession({
        contextId: pendingContextId,
        sessionId: pendingSessionId,
        generation: ComputeSessionGeneration.make(1),
      }),
    ).toBe(false);

    const retry = await closeComputeContext({
      contextId: pendingContextId,
      stopSession,
      getSession,
    });
    expect(retry.closed).toBe(true);
    expect(stopSession.mock.calls.at(-1)?.[0]).toMatchObject({
      input: { sessionId: pendingSessionId },
    });
  });

  it("closes an explicitly released pre-admission reservation without stopping another session", async () => {
    const capacityContextId = "context-capacity" as typeof contextId;
    ensureComputeContext({
      contextId: capacityContextId,
      environmentId,
      cwd: "/project",
      ownerKey: "capacity-owner",
    });
    const capacitySessionId = ComputeSessionId.make("session-capacity");
    const capacityGeneration = ComputeSessionGeneration.make(1);
    useComputeContextStore.getState().reserveSession({
      contextId: capacityContextId,
      sessionId: capacitySessionId,
      generation: capacityGeneration,
    });
    expect(
      useComputeContextStore.getState().releasePendingReservation({
        contextId: capacityContextId,
        sessionId: capacitySessionId,
        generation: capacityGeneration,
      }),
    ).toBe(true);

    const stopSession = vi.fn();
    const getSession = vi.fn();
    const result = await closeComputeContext({
      contextId: capacityContextId,
      stopSession,
      getSession,
    });

    expect(result).toEqual({ closed: true, contextId: capacityContextId, error: null });
    expect(stopSession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
