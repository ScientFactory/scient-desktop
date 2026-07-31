/**
 * Behavioral tests for the agent gateway drive tools.
 *
 * Drives `scient_send_message` and `scient_interrupt_thread` directly against a
 * fake ProjectionSnapshotQuery and a capturing OrchestrationEngine, asserting:
 * the dispatched command shape (origin/mode/turn pinning), the central drive
 * policy (project scope, privilege cap, worktree cap), send idempotency, and the
 * interrupt no-active-turn no-op.
 */
import type { OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Fiber, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  beginScientOperation,
  SCIENT_OPERATION_DEFINITIONS,
  type ScientOperationAuthority,
} from "../scientOperations/authority.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { makeThreadWriteTools } from "./threadWriteTools.ts";
import { gatewayToolFailureResult, GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const CALLER_THREAD = "thread-caller";
const TARGET_THREAD = "thread-target";
const CALLER_PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const ISO = "2026-01-01T00:00:00.000Z";
const TEST_WRITE_OPERATION = SCIENT_OPERATION_DEFINITIONS["thread.message.send"];

// Captured dispatch commands are asserted structurally; `any` keeps the test
// focused on the runtime shape the gateway emits and, unlike an object type,
// absorbs `undefined` from indexed access under noUncheckedIndexedAccess.
type AnyCommand = any;

function shell(id: string, overrides?: Record<string, unknown>): OrchestrationThreadShell {
  return {
    id,
    projectId: CALLER_PROJECT,
    title: `Thread ${id}`,
    modelSelection: { provider: "claudeAgent", model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    parentThreadId: null,
    branch: null,
    worktreePath: null,
    archivedAt: null,
    updatedAt: ISO,
    latestTurn: null,
    session: null,
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

function makeSnapshotQuery(
  threadShells: Record<string, OrchestrationThreadShell>,
): ProjectionSnapshotQueryShape {
  return {
    getThreadShellById: (id: string) => Effect.succeed(Option.fromNullishOr(threadShells[id])),
  } as unknown as ProjectionSnapshotQueryShape;
}

function makeEngine(options?: {
  readonly failWith?: string;
  readonly dispatch?: (
    command: AnyCommand,
  ) => Effect.Effect<{ readonly sequence: number }, unknown>;
}): {
  readonly engine: OrchestrationEngineShape;
  readonly commands: AnyCommand[];
} {
  const commands: AnyCommand[] = [];
  const engine = {
    dispatch: (command: AnyCommand) => {
      commands.push(command);
      if (options?.dispatch !== undefined) return options.dispatch(command);
      if (options?.failWith !== undefined) return Effect.fail(new Error(options.failWith));
      return Effect.succeed({ sequence: commands.length });
    },
  } as unknown as OrchestrationEngineShape;
  return { engine, commands };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  const operationAuthority: ScientOperationAuthority = overrides?.operationAuthority ?? {
    authorityId: "gateway-session:test",
    generation: "gateway-session:test",
    actor: {
      kind: "provider-thread",
      threadId: CALLER_THREAD,
      provider: "claudeAgent",
      sessionKey: "gateway-session:test",
    },
    projectIds: [CALLER_PROJECT],
    capabilities: ["thread:read", "thread:drive"],
    issuedAt: 0,
    expiresAt: null,
    revokedAt: null,
  };
  const started = beginScientOperation({
    authority: operationAuthority,
    definition: TEST_WRITE_OPERATION,
    operationId: "operation-test",
    projectId: CALLER_PROJECT,
    ingress: "provider-gateway",
    semanticIdempotencyIdentity: "test",
    payloadFingerprint: "test-payload",
    receivedAt: 1,
  });
  if (!started.allow) throw new Error("Expected test operation authority to be allowed.");
  return {
    callerThreadId: CALLER_THREAD,
    callerProjectId: CALLER_PROJECT,
    callerSessionKey: "gateway-session:test",
    callerProvider: "claudeAgent",
    operationAuthority,
    operationEnvelope: started.envelope,
    admittedCaller: shell(CALLER_THREAD),
    callerTurnId: "turn-caller",
    requireCurrentOperationCaller: () => Effect.succeed(shell(CALLER_THREAD)),
    requireCurrentCallerTurn: () => Effect.succeed(shell(CALLER_THREAD)),
    recordOperationEffect: () => undefined,
    jsonRpcRequestId: 1,
    ...overrides,
  };
}

interface Setup {
  readonly callEffect: (
    name: string,
    args: Record<string, unknown>,
    context?: ToolContext,
  ) => Effect.Effect<McpToolCallResult>;
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    context?: ToolContext,
  ) => Promise<McpToolCallResult>;
  readonly commands: AnyCommand[];
  readonly revokeSession: (sessionKey: string) => void;
}

function setup(options?: {
  readonly threadShells?: Record<string, OrchestrationThreadShell>;
  readonly caller?: OrchestrationThreadShell;
  readonly failDispatchWith?: string;
  readonly dispatch?: (
    command: AnyCommand,
  ) => Effect.Effect<{ readonly sequence: number }, unknown>;
  readonly randomId?: () => string;
}): Setup {
  const caller = options?.caller ?? shell(CALLER_THREAD);
  const threadShells: Record<string, OrchestrationThreadShell> = {
    [CALLER_THREAD]: caller,
    ...options?.threadShells,
  };
  const snapshotQuery = makeSnapshotQuery(threadShells);
  const { engine, commands } = makeEngine(
    options?.failDispatchWith !== undefined
      ? { failWith: options.failDispatchWith }
      : options?.dispatch !== undefined
        ? { dispatch: options.dispatch }
        : {},
  );
  let revocationListener: ((identity: { readonly sessionKey: string }) => void) | undefined;
  const tools = makeThreadWriteTools({
    snapshotQuery,
    orchestrationEngine: engine,
    now: () => ISO,
    randomId: options?.randomId ?? (() => "rand-id"),
    subscribeSessionRevocations: (listener) => {
      revocationListener = listener;
      return () => {
        revocationListener = undefined;
      };
    },
  });
  const defaultContext = makeContext({
    admittedCaller: caller,
    requireCurrentOperationCaller: () => Effect.succeed(caller),
    requireCurrentCallerTurn: () => Effect.succeed(caller),
  });
  const callEffect = (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext = defaultContext,
  ) => {
    const tool = tools.find((entry) => entry.definition.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    // Mirror the transport's defect net: a thrown ToolInputError is a defect,
    // not an Effect failure, so unit calls must catch defects too.
    return tool
      .handler(args, context)
      .pipe(Effect.catchDefect((defect) => Effect.succeed(gatewayToolFailureResult(defect))));
  };
  const call = (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext = defaultContext,
  ) => Effect.runPromise(callEffect(name, args, context));
  return {
    call,
    callEffect,
    commands,
    revokeSession: (sessionKey) => revocationListener?.({ sessionKey }),
  };
}

function jsonBody(result: McpToolCallResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("scient_send_message", () => {
  it("dispatches a queued turn.start with honest additive agent provenance", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { interactionMode: "plan" }) },
    });
    const result = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "please continue",
    });
    const body = jsonBody(result);
    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      threadId: TARGET_THREAD,
      dispatched: "queue",
      requestId: null,
      deduplicated: false,
    });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command.type).toBe("thread.turn.start");
    expect(command.threadId).toBe(TARGET_THREAD);
    expect(command.message.role).toBe("user");
    expect(command.message.text).toBe("please continue");
    expect(command.message.attachments).toEqual([]);
    expect(command.dispatchMode).toBe("queue");
    expect(command.dispatchOrigin).toBeUndefined();
    expect(command.dispatchSource).toBe("agent");
    expect(command.runtimeMode).toBe("full-access");
    expect(command.interactionMode).toBe("plan");
    expect(command.operationPrecondition).toEqual({
      actorThreadId: CALLER_THREAD,
      actor: {
        projectId: CALLER_PROJECT,
        runtimeMode: "full-access",
        envMode: "local",
        interactionMode: "default",
        provider: "claudeAgent",
        sessionStatus: null,
        activeTurnId: null,
        latestTurnId: null,
        latestTurnState: null,
      },
      target: {
        projectId: CALLER_PROJECT,
        runtimeMode: "full-access",
        envMode: "local",
        interactionMode: "plan",
        provider: "claudeAgent",
        sessionStatus: null,
        activeTurnId: null,
        latestTurnId: null,
        latestTurnState: null,
      },
    });
    expect(command.createdAt).toBe(ISO);
    expect(command.commandId).toBe("agent:rand-id:send");
    expect(command.message.messageId).toBe("agent:rand-id:message");
  });

  it("passes steer mode through to the dispatch", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    const body = jsonBody(
      await call("scient_send_message", {
        threadId: TARGET_THREAD,
        message: "redirect",
        mode: "steer",
      }),
    );
    expect(body.dispatched).toBe("steer");
    expect(commands[0].dispatchMode).toBe("steer");
  });

  it("uses the transport-admitted caller without a duplicate projection read", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
    });
    const result = await call(
      "scient_send_message",
      { threadId: TARGET_THREAD, message: "dispatch once" },
      makeContext({
        requireCurrentCallerTurn: () =>
          Effect.fail(
            new GatewayToolError(
              "caller_session_inactive",
              "Provider-session authority was revoked.",
            ),
          ),
      }),
    );

    expect(jsonBody(result)).toMatchObject({ threadId: TARGET_THREAD, dispatched: "queue" });
    expect(commands).toHaveLength(1);
  });

  it("rejects an invalid mode", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    const result = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "hi",
      mode: "bogus",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('"queue" or "steer"');
    expect(commands).toHaveLength(0);
  });

  it("is idempotent across a retry with the same requestId (single dispatch)", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    const first = jsonBody(
      await call("scient_send_message", {
        threadId: TARGET_THREAD,
        message: "once",
        requestId: "req-1",
      }),
    );
    const second = jsonBody(
      await call("scient_send_message", {
        threadId: TARGET_THREAD,
        message: "once",
        requestId: "req-1",
      }),
    );
    expect(first).toEqual({
      threadId: TARGET_THREAD,
      dispatched: "queue",
      requestId: "req-1",
      deduplicated: false,
    });
    expect(second).toEqual({
      threadId: TARGET_THREAD,
      dispatched: "queue",
      requestId: "req-1",
      deduplicated: true,
    });
    expect(commands).toHaveLength(1);
    // Idempotent sends derive a bounded deterministic identity from the exact
    // provider session plus request id.
    expect(commands[0].commandId).toMatch(/^agent:[0-9a-f]{32}:send$/);
    expect(commands[0].message.messageId).toBe(commands[0].commandId.replace(/:send$/, ":message"));
  });

  it("single-flights concurrent retries with the same requestId and fingerprint", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () => Effect.promise(async () => (await gate, { sequence: 1 })),
    });
    const args = { threadId: TARGET_THREAD, message: "once", requestId: "concurrent" };
    const first = call("scient_send_message", args);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const retry = call("scient_send_message", args);
    await Promise.resolve();
    expect(commands).toHaveLength(1);
    release();
    expect(jsonBody(await first).deduplicated).toBe(false);
    expect(jsonBody(await retry).deduplicated).toBe(true);
    expect(commands).toHaveLength(1);
  });

  it("rejects a conflicting concurrent reuse before the first dispatch settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () => Effect.promise(async () => (await gate, { sequence: 1 })),
    });
    const first = call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "first",
      requestId: "concurrent-conflict",
    });
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const conflict = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "different",
      requestId: "concurrent-conflict",
    });
    expect((jsonBody(conflict).error as { code: string }).code).toBe("idempotency_conflict");
    expect(commands).toHaveLength(1);
    release();
    await first;
  });

  it("single-flights concurrent retries through the real MCP transport", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const caller = shell(CALLER_THREAD, {
      session: { providerName: "claudeAgent", status: "running" },
      latestTurn: { turnId: "turn-caller", state: "running" },
    });
    const target = shell(TARGET_THREAD);
    const snapshotQuery = makeSnapshotQuery({ [CALLER_THREAD]: caller, [TARGET_THREAD]: target });
    const { engine, commands } = makeEngine({
      dispatch: () => Effect.promise(async () => (await gate, { sequence: 1 })),
    });
    const requireThreadShell = (id: string) =>
      Effect.succeed(id === CALLER_THREAD ? caller : target);
    const tools = makeThreadWriteTools({
      snapshotQuery,
      orchestrationEngine: engine,
    });
    const credentials = {
      verifySession: () => ({
        sessionKey: "gateway-session:test",
        threadId: CALLER_THREAD,
        provider: "claudeAgent",
        issuedAt: 0,
        capabilities: ["thread:read", "thread:drive"],
      }),
      bindWriteAuthority: () => ({
        sessionKey: "gateway-session:test",
        threadId: CALLER_THREAD,
        provider: "claudeAgent",
        turnId: "turn-caller",
      }),
      verifyWriteAuthority: () => true,
      acquireWriteLease: () => ({
        sessionKey: "gateway-session:test",
        release: () => undefined,
      }),
      subscribeSessionRevocations: () => () => undefined,
    } as unknown as AgentGatewayCredentialsShape;
    const transport = makeAgentGatewayMcpTransport({
      credentials,
      snapshotQuery,
      tools,
      instructions: "test",
      requireThreadShell,
    });
    const request = Effect.runPromise(
      transport({
        authorizationHeader: "Bearer test",
        body: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "scient_send_message",
              arguments: { threadId: TARGET_THREAD, message: "once", requestId: "batch-retry" },
            },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "scient_send_message",
              arguments: { threadId: TARGET_THREAD, message: "once", requestId: "batch-retry" },
            },
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    release();
    const response = await request;
    const bodies = (response.body as Array<{ result: McpToolCallResult }>).map((item) =>
      jsonBody(item.result),
    );
    expect(bodies.map((body) => body.deduplicated).toSorted()).toEqual([false, true]);
    expect(commands).toHaveLength(1);
  });

  it("releases a failed reservation so a later retry can dispatch", async () => {
    let attempts = 0;
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () =>
        ++attempts === 1 ? Effect.fail(new Error("first failed")) : Effect.succeed({ sequence: 2 }),
    });
    const args = { threadId: TARGET_THREAD, message: "retry", requestId: "retry-after-failure" };
    expect((await call("scient_send_message", args)).isError).toBe(true);
    expect((await call("scient_send_message", args)).isError).toBeUndefined();
    expect(commands).toHaveLength(2);
  });

  it("unblocks concurrent waiters on failure and permits a later retry", async () => {
    let fail!: (error: Error) => void;
    const firstAttempt = new Promise<{ readonly sequence: number }>((_resolve, reject) => {
      fail = reject;
    });
    let attempts = 0;
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () =>
        ++attempts === 1
          ? Effect.tryPromise(() => firstAttempt)
          : Effect.succeed({ sequence: attempts }),
    });
    const args = { threadId: TARGET_THREAD, message: "retry", requestId: "shared-failure" };
    const first = call("scient_send_message", args);
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const waiter = call("scient_send_message", args);
    fail(new Error("dispatch failed"));
    expect((await first).isError).toBe(true);
    expect((await waiter).isError).toBe(true);
    expect((await call("scient_send_message", args)).isError).toBeUndefined();
    expect(commands).toHaveLength(2);
  });

  it("bounds all pending sends per session even without requestIds and releases slots", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () => Effect.promise(async () => (await gate, { sequence: 1 })),
    });
    const pending = Array.from({ length: 16 }, (_, index) =>
      call("scient_send_message", { threadId: TARGET_THREAD, message: `pending-${index}` }),
    );
    await vi.waitFor(() => expect(commands).toHaveLength(16));
    const saturated = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "seventeenth",
    });
    expect((jsonBody(saturated).error as { code: string }).code).toBe("gateway_busy");
    expect(commands).toHaveLength(16);
    release();
    await Promise.all(pending);
    expect(
      (
        await call("scient_send_message", {
          threadId: TARGET_THREAD,
          message: "after-release",
        })
      ).isError,
    ).toBeUndefined();
    expect(commands).toHaveLength(17);
  });

  it("enforces the aggregate pending-message byte budget", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () => Effect.promise(async () => (await gate, { sequence: 1 })),
    });
    const maxMessage = "x".repeat(512 * 1024);
    const pending = Array.from({ length: 8 }, () =>
      call("scient_send_message", { threadId: TARGET_THREAD, message: maxMessage }),
    );
    await vi.waitFor(() => expect(commands).toHaveLength(8));
    const overBudget = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "one-byte-over-budget",
    });
    expect((jsonBody(overBudget).error as { code: string }).code).toBe("gateway_busy");
    expect(commands).toHaveLength(8);
    release();
    await Promise.all(pending);
  });

  it("releases pending capacity when an in-flight send is interrupted", async () => {
    let attempts = 0;
    const { call, callEffect, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      dispatch: () => (++attempts === 1 ? Effect.never : Effect.succeed({ sequence: attempts })),
    });
    const fiber = Effect.runFork(
      callEffect("scient_send_message", { threadId: TARGET_THREAD, message: "interrupt me" }),
    );
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const probes = Array.from({ length: 16 }, (_, index) =>
      call("scient_send_message", {
        threadId: TARGET_THREAD,
        message: `probe-${index}`,
      }),
    );
    await vi.waitFor(() => expect(commands).toHaveLength(17));
    await Promise.all(probes);
  });

  it("rejects oversized request ids and messages before dispatch", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    expect(
      (
        await call("scient_send_message", {
          threadId: TARGET_THREAD,
          message: "x",
          requestId: "r".repeat(257),
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call("scient_send_message", {
          threadId: TARGET_THREAD,
          message: "🧪".repeat(131_073),
        })
      ).isError,
    ).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("dispatches separately for distinct requestIds", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    await call("scient_send_message", { threadId: TARGET_THREAD, message: "a", requestId: "r-a" });
    await call("scient_send_message", { threadId: TARGET_THREAD, message: "b", requestId: "r-b" });
    expect(commands).toHaveLength(2);
  });

  it("preserves completed idempotency claims for the session at the 512-entry cap", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    for (let index = 0; index < 512; index += 1) {
      await call("scient_send_message", {
        threadId: TARGET_THREAD,
        message: `message-${index}`,
        requestId: `request-${index}`,
      });
    }
    const atCapacity = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "new payload",
      requestId: "request-512",
    });
    expect((jsonBody(atCapacity).error as { code: string }).code).toBe("gateway_busy");
    const identical = jsonBody(
      await call("scient_send_message", {
        threadId: TARGET_THREAD,
        message: "message-0",
        requestId: "request-0",
      }),
    );
    expect(identical.deduplicated).toBe(true);
    const conflict = await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "changed payload",
      requestId: "request-0",
    });
    expect((jsonBody(conflict).error as { code: string }).code).toBe("idempotency_conflict");
    expect(commands).toHaveLength(512);
  });

  it("clears completed idempotency claims when the owning session is revoked", async () => {
    const { call, commands, revokeSession } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
    });
    const context = makeContext({ callerSessionKey: "gateway-session:revoked" });
    const args = { threadId: TARGET_THREAD, message: "first", requestId: "same" };
    await call("scient_send_message", args, context);
    revokeSession(context.callerSessionKey);
    await call("scient_send_message", { ...args, message: "replacement" }, context);
    expect(commands).toHaveLength(2);
  });

  it("does not share dedup across caller threads", async () => {
    const other = shell("thread-caller-2");
    const { call, commands } = setup({
      threadShells: { "thread-caller-2": other, [TARGET_THREAD]: shell(TARGET_THREAD) },
    });
    await call("scient_send_message", { threadId: TARGET_THREAD, message: "a", requestId: "same" });
    await call(
      "scient_send_message",
      { threadId: TARGET_THREAD, message: "a", requestId: "same" },
      makeContext({
        callerThreadId: "thread-caller-2",
        callerSessionKey: "gateway-session:thread-caller-2",
      }),
    );
    expect(commands).toHaveLength(2);
  });

  it("does not share dedup across replacement provider sessions on one thread", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    await call(
      "scient_send_message",
      { threadId: TARGET_THREAD, message: "first session", requestId: "same" },
      makeContext({ callerSessionKey: "gateway-session:first" }),
    );
    await call(
      "scient_send_message",
      { threadId: TARGET_THREAD, message: "replacement session", requestId: "same" },
      makeContext({ callerSessionKey: "gateway-session:replacement" }),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0].commandId).not.toBe(commands[1].commandId);
  });

  it.each([
    {
      label: "target",
      second: { threadId: "thread-target-2", message: "once", requestId: "same" },
    },
    {
      label: "message",
      second: { threadId: TARGET_THREAD, message: "changed", requestId: "same" },
    },
    {
      label: "mode",
      second: { threadId: TARGET_THREAD, message: "once", mode: "steer", requestId: "same" },
    },
  ])("rejects requestId reuse with a different $label in one session", async ({ second }) => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD),
        "thread-target-2": shell("thread-target-2"),
      },
    });
    await call("scient_send_message", {
      threadId: TARGET_THREAD,
      message: "once",
      requestId: "same",
    });
    const conflict = await call("scient_send_message", second);
    expect(conflict.isError).toBe(true);
    expect((jsonBody(conflict).error as { code: string }).code).toBe("idempotency_conflict");
    expect(commands).toHaveLength(1);
  });

  it("denies a cross-project send as thread_not_found without dispatching", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { projectId: OTHER_PROJECT }) },
    });
    const result = await call("scient_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });

  it("denies driving a higher-privileged target (privilege cap)", async () => {
    const { call, commands } = setup({
      caller: shell(CALLER_THREAD, { runtimeMode: "approval-required" }),
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { runtimeMode: "full-access" }) },
    });
    const result = await call("scient_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("capability_denied");
    expect(commands).toHaveLength(0);
  });

  it("denies a worktree caller driving a local target (worktree cap)", async () => {
    const { call, commands } = setup({
      caller: shell(CALLER_THREAD, { envMode: "worktree" }),
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { envMode: "local" }) },
    });
    const result = await call("scient_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("capability_denied");
    expect(commands).toHaveLength(0);
  });

  it("reports thread_not_found for a missing target", async () => {
    const { call, commands } = setup();
    const result = await call("scient_send_message", { threadId: "ghost", message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });

  it("surfaces a dispatch failure as operation_failed", async () => {
    const { call } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      failDispatchWith: "engine boom",
    });
    const result = await call("scient_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    const error = jsonBody(result).error as { code: string; message: string };
    expect(error.code).toBe("operation_failed");
    expect(error.message).toBe("The gateway tool failed unexpectedly.");
    expect(result.content[0]!.text).not.toContain("engine boom");
  });

  it("does not remember a failed dispatch for later replay", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      failDispatchWith: "engine boom",
    });
    await call("scient_send_message", { threadId: TARGET_THREAD, message: "x", requestId: "r" });
    await call("scient_send_message", { threadId: TARGET_THREAD, message: "x", requestId: "r" });
    // Both attempts dispatch: a failure is retryable, never cached as success.
    expect(commands).toHaveLength(2);
  });
});

describe("scient_interrupt_thread", () => {
  it("interrupts a running turn, pinned to the observed turn id", async () => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          latestTurn: { turnId: "turn-x", state: "running" },
        }),
      },
    });
    const body = jsonBody(await call("scient_interrupt_thread", { threadId: TARGET_THREAD }));
    expect(body).toEqual({ threadId: TARGET_THREAD, interrupted: true, turnId: "turn-x" });
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("thread.turn.interrupt");
    expect(commands[0].threadId).toBe(TARGET_THREAD);
    expect(commands[0].turnId).toBe("turn-x");
    expect(commands[0].commandId).toBe(`agent:${TARGET_THREAD}:turn-x:interrupt`);
    expect(commands[0].operationPrecondition).toEqual({
      actorThreadId: CALLER_THREAD,
      actor: {
        projectId: CALLER_PROJECT,
        runtimeMode: "full-access",
        envMode: "local",
        interactionMode: "default",
        provider: "claudeAgent",
        sessionStatus: null,
        activeTurnId: null,
        latestTurnId: null,
        latestTurnState: null,
      },
      target: {
        projectId: CALLER_PROJECT,
        runtimeMode: "full-access",
        envMode: "local",
        interactionMode: "default",
        provider: "claudeAgent",
        sessionStatus: null,
        activeTurnId: null,
        latestTurnId: "turn-x",
        latestTurnState: "running",
      },
    });
    expect(commands[0].createdAt).toBe(ISO);
  });

  it("uses the transport-admitted caller for interrupt without a duplicate projection read", async () => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          latestTurn: { turnId: "turn-target", state: "running" },
        }),
      },
    });
    const result = await call(
      "scient_interrupt_thread",
      { threadId: TARGET_THREAD },
      makeContext({
        requireCurrentCallerTurn: () =>
          Effect.fail(
            new GatewayToolError("caller_turn_inactive", "Caller turn is no longer active."),
          ),
      }),
    );

    expect(jsonBody(result)).toMatchObject({ threadId: TARGET_THREAD, interrupted: true });
    expect(commands).toHaveLength(1);
  });

  it("is a no-op when the target has no running turn", async () => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          latestTurn: { turnId: "turn-x", state: "completed" },
        }),
      },
    });
    const body = jsonBody(await call("scient_interrupt_thread", { threadId: TARGET_THREAD }));
    expect(body).toEqual({
      threadId: TARGET_THREAD,
      interrupted: false,
      reason: "no_active_turn",
    });
    expect(commands).toHaveLength(0);
  });

  it("is a no-op when the target has never had a turn", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { latestTurn: null }) },
    });
    const body = jsonBody(await call("scient_interrupt_thread", { threadId: TARGET_THREAD }));
    expect(body.interrupted).toBe(false);
    expect(commands).toHaveLength(0);
  });

  it("denies a cross-project interrupt as thread_not_found", async () => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          projectId: OTHER_PROJECT,
          latestTurn: { turnId: "turn-x", state: "running" },
        }),
      },
    });
    const result = await call("scient_interrupt_thread", { threadId: TARGET_THREAD });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });

  it("denies interrupting a higher-privileged target (privilege cap)", async () => {
    const { call, commands } = setup({
      caller: shell(CALLER_THREAD, { runtimeMode: "approval-required" }),
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          runtimeMode: "full-access",
          latestTurn: { turnId: "turn-x", state: "running" },
        }),
      },
    });
    const result = await call("scient_interrupt_thread", { threadId: TARGET_THREAD });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("capability_denied");
    expect(commands).toHaveLength(0);
  });

  it("reports thread_not_found for a missing target", async () => {
    const { call, commands } = setup();
    const result = await call("scient_interrupt_thread", { threadId: "ghost" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });
});

describe("makeThreadWriteTools", () => {
  it("exposes exactly two provider-thread drive operations requiring an active turn", () => {
    const tools = makeThreadWriteTools({
      snapshotQuery: makeSnapshotQuery({}),
      orchestrationEngine: makeEngine().engine,
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "scient_send_message",
      "scient_interrupt_thread",
    ]);
    expect(
      tools.every(
        (tool) => SCIENT_OPERATION_DEFINITIONS[tool.operation].admission === "write-authority",
      ),
    ).toBe(true);
    expect(
      tools.every(
        (tool) => SCIENT_OPERATION_DEFINITIONS[tool.operation].capability === "thread:drive",
      ),
    ).toBe(true);
    expect(
      tools.every((tool) =>
        SCIENT_OPERATION_DEFINITIONS[tool.operation].allowedActorKinds.includes("provider-thread"),
      ),
    ).toBe(true);
    // Drive tools must carry write annotations (not read-only).
    expect(tools.every((tool) => tool.definition.annotations?.readOnlyHint === false)).toBe(true);
  });
});
