/**
 * Behavioral tests for the agent gateway drive tools.
 *
 * Drives `synara_send_message` and `synara_interrupt_thread` directly against a
 * fake ProjectionSnapshotQuery and a capturing OrchestrationEngine, asserting:
 * the dispatched command shape (origin/mode/turn pinning), the central drive
 * policy (project scope, privilege cap, worktree cap), send idempotency, and the
 * interrupt no-active-turn no-op.
 */
import type { OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import { makeThreadWriteTools } from "./threadWriteTools.ts";
import { errorText } from "./toolInput.ts";
import type { ToolContext } from "./toolRuntime.ts";

const CALLER_THREAD = "thread-caller";
const TARGET_THREAD = "thread-target";
const CALLER_PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const ISO = "2026-01-01T00:00:00.000Z";

type Capability = "thread:read" | "thread:write" | "automation:write";

// Captured dispatch commands are asserted structurally; a broad type keeps the
// test focused on the runtime shape the gateway emits.
type AnyCommand = Record<string, any>;

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

function makeEngine(options?: { readonly failWith?: string }): {
  readonly engine: OrchestrationEngineShape;
  readonly commands: AnyCommand[];
} {
  const commands: AnyCommand[] = [];
  const engine = {
    dispatch: (command: AnyCommand) => {
      commands.push(command);
      if (options?.failWith !== undefined) return Effect.fail(new Error(options.failWith));
      return Effect.succeed({ sequence: commands.length });
    },
  } as unknown as OrchestrationEngineShape;
  return { engine, commands };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    callerThreadId: CALLER_THREAD,
    callerProjectId: CALLER_PROJECT,
    callerSessionKey: "gateway-session:test",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set<Capability>(["thread:read", "thread:write"]),
    callerTurnId: "turn-caller",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
    ...overrides,
  };
}

interface Setup {
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    context?: ToolContext,
  ) => Promise<McpToolCallResult>;
  readonly commands: AnyCommand[];
}

function setup(options?: {
  readonly threadShells?: Record<string, OrchestrationThreadShell>;
  readonly caller?: OrchestrationThreadShell;
  readonly failDispatchWith?: string;
  readonly randomId?: () => string;
}): Setup {
  const caller = options?.caller ?? shell(CALLER_THREAD);
  const threadShells: Record<string, OrchestrationThreadShell> = {
    [CALLER_THREAD]: caller,
    ...options?.threadShells,
  };
  const snapshotQuery = makeSnapshotQuery(threadShells);
  const { engine, commands } = makeEngine(
    options?.failDispatchWith !== undefined ? { failWith: options.failDispatchWith } : {},
  );
  const requireThreadShell = (id: string) => {
    const found = threadShells[id];
    return found ? Effect.succeed(found) : Effect.fail(new Error(`Thread "${id}" was not found.`));
  };
  const tools = makeThreadWriteTools({
    snapshotQuery,
    orchestrationEngine: engine,
    requireThreadShell,
    now: () => ISO,
    randomId: options?.randomId ?? (() => "rand-id"),
  });
  const call = (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext = makeContext(),
  ) => {
    const tool = tools.find((entry) => entry.definition.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    // Mirror the transport's defect net: a thrown ToolInputError is a defect,
    // not an Effect failure, so unit calls must catch defects too.
    return Effect.runPromise(
      tool
        .handler(args, context)
        .pipe(
          Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
        ),
    );
  };
  return { call, commands };
}

function jsonBody(result: McpToolCallResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("synara_send_message", () => {
  it("dispatches a queued turn.start with the interim automation origin and target runtime", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { interactionMode: "plan" }) },
    });
    const result = await call("synara_send_message", {
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
    expect(command.dispatchOrigin).toBe("automation");
    expect(command.runtimeMode).toBe("full-access");
    expect(command.interactionMode).toBe("plan");
    expect(command.createdAt).toBe(ISO);
    expect(command.commandId).toBe("agent:rand-id:send");
    expect(command.message.messageId).toBe("agent:rand-id:message");
  });

  it("passes steer mode through to the dispatch", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    const body = jsonBody(
      await call("synara_send_message", {
        threadId: TARGET_THREAD,
        message: "redirect",
        mode: "steer",
      }),
    );
    expect(body.dispatched).toBe("steer");
    expect(commands[0].dispatchMode).toBe("steer");
  });

  it("rejects an invalid mode", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    const result = await call("synara_send_message", {
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
      await call("synara_send_message", {
        threadId: TARGET_THREAD,
        message: "once",
        requestId: "req-1",
      }),
    );
    const second = jsonBody(
      await call("synara_send_message", {
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
    // Idempotent sends derive a deterministic command id from the request id.
    expect(commands[0].commandId).toBe(`agent:${CALLER_THREAD}:req-1:send`);
    expect(commands[0].message.messageId).toBe(`agent:${CALLER_THREAD}:req-1:message`);
  });

  it("dispatches separately for distinct requestIds", async () => {
    const { call, commands } = setup({ threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) } });
    await call("synara_send_message", { threadId: TARGET_THREAD, message: "a", requestId: "r-a" });
    await call("synara_send_message", { threadId: TARGET_THREAD, message: "b", requestId: "r-b" });
    expect(commands).toHaveLength(2);
  });

  it("does not share dedup across caller threads", async () => {
    const other = shell("thread-caller-2");
    const { call, commands } = setup({
      threadShells: { "thread-caller-2": other, [TARGET_THREAD]: shell(TARGET_THREAD) },
    });
    await call("synara_send_message", { threadId: TARGET_THREAD, message: "a", requestId: "same" });
    await call(
      "synara_send_message",
      { threadId: TARGET_THREAD, message: "a", requestId: "same" },
      makeContext({ callerThreadId: "thread-caller-2" }),
    );
    expect(commands).toHaveLength(2);
  });

  it("denies a cross-project send as thread_not_found without dispatching", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { projectId: OTHER_PROJECT }) },
    });
    const result = await call("synara_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });

  it("denies driving a higher-privileged target (privilege cap)", async () => {
    const { call, commands } = setup({
      caller: shell(CALLER_THREAD, { runtimeMode: "approval-required" }),
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { runtimeMode: "full-access" }) },
    });
    const result = await call("synara_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("capability_denied");
    expect(commands).toHaveLength(0);
  });

  it("denies a worktree caller driving a local target (worktree cap)", async () => {
    const { call, commands } = setup({
      caller: shell(CALLER_THREAD, { envMode: "worktree" }),
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD, { envMode: "local" }) },
    });
    const result = await call("synara_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("capability_denied");
    expect(commands).toHaveLength(0);
  });

  it("reports thread_not_found for a missing target", async () => {
    const { call, commands } = setup();
    const result = await call("synara_send_message", { threadId: "ghost", message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });

  it("surfaces a dispatch failure as operation_failed", async () => {
    const { call } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      failDispatchWith: "engine boom",
    });
    const result = await call("synara_send_message", { threadId: TARGET_THREAD, message: "x" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("operation_failed");
  });

  it("does not remember a failed dispatch for later replay", async () => {
    const { call, commands } = setup({
      threadShells: { [TARGET_THREAD]: shell(TARGET_THREAD) },
      failDispatchWith: "engine boom",
    });
    await call("synara_send_message", { threadId: TARGET_THREAD, message: "x", requestId: "r" });
    await call("synara_send_message", { threadId: TARGET_THREAD, message: "x", requestId: "r" });
    // Both attempts dispatch: a failure is retryable, never cached as success.
    expect(commands).toHaveLength(2);
  });
});

describe("synara_interrupt_thread", () => {
  it("interrupts a running turn, pinned to the observed turn id", async () => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          latestTurn: { turnId: "turn-x", state: "running" },
        }),
      },
    });
    const body = jsonBody(await call("synara_interrupt_thread", { threadId: TARGET_THREAD }));
    expect(body).toEqual({ threadId: TARGET_THREAD, interrupted: true, turnId: "turn-x" });
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("thread.turn.interrupt");
    expect(commands[0].threadId).toBe(TARGET_THREAD);
    expect(commands[0].turnId).toBe("turn-x");
    expect(commands[0].commandId).toBe(`agent:${TARGET_THREAD}:turn-x:interrupt`);
    expect(commands[0].createdAt).toBe(ISO);
  });

  it("is a no-op when the target has no running turn", async () => {
    const { call, commands } = setup({
      threadShells: {
        [TARGET_THREAD]: shell(TARGET_THREAD, {
          latestTurn: { turnId: "turn-x", state: "completed" },
        }),
      },
    });
    const body = jsonBody(await call("synara_interrupt_thread", { threadId: TARGET_THREAD }));
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
    const body = jsonBody(await call("synara_interrupt_thread", { threadId: TARGET_THREAD }));
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
    const result = await call("synara_interrupt_thread", { threadId: TARGET_THREAD });
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
    const result = await call("synara_interrupt_thread", { threadId: TARGET_THREAD });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("capability_denied");
    expect(commands).toHaveLength(0);
  });

  it("reports thread_not_found for a missing target", async () => {
    const { call, commands } = setup();
    const result = await call("synara_interrupt_thread", { threadId: "ghost" });
    expect(result.isError).toBe(true);
    expect((jsonBody(result).error as { code: string }).code).toBe("thread_not_found");
    expect(commands).toHaveLength(0);
  });
});

describe("makeThreadWriteTools", () => {
  it("exposes exactly the two drive tools, both requiring an active turn", () => {
    const tools = makeThreadWriteTools({
      snapshotQuery: makeSnapshotQuery({}),
      orchestrationEngine: makeEngine().engine,
      requireThreadShell: (id: string) => Effect.fail(new Error(id)),
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "synara_send_message",
      "synara_interrupt_thread",
    ]);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    // Drive tools must carry write annotations (not read-only).
    expect(tools.every((tool) => tool.definition.annotations?.readOnlyHint === false)).toBe(true);
  });
});
