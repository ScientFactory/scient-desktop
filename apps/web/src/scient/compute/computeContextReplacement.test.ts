import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ComputeLanguageId,
  ComputeSessionId,
  ComputeSessionGeneration,
  EnvironmentId,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import {
  closeComputeContext,
  replaceComputeContextSession,
  stopComputeContext,
} from "./computeContextCoordinator";
import {
  ComputeContextId,
  ensureComputeContext,
  getComputeContext,
  useComputeContextStore,
} from "./computeContextStore";

const contextId = ComputeContextId.make("replacement-owner");
const environmentId = EnvironmentId.make("remote-host");
const sessionId = ComputeSessionId.make("old-session");
const replacementSessionId = ComputeSessionId.make("new-session");
const languageId = ComputeLanguageId.make("python");
const generation = ComputeSessionGeneration.make(1);
const expectedSession = {
  sessionId,
  generation,
  languageId,
  status: "ready",
  activity: "idle",
  runtime: {
    languageId,
    source: "path",
    executable: "/system/python",
    displayName: "Python",
    languageVersion: "3.14",
    architecture: null,
  },
} as ComputeSessionRecord;
const managedSession: ComputeSessionRecord = {
  ...expectedSession,
  sessionId: replacementSessionId,
  runtime: { ...expectedSession.runtime!, source: "managed", executable: "/managed/python" },
};
const success = AsyncResult.success;
const failure = (error: unknown = new Error("synthetic failure")) =>
  AsyncResult.failure<ComputeSessionRecord, unknown>(Cause.fail(error));
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function commands() {
  const stopSession = vi.fn(
    async ({
      input,
    }: {
      input: { sessionId: ComputeSessionId };
    }): Promise<AsyncResult.Success<ComputeSessionRecord, never>> =>
      success({ ...expectedSession, sessionId: input.sessionId, status: "stopped" as const }),
  );
  const getSession = vi.fn(async () => success(expectedSession));
  const prepareRuntime = vi.fn(async () => ({ languageId, executable: "/managed/python" }));
  const startSession = vi.fn(async () => success(managedSession));
  return {
    contextId,
    expectedSession,
    replacementSessionId,
    prepareRuntime,
    startSession,
    stopSession,
    getSession,
  };
}
beforeEach(() => {
  useComputeContextStore.setState({ bindings: {} });
  ensureComputeContext({ contextId, environmentId, cwd: "/project", ownerKey: "file.py" });
  useComputeContextStore.getState().reserveSession({ contextId, sessionId, generation });
  useComputeContextStore.getState().bindSession({ contextId, sessionId, generation });
});

describe("confirmed compute context replacement", () => {
  it("checks first, confirms cleanup, then starts one explicit runtime on the same host and owner", async () => {
    const input = commands();
    expect(await replaceComputeContextSession(input)).toEqual({
      kind: "started",
      session: managedSession,
    });
    expect(input.prepareRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      input.stopSession.mock.invocationCallOrder[0]!,
    );
    expect(input.stopSession.mock.invocationCallOrder[0]).toBeLessThan(
      input.startSession.mock.invocationCallOrder[0]!,
    );
    expect(input.startSession).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/project",
        sessionId: replacementSessionId,
        languageId,
        executable: "/managed/python",
      },
    });
    expect(getComputeContext(contextId)).toMatchObject({
      lifecycle: "live",
      sessionId: replacementSessionId,
      generation,
    });
  });
  it("keeps the old owner untouched when refreshed readiness fails", async () => {
    const input = commands();
    input.prepareRuntime.mockRejectedValue(new Error("Managed packages changed"));
    expect(await replaceComputeContextSession(input)).toEqual({
      kind: "failed",
      error: "Managed packages changed",
    });
    expect(input.stopSession).not.toHaveBeenCalled();
    expect(input.startSession).not.toHaveBeenCalled();
    expect(getComputeContext(contextId)).toMatchObject({ lifecycle: "live", sessionId });
  });
  it("does not replace another generation or a temporary fresh-run owner", async () => {
    const input = commands();
    expect(
      (
        await replaceComputeContextSession({
          ...input,
          expectedSession: { ...expectedSession, generation: ComputeSessionGeneration.make(2) },
        })
      ).kind,
    ).toBe("failed");
    useComputeContextStore.setState({
      bindings: {
        [contextId]: {
          ...getComputeContext(contextId)!,
          parentContextId: ComputeContextId.make("parent"),
        },
      },
    });
    expect((await replaceComputeContextSession(input)).kind).toBe("failed");
    expect(input.prepareRuntime).not.toHaveBeenCalled();
  });
  it("does not replace an owner that changed during the read-only check", async () => {
    const input = commands();
    input.prepareRuntime.mockImplementation(async () => {
      useComputeContextStore
        .getState()
        .bindSession({ contextId, sessionId, generation: ComputeSessionGeneration.make(2) });
      return { languageId, executable: "/managed/python" };
    });
    expect(await replaceComputeContextSession(input)).toEqual({ kind: "cancelled" });
    expect(input.stopSession).not.toHaveBeenCalled();
  });
  it("blocks duplicate recovery clicks during readiness checks", async () => {
    const input = commands();
    const readiness = deferred<{ languageId: ComputeLanguageId; executable: string }>();
    input.prepareRuntime.mockReturnValue(readiness.promise);
    const first = replaceComputeContextSession(input);
    expect(await replaceComputeContextSession(input)).toEqual({ kind: "cancelled" });
    readiness.resolve({ languageId, executable: "/managed/python" });
    await first;
    expect(input.startSession).toHaveBeenCalledOnce();
  });
  it.each([closeComputeContext, stopComputeContext])(
    "explicit close/stop cancels recovery while readiness is pending",
    async (close) => {
      const input = commands();
      const readiness = deferred<{ languageId: ComputeLanguageId; executable: string }>();
      input.prepareRuntime.mockReturnValue(readiness.promise);
      const recovering = replaceComputeContextSession(input);
      await close(input);
      readiness.resolve({ languageId, executable: "/managed/python" });
      expect(await recovering).toEqual({ kind: "cancelled" });
      expect(input.startSession).not.toHaveBeenCalled();
    },
  );
  it("explicit tab close during old-session shutdown prevents a new start", async () => {
    const input = commands();
    const shutdown = deferred<ReturnType<typeof success<ComputeSessionRecord>>>();
    input.stopSession.mockReturnValueOnce(shutdown.promise);
    const recovering = replaceComputeContextSession(input);
    await vi.waitFor(() => expect(input.stopSession).toHaveBeenCalledOnce());
    await closeComputeContext(input);
    shutdown.resolve(success({ ...expectedSession, status: "stopped" }));
    expect(await recovering).toEqual({ kind: "cancelled" });
    expect(input.startSession).not.toHaveBeenCalled();
  });
  it("does not start when shutdown cannot be confirmed", async () => {
    const input = commands();
    const stopSession = vi.fn(async () => failure());
    expect((await replaceComputeContextSession({ ...input, stopSession })).kind).toBe("failed");
    expect(input.startSession).not.toHaveBeenCalled();
    expect(getComputeContext(contextId)).toMatchObject({ sessionId, lifecycle: "close-failed" });
  });
  it("releases a capacity-rejected reservation without claiming readiness or stopping another session", async () => {
    const input = commands();
    const result = await replaceComputeContextSession({
      ...input,
      startSession: async () => failure({ reason: "capacity-reached" }),
    });
    expect(result).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("capacity reached"),
    });
    expect(input.stopSession).toHaveBeenCalledOnce();
    expect(getComputeContext(contextId)).toMatchObject({ sessionId: null, lifecycle: "unbound" });
  });
  it("cleans up a failed start and never binds its runtime", async () => {
    const input = commands();
    expect(
      (await replaceComputeContextSession({ ...input, startSession: async () => failure() })).kind,
    ).toBe("failed");
    expect(input.stopSession).toHaveBeenCalledTimes(2);
    expect(input.stopSession.mock.calls[1]?.[0].input.sessionId).toBe(replacementSessionId);
    expect(getComputeContext(contextId)?.lifecycle).toBe("terminal");
  });
  it("confirms cleanup after an interrupted startup instead of reporting a ready session", async () => {
    const input = commands();
    expect(
      await replaceComputeContextSession({
        ...input,
        startSession: async () =>
          AsyncResult.failure<ComputeSessionRecord, unknown>(Cause.interrupt()),
      }),
    ).toEqual({ kind: "cancelled" });
    expect(input.stopSession).toHaveBeenCalledTimes(2);
    expect(getComputeContext(contextId)?.lifecycle).toBe("terminal");
  });
  it("retains the reservation if cleanup of an uncertain start is also unconfirmed", async () => {
    const input = commands();
    const stopSession = vi
      .fn()
      .mockResolvedValueOnce(success({ ...expectedSession, status: "stopped" }))
      .mockResolvedValue(failure());
    await replaceComputeContextSession({
      ...input,
      stopSession,
      startSession: async () => {
        throw new Error("connection lost");
      },
      getSession: async () => success({ ...managedSession, status: "starting" }),
    });
    expect(getComputeContext(contextId)).toMatchObject({
      sessionId: replacementSessionId,
      lifecycle: "close-failed",
    });
  });
  it("never binds a different backend executable", async () => {
    const input = commands();
    input.startSession.mockResolvedValue(
      success({ ...managedSession, runtime: expectedSession.runtime }),
    );
    expect((await replaceComputeContextSession(input)).kind).toBe("failed");
    expect(input.stopSession).toHaveBeenCalledTimes(2);
    expect(getComputeContext(contextId)?.lifecycle).toBe("terminal");
  });
  it("closes a replacement when the tab closes during its startup", async () => {
    const input = commands();
    const startup = deferred<ReturnType<typeof success<ComputeSessionRecord>>>();
    input.startSession.mockReturnValue(startup.promise);
    const recovering = replaceComputeContextSession(input);
    await vi.waitFor(() => expect(input.startSession).toHaveBeenCalledOnce());
    await closeComputeContext(input);
    startup.resolve(success(managedSession));
    expect(await recovering).toEqual({ kind: "cancelled" });
    expect(getComputeContext(contextId)?.lifecycle).toBe("terminal");
    expect(
      input.stopSession.mock.calls
        .slice(1)
        .every(([call]) => call.input.sessionId === replacementSessionId),
    ).toBe(true);
  });
  it("keeps cancellation cleanup scoped to this owner across concurrent contexts", async () => {
    const others = Array.from({ length: 12 }, (_, i) => {
      const otherId = ComputeContextId.make(`other-${i}`);
      ensureComputeContext({
        contextId: otherId,
        environmentId,
        cwd: "/project",
        ownerKey: otherId,
      });
      useComputeContextStore
        .getState()
        .reserveSession({ contextId: otherId, sessionId, generation });
      useComputeContextStore.getState().bindSession({ contextId: otherId, sessionId, generation });
      return {
        ...commands(),
        contextId: otherId,
        replacementSessionId: ComputeSessionId.make(`new-${i}`),
      };
    });
    for (const input of others)
      input.startSession.mockResolvedValue(
        success({ ...managedSession, sessionId: input.replacementSessionId }),
      );
    const results = await Promise.all(others.map(replaceComputeContextSession));
    expect(results.every((result) => result.kind === "started")).toBe(true);
    expect(getComputeContext(contextId)?.sessionId).toBe(sessionId);
  });
  it("does not resurrect a removed binding after tab close confirmed replacement cleanup", async () => {
    const input = commands();
    const startup = deferred<ReturnType<typeof success<ComputeSessionRecord>>>();
    input.startSession.mockReturnValue(startup.promise);
    const recovering = replaceComputeContextSession(input);
    await vi.waitFor(() => expect(input.startSession).toHaveBeenCalledOnce());
    const closed = await closeComputeContext(input);
    expect(closed.closed).toBe(true);
    expect(input.stopSession.mock.calls.at(-1)?.[0].input.sessionId).toBe(replacementSessionId);
    useComputeContextStore.getState().removeContext(contextId);
    startup.resolve(success(managedSession));
    expect(await recovering).toEqual({ kind: "cancelled" });
    expect(getComputeContext(contextId)).toBeNull();
    expect(input.stopSession).toHaveBeenCalledTimes(2);
  });
  it("retains the replacement owner when explicit tab close cannot confirm cleanup", async () => {
    const input = commands();
    const startup = deferred<ReturnType<typeof success<ComputeSessionRecord>>>();
    input.startSession.mockReturnValue(startup.promise);
    const stopSession = vi
      .fn()
      .mockResolvedValueOnce(success({ ...expectedSession, status: "stopped" }))
      .mockResolvedValue(failure());
    const getSession = vi.fn(async () => success(managedSession));
    const recovering = replaceComputeContextSession({ ...input, stopSession, getSession });
    await vi.waitFor(() => expect(input.startSession).toHaveBeenCalledOnce());
    expect((await closeComputeContext({ ...input, stopSession, getSession })).closed).toBe(false);
    startup.resolve(success(managedSession));
    expect(await recovering).toEqual({ kind: "cancelled" });
    expect(getComputeContext(contextId)).toMatchObject({
      sessionId: replacementSessionId,
      lifecycle: "close-failed",
    });
    expect(
      stopSession.mock.calls
        .slice(1)
        .every(([call]) => call.input.sessionId === replacementSessionId),
    ).toBe(true);
  });
});
