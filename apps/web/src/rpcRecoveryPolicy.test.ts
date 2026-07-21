// FILE: rpcRecoveryPolicy.test.ts
// Purpose: Locks conservative RPC replay boundaries and one-retry behavior.
// Layer: Web transport recovery policy tests

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { SocketCloseError, SocketError, SocketOpenError } from "effect/unstable/socket/Socket";
import { describe, expect, it, vi } from "vitest";

import {
  isRpcTransportFailure,
  rpcRecoveryPolicyFor,
  runRpcWithRecovery,
} from "./rpcRecoveryPolicy";

describe("rpcRecoveryPolicyFor", () => {
  it("allows reviewed read-only methods to replay on a new generation", () => {
    expect(rpcRecoveryPolicyFor(WS_METHODS.filesystemBrowse)).toBe("retry-on-new-generation");
    expect(rpcRecoveryPolicyFor(WS_METHODS.gitStatus)).toBe("retry-on-new-generation");
    expect(rpcRecoveryPolicyFor(ORCHESTRATION_WS_METHODS.getSnapshot)).toBe(
      "retry-on-new-generation",
    );
  });

  it.each([
    WS_METHODS.projectsAdd,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.gitPull,
    WS_METHODS.gitRunStackedAction,
    WS_METHODS.terminalOpen,
    WS_METHODS.terminalWrite,
    WS_METHODS.serverInstallProvider,
    WS_METHODS.serverGenerateThreadRecap,
    WS_METHODS.scientProjectInitializationPreview,
    WS_METHODS.studioListThreadOutputs,
    WS_METHODS.pullRequestsList,
    WS_METHODS.pullRequestsDetail,
    WS_METHODS.pullRequestsDiff,
    WS_METHODS.serverListProviderUsage,
    WS_METHODS.providerGetComposerCapabilities,
    WS_METHODS.providerListSkills,
    WS_METHODS.providerListModels,
    WS_METHODS.pullRequestsComment,
    WS_METHODS.automationRunNow,
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    ORCHESTRATION_WS_METHODS.importThread,
  ])("never replays a mutating or outcome-ambiguous method: %s", (method) => {
    expect(rpcRecoveryPolicyFor(method)).toBe("never-replay");
  });

  it("defaults unknown future methods to never replay", () => {
    expect(rpcRecoveryPolicyFor("future.method")).toBe("never-replay");
  });
});

describe("isRpcTransportFailure", () => {
  it("recognizes structured RPC socket failures", () => {
    expect(
      isRpcTransportFailure(new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) })),
    ).toBe(true);
    expect(
      isRpcTransportFailure(
        new RpcClientError({
          reason: new SocketOpenError({ kind: "Timeout", cause: "open timed out" }),
        }),
      ),
    ).toBe(true);
    expect(
      isRpcTransportFailure(new SocketError({ reason: new SocketCloseError({ code: 1006 }) })),
    ).toBe(true);
  });

  it.each([
    new Error("Git command timed out after 60000ms"),
    new Error("provider connection is not authenticated"),
    new Error("socket validation failed"),
    { _tag: "GitCommandError", message: "connection timed out" },
    { _tag: "RpcClientError", reason: { _tag: "HttpClientError" } },
  ])("does not infer transport failure from semantic message text: %o", (error) => {
    expect(isRpcTransportFailure(error)).toBe(false);
  });
});

describe("runRpcWithRecovery", () => {
  it("replays a reviewed read exactly once on a replacement generation", async () => {
    const run = vi
      .fn<(session: { generation: number }) => Promise<string>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce("recovered");
    const recover = vi.fn(async () => ({ generation: 2 }));

    await expect(
      runRpcWithRecovery({
        method: WS_METHODS.filesystemBrowse,
        session: { generation: 1 },
        run,
        shouldRecover: () => true,
        recover,
      }),
    ).resolves.toBe("recovered");
    expect(run.mock.calls.map(([session]) => session.generation)).toEqual([1, 2]);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("starts recovery without replaying or replacing a mutation error", async () => {
    const failure = new Error("outcome unknown");
    const run = vi.fn(async () => Promise.reject(failure));
    const recover = vi.fn(async () => ({ generation: 2 }));

    await expect(
      runRpcWithRecovery({
        method: WS_METHODS.projectsWriteFile,
        session: { generation: 1 },
        run,
        shouldRecover: () => true,
        recover,
      }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not replay a read without a genuinely new generation", async () => {
    const failure = new Error("validation failed");
    const run = vi.fn(async () => Promise.reject(failure));

    await expect(
      runRpcWithRecovery({
        method: WS_METHODS.gitStatus,
        session: { generation: 3 },
        run,
        shouldRecover: () => true,
        recover: async () => ({ generation: 3 }),
      }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
  });

  it("never attempts a third execution when the replay fails", async () => {
    const firstFailure = new Error("first socket closed");
    const replayFailure = new Error("replacement failed");
    const run = vi
      .fn<(session: { generation: number }) => Promise<string>>()
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(replayFailure);

    await expect(
      runRpcWithRecovery({
        method: WS_METHODS.serverGetConfig,
        session: { generation: 1 },
        run,
        shouldRecover: () => true,
        recover: async () => ({ generation: 2 }),
      }),
    ).rejects.toBe(replayFailure);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("preserves semantic errors even if another path already replaced the generation", async () => {
    const failure = new Error("Git command timed out after 60000ms");
    const run = vi.fn(async () => Promise.reject(failure));
    const recover = vi.fn(async () => ({ generation: 2 }));

    await expect(
      runRpcWithRecovery({
        method: WS_METHODS.filesystemBrowse,
        session: { generation: 1 },
        run,
        shouldRecover: isRpcTransportFailure,
        recover,
      }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });
});
