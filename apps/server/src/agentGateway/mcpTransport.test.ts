/**
 * Transport-level tests for the agent gateway MCP HTTP handler.
 *
 * Exercises the per-request auth spine (bearer verify → thread-existence
 * recheck → provider-ownership recheck → capability gate → turn-active gate)
 * and JSON-RPC batch handling with hand-built fakes for the credential service,
 * the read-model snapshot query, and the tool set. No HTTP or Effect layers are
 * involved so each rule is asserted in isolation.
 */
import { ProjectId, ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ScientOperationResultReceipt } from "../scientOperations/authority.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import { mcpToolResultJson } from "./protocol.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import type {
  AgentGatewaySessionIdentity,
  AgentGatewayWriteAuthority,
} from "./Services/AgentGatewaySessionRegistry.ts";
import {
  gatewayToolErrorResult,
  GatewayToolError,
  type ToolEntry,
  UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE,
} from "./toolRuntime.ts";

const CALLER_THREAD = "thread-caller";
const CALLER_PROJECT = "project-1";
const VALID_TOKEN = "sagw_session_valid";
const RUNNING_TURN = "turn-running";

function makeIdentity(
  overrides?: Partial<AgentGatewaySessionIdentity>,
): AgentGatewaySessionIdentity {
  return {
    sessionKey: "gateway-session:test",
    threadId: ThreadId.makeUnsafe(CALLER_THREAD),
    provider: "claudeAgent",
    issuedAt: 0,
    capabilities: ["project:context:read", "thread:read"],
    ...overrides,
  };
}

function makeShell(overrides?: Partial<Record<string, unknown>>): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(CALLER_THREAD),
    projectId: ProjectId.makeUnsafe(CALLER_PROJECT),
    modelSelection: { provider: "claudeAgent", model: "test-model" },
    session: { providerName: "claudeAgent", status: "running" },
    latestTurn: null,
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

function makeCredentials(cfg?: {
  readonly session?: AgentGatewaySessionIdentity | null;
  readonly writeAuthorityValid?: boolean;
  readonly acquireWriteLease?: AgentGatewayCredentialsShape["acquireWriteLease"];
  readonly verifySession?: (token: string) => AgentGatewaySessionIdentity | null;
  readonly subscribeSessionRevocations?: AgentGatewayCredentialsShape["subscribeSessionRevocations"];
}): AgentGatewayCredentialsShape {
  const session = cfg?.session === undefined ? makeIdentity() : cfg.session;
  return {
    verifySession:
      cfg?.verifySession ?? ((token: string) => (token === VALID_TOKEN ? session : null)),
    bindWriteAuthority: (token: string, turnId: string) =>
      token === VALID_TOKEN && session
        ? {
            sessionKey: session.sessionKey,
            threadId: session.threadId,
            provider: session.provider,
            turnId,
          }
        : null,
    verifyWriteAuthority: () => cfg?.writeAuthorityValid ?? true,
    acquireWriteLease:
      cfg?.acquireWriteLease ??
      ((authority: AgentGatewayWriteAuthority) =>
        cfg?.writeAuthorityValid === false
          ? null
          : { sessionKey: authority.sessionKey, release: () => undefined }),
    subscribeSessionRevocations: cfg?.subscribeSessionRevocations ?? (() => () => undefined),
  } as unknown as AgentGatewayCredentialsShape;
}

function makeSnapshotQuery(
  callerShell: Option.Option<OrchestrationThreadShell>,
): ProjectionSnapshotQueryShape {
  return {
    getThreadShellById: () => Effect.succeed(callerShell),
  } as unknown as ProjectionSnapshotQueryShape;
}

const echoTool: ToolEntry = {
  operation: "project.context.read",
  decodeInput: () => ({}),
  definition: {
    name: "scient_echo",
    description: "Echo the arguments back.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: (args) => Effect.succeed(mcpToolResultJson({ echoed: args })),
};

const writeTool: ToolEntry = {
  operation: "thread.message.send",
  decodeInput: () => ({ threadId: "thread-target", message: "test", mode: "queue" }),
  definition: {
    name: "scient_write_thing",
    description: "A write tool that requires an active turn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: () => Effect.succeed(mcpToolResultJson({ wrote: true })),
};

const defectTool: ToolEntry = {
  operation: "project.context.read",
  decodeInput: () => ({}),
  definition: {
    name: "scient_defect",
    description: "Throw an unexpected internal error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: () => Effect.die(new Error("SECRET=sk-sentinel path=/Users/alice/private/.env")),
};

const envelopeTool: ToolEntry = {
  operation: "project.context.read",
  decodeInput: () => ({}),
  definition: {
    name: "scient_envelope",
    description: "Return non-secret operation-envelope fields for testing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
  handler: (_args, context) =>
    Effect.succeed(
      mcpToolResultJson({
        operationId: context.operationEnvelope.operationId,
        operation: context.operationEnvelope.operation,
        capability: context.operationEnvelope.capability,
        projectId: context.operationEnvelope.projectId,
        actorKind: context.operationEnvelope.authority.actor.kind,
        authorityGeneration: context.operationEnvelope.authority.generation,
        ingress: context.operationEnvelope.ingress,
        payloadFingerprint: context.operationEnvelope.idempotency.payloadFingerprint,
      }),
    ),
};

const normalizedWriteEnvelopeTool: ToolEntry = {
  operation: "thread.message.send",
  decodeInput: (args) => ({
    threadId: "thread-target",
    message: String(args.message).trim(),
    mode: args.mode ?? "queue",
    requestId: String(args.requestId).trim(),
  }),
  definition: {
    name: "scient_normalized_write_envelope",
    description: "Expose normalized operation evidence for testing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
  handler: (args, context) =>
    Effect.succeed(
      mcpToolResultJson({
        args: { message: args.message, mode: args.mode },
        identity: context.operationEnvelope.idempotency.identity,
        claimKey: context.operationEnvelope.idempotency.claimKey,
        payloadFingerprint: context.operationEnvelope.idempotency.payloadFingerprint,
      }),
    ),
};

function makeTransport(cfg?: {
  readonly credentials?: AgentGatewayCredentialsShape;
  readonly callerShell?: Option.Option<OrchestrationThreadShell>;
  readonly requireShell?: OrchestrationThreadShell;
  readonly tools?: ReadonlyArray<ToolEntry>;
  readonly randomId?: () => string;
  readonly recordOperationReceipt?: (receipt: ScientOperationResultReceipt) => void;
}) {
  const requireShell = cfg?.requireShell ?? makeShell();
  return makeAgentGatewayMcpTransport({
    credentials: cfg?.credentials ?? makeCredentials(),
    snapshotQuery:
      cfg?.callerShell !== undefined
        ? makeSnapshotQuery(cfg.callerShell)
        : makeSnapshotQuery(Option.some(makeShell())),
    tools: cfg?.tools ?? [echoTool, writeTool],
    instructions: "TEST_INSTRUCTIONS",
    requireThreadShell: () => Effect.succeed(requireShell),
    ...(cfg?.randomId === undefined ? {} : { randomId: cfg.randomId }),
    ...(cfg?.recordOperationReceipt === undefined
      ? {}
      : { recordOperationReceipt: cfg.recordOperationReceipt }),
  });
}

function run(
  transport: ReturnType<typeof makeAgentGatewayMcpTransport>,
  input: { authorizationHeader: string | undefined; body: unknown },
) {
  return Effect.runPromise(transport(input));
}

const auth = (token: string) => `Bearer ${token}`;

function toolResultJson(response: unknown): Record<string, unknown> {
  const result = (response as { result: { content: Array<{ text: string }> } }).result;
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("makeAgentGatewayMcpTransport ingress auth", () => {
  it("401s when no bearer token is present", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: undefined,
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("caller_session_inactive");
  });

  it("401s when the token does not resolve to a session", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth("sagw_session_bogus"),
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(res.status).toBe(401);
  });

  it("401s when the caller thread no longer exists", async () => {
    const res = await run(makeTransport({ callerShell: Option.none() }), {
      authorizationHeader: auth(VALID_TOKEN),
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("no longer exists");
  });

  it("401s when the provider no longer owns the caller thread", async () => {
    const res = await run(
      makeTransport({
        callerShell: Option.some(
          makeShell({ session: { providerName: "codex", status: "running" } }),
        ),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      },
    );
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("no longer owns");
  });

  it("falls back to modelSelection.provider when the session is not yet attached", async () => {
    // A thread whose session row has no providerName still matches when the
    // configured model provider matches the session credential.
    const res = await run(
      makeTransport({
        callerShell: Option.some(makeShell({ session: null })),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("makeAgentGatewayMcpTransport JSON-RPC handling", () => {
  it("answers initialize with a negotiated protocol + Scient serverInfo", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("scient");
    expect(body.result.instructions).toBe("TEST_INSTRUCTIONS");
  });

  it("answers ping with an empty result", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: { jsonrpc: "2.0", id: 7, method: "ping" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("lists the registered tool definitions", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    const body = res.body as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "scient_echo",
      "scient_write_thing",
    ]);
  });

  it("dispatches a read tool call to its handler", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "scient_echo", arguments: { hello: "world" } },
      },
    });
    expect(res.status).toBe(200);
    expect(toolResultJson(res.body)).toEqual({ echoed: {} });
  });

  it("provides a host-resolved operation envelope to the handler", async () => {
    const res = await run(
      makeTransport({ tools: [envelopeTool], randomId: () => "operation-random" }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: { name: "scient_envelope", arguments: { z: 1, a: "two" } },
        },
      },
    );
    expect(toolResultJson(res.body)).toMatchObject({
      operationId: "scient-operation:operation-random",
      operation: "project.context.read",
      capability: "project:context:read",
      projectId: CALLER_PROJECT,
      actorKind: "provider-thread",
      authorityGeneration: "gateway-session:test",
      ingress: "provider-gateway",
    });
    expect(String(toolResultJson(res.body).payloadFingerprint)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fingerprints canonical operation input and never retains the raw semantic request id", async () => {
    const runningShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
      session: { providerName: "claudeAgent", status: "running" },
    });
    const transport = makeTransport({
      credentials: makeCredentials({
        session: makeIdentity({ capabilities: ["thread:drive"] }),
      }),
      callerShell: Option.some(runningShell),
      requireShell: runningShell,
      tools: [normalizedWriteEnvelopeTool],
    });
    let requestNumber = 0;
    const call = (message: string, mode?: "queue") =>
      run(transport, {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: ++requestNumber,
          method: "tools/call",
          params: {
            name: "scient_normalized_write_envelope",
            arguments: {
              message,
              ...(mode === undefined ? {} : { mode }),
              requestId: "  secret/path/retry-id  ",
            },
          },
        },
      });
    const first = toolResultJson((await call("  hello  ")).body);
    const retry = toolResultJson((await call("hello", "queue")).body);

    expect(first.args).toEqual({
      message: "hello",
      mode: "queue",
    });
    expect(first.payloadFingerprint).toBe(retry.payloadFingerprint);
    expect(first.claimKey).toBe(retry.claimKey);
    expect(first.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("secret/path/retry-id");
  });

  it("does not reflect unexpected handler diagnostics to the provider", async () => {
    const protectedLogs: string[] = [];
    const logSpy = vi.spyOn(console, "error").mockImplementation((line) => {
      protectedLogs.push(String(line));
    });
    const res = await run(makeTransport({ tools: [defectTool] }), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "scient_defect", arguments: {} },
      },
    }).finally(() => logSpy.mockRestore());
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).toContain(UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE);
    expect(serialized).not.toContain("sk-sentinel");
    expect(serialized).not.toContain("/Users/alice/private/.env");
    expect(protectedLogs.join("\n")).toContain('toolName="scient_defect"');
    expect(protectedLogs.join("\n")).toContain("[redacted]");
    expect(protectedLogs.join("\n")).toContain("[redacted-path]");
    expect(protectedLogs.join("\n")).not.toContain("/Users/alice/private/.env");
    expect(protectedLogs.join("\n")).not.toContain("sk-sentinel");
  });

  it("rejects an unknown tool with invalid params", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "scient_nope" },
      },
    });
    const body = res.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("scient_nope");
  });

  it("rejects a tools/call with a non-string tool name", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: 42 },
      },
    });
    const body = res.body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it("returns method-not-found for an unsupported method", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: { jsonrpc: "2.0", id: 6, method: "resources/list" },
    });
    const body = res.body as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});

describe("makeAgentGatewayMcpTransport capability + turn gates", () => {
  it("uses explicit operation metadata rather than inferring capability from the tool name", async () => {
    const automationNamedReadTool: ToolEntry = {
      ...echoTool,
      definition: { ...echoTool.definition, name: "scient_automation_status" },
    };
    const res = await run(makeTransport({ tools: [automationNamedReadTool] }), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scient_automation_status", arguments: {} },
      },
    });
    expect(toolResultJson(res.body)).toEqual({ echoed: {} });
  });

  it("denies a read operation when only drive capability is present", async () => {
    const res = await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({
            capabilities: ["thread:drive"],
          }),
        }),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scient_echo", arguments: {} },
        },
      },
    );
    expect(toolResultJson(res.body)).toMatchObject({
      error: {
        code: "capability_denied",
        details: { requiredCapability: "project:context:read" },
      },
    });
  });

  it("rejects authority revoked after ingress but before handler dispatch", async () => {
    const session = makeIdentity();
    let verificationCount = 0;
    const res = await run(
      makeTransport({
        credentials: makeCredentials({
          verifySession: (token) => {
            verificationCount += 1;
            return token === VALID_TOKEN && verificationCount === 1 ? session : null;
          },
        }),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scient_echo", arguments: {} },
        },
      },
    );
    expect(toolResultJson(res.body)).toMatchObject({
      error: { code: "caller_session_inactive" },
    });
  });

  it("rejects a caller whose project scope changes after ingress", async () => {
    const res = await run(
      makeTransport({ requireShell: makeShell({ projectId: ProjectId.makeUnsafe("project-2") }) }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scient_echo", arguments: {} },
        },
      },
    );
    expect(toolResultJson(res.body)).toMatchObject({
      error: { code: "caller_session_inactive" },
    });
  });

  it("denies a write tool for a read-only session", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scient_write_thing", arguments: {} },
      },
    });
    const parsed = toolResultJson(res.body) as {
      error: { code: string; details: { requiredCapability: string } };
    };
    expect(parsed.error.code).toBe("capability_denied");
    expect(parsed.error.details.requiredCapability).toBe("thread:drive");
  });

  it("denies a write tool when the caller has the capability but no active turn", async () => {
    // Capability present, but the caller thread's latestTurn is not running, so
    // no write authority is bound at ingress → the turn-active gate fails.
    const res = await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({
            capabilities: ["thread:read", "thread:drive"],
          }),
        }),
        callerShell: Option.some(makeShell({ latestTurn: null })),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );
    const parsed = toolResultJson(res.body) as { error: { code: string } };
    expect(parsed.error.code).toBe("caller_turn_inactive");
  });

  it("allows a write tool when capability + a live pinned turn are present", async () => {
    const runningShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
      session: { providerName: "claudeAgent", status: "running" },
    });
    const res = await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({
            capabilities: ["thread:read", "thread:drive"],
          }),
          writeAuthorityValid: true,
        }),
        callerShell: Option.some(runningShell),
        requireShell: runningShell,
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );
    expect(toolResultJson(res.body)).toEqual({ wrote: true });
  });

  it("cancels a long read on exact revocation, returns no stale result, and unsubscribes", async () => {
    let revocationListener: ((identity: AgentGatewaySessionIdentity) => void) | undefined;
    let activeListeners = 0;
    let handlerStarted = false;
    let handlerInterrupted = false;
    const longRead: ToolEntry = {
      ...echoTool,
      definition: { ...echoTool.definition, name: "scient_long_read" },
      handler: () =>
        Effect.sync(() => {
          handlerStarted = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              handlerInterrupted = true;
            }),
          ),
        ),
    };
    const session = makeIdentity();
    const response = run(
      makeTransport({
        credentials: makeCredentials({
          session,
          subscribeSessionRevocations: (listener) => {
            activeListeners += 1;
            revocationListener = listener;
            return () => {
              activeListeners -= 1;
              revocationListener = undefined;
            };
          },
        }),
        tools: [longRead],
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 54,
          method: "tools/call",
          params: { name: "scient_long_read", arguments: {} },
        },
      },
    );

    await vi.waitFor(() => {
      expect(handlerStarted).toBe(true);
      expect(activeListeners).toBe(1);
    });
    revocationListener!(session);

    const result = await response;
    expect(handlerInterrupted).toBe(true);
    expect(activeListeners).toBe(0);
    expect(toolResultJson(result.body)).toMatchObject({
      error: { code: "caller_session_inactive" },
    });
    expect(JSON.stringify(result.body)).not.toContain("echoed");
  });

  it("denies a transactional write when revocation wins before lease acquisition", async () => {
    const runningShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
      session: { providerName: "claudeAgent", status: "running" },
    });
    const receipts: ScientOperationResultReceipt[] = [];
    const result = await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({ capabilities: ["thread:drive"] }),
          writeAuthorityValid: true,
          acquireWriteLease: () => null,
        }),
        callerShell: Option.some(runningShell),
        requireShell: runningShell,
        tools: [writeTool],
        recordOperationReceipt: (receipt) => receipts.push(receipt),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 53,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );

    expect(toolResultJson(result.body)).toMatchObject({
      error: { code: "caller_session_inactive" },
    });
    expect(receipts[0]).toMatchObject({
      outcome: "failed",
      errorCode: "caller_session_inactive",
      effects: [],
    });
  });

  it("preserves a typed handler error code in the operation receipt", async () => {
    const runningShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
      session: { providerName: "claudeAgent", status: "running" },
    });
    const receipts: ScientOperationResultReceipt[] = [];
    const deniedWrite: ToolEntry = {
      ...writeTool,
      handler: () =>
        Effect.succeed(
          gatewayToolErrorResult(new GatewayToolError("policy_denied", "Policy denied.")),
        ),
    };
    await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({ capabilities: ["thread:drive"] }),
        }),
        callerShell: Option.some(runningShell),
        requireShell: runningShell,
        tools: [deniedWrite],
        recordOperationReceipt: (receipt) => receipts.push(receipt),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 52,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );

    expect(receipts[0]).toMatchObject({
      outcome: "failed",
      errorCode: "policy_denied",
      effects: [],
    });
  });

  it("records a typed uncertain handler outcome even when no effect identity was recovered", async () => {
    const runningShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
      session: { providerName: "claudeAgent", status: "running" },
    });
    const receipts: ScientOperationResultReceipt[] = [];
    const uncertainWrite: ToolEntry = {
      ...writeTool,
      handler: () =>
        Effect.succeed(
          gatewayToolErrorResult(
            new GatewayToolError(
              "operation_outcome_uncertain",
              "Reconcile the target before retrying.",
            ),
          ),
        ),
    };
    await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({ capabilities: ["thread:drive"] }),
        }),
        callerShell: Option.some(runningShell),
        requireShell: runningShell,
        tools: [uncertainWrite],
        recordOperationReceipt: (receipt) => receipts.push(receipt),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 57,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );

    expect(receipts[0]).toMatchObject({
      outcome: "uncertain/reconciliation-required",
      errorCode: "operation_outcome_uncertain",
      effects: [],
    });
  });

  it("lets a write lease acquired before revocation finish with a truthful success receipt", async () => {
    let revoked = false;
    let handlerStarted = false;
    let finishHandler!: () => void;
    const handlerCanFinish = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    const receipts: ScientOperationResultReceipt[] = [];
    const fencedWriteTool: ToolEntry = {
      ...writeTool,
      handler: (_args, context) =>
        Effect.sync(() => {
          handlerStarted = true;
          context.recordOperationEffect({
            kind: "orchestration-command",
            identity: "command-committed-before-revoke",
          });
        }).pipe(
          Effect.andThen(Effect.promise(() => handlerCanFinish)),
          Effect.andThen(Effect.succeed(mcpToolResultJson({ wrote: true }))),
        ),
    };
    const runningShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
      session: { providerName: "claudeAgent", status: "running" },
    });
    const session = makeIdentity({ capabilities: ["thread:read", "thread:drive"] });
    const response = run(
      makeTransport({
        credentials: makeCredentials({
          session,
          writeAuthorityValid: true,
          verifySession: (token) => (token === VALID_TOKEN && !revoked ? session : null),
        }),
        callerShell: Option.some(runningShell),
        requireShell: runningShell,
        tools: [fencedWriteTool],
        recordOperationReceipt: (receipt) => receipts.push(receipt),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 55,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );

    await vi.waitFor(() => {
      expect(handlerStarted).toBe(true);
    });
    revoked = true;
    finishHandler();

    const result = await response;
    expect(toolResultJson(result.body)).toEqual({ wrote: true });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      outcome: "succeeded",
      errorCode: null,
      effects: [{ identity: "command-committed-before-revoke" }],
    });

    const denied = await run(
      makeTransport({
        credentials: makeCredentials({
          session,
          verifySession: (token) => (token === VALID_TOKEN && !revoked ? session : null),
        }),
        callerShell: Option.some(runningShell),
        requireShell: runningShell,
        tools: [fencedWriteTool],
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 56,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );
    expect(denied.status).toBe(401);
  });

  it("rejects a write tool when the pinned turn has been superseded", async () => {
    // Turn is running at ingress (authority binds) but requireThreadShell later
    // reports a different latest turn → recheck-after-dispatch style TOCTOU deny.
    const ingressShell = makeShell({
      latestTurn: { turnId: RUNNING_TURN, state: "running" },
    });
    const supersededShell = makeShell({
      latestTurn: { turnId: "turn-newer", state: "running" },
    });
    const res = await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({
            capabilities: ["thread:read", "thread:drive"],
          }),
          writeAuthorityValid: true,
        }),
        callerShell: Option.some(ingressShell),
        requireShell: supersededShell,
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scient_write_thing", arguments: {} },
        },
      },
    );
    const parsed = toolResultJson(res.body) as { error: { code: string } };
    expect(parsed.error.code).toBe("caller_turn_inactive");
  });
});

describe("makeAgentGatewayMcpTransport batch handling", () => {
  it("400s on an empty batch", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: [],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Empty JSON-RPC batch");
  });

  it("400s when the batch exceeds the message cap", async () => {
    const body = Array.from({ length: 51 }, (_unused, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "ping",
    }));
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("at most 50");
  });

  it("400s on duplicate request ids in one batch", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 1, method: "ping" },
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Duplicate JSON-RPC request id");
  });

  it("returns an array body for an array request and answers each request", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ],
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<{ id: number }>).map((entry) => entry.id)).toEqual([1, 2]);
  });

  it("returns 202 with no body for a notification-only batch", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeUndefined();
  });

  it("emits an invalid-request error for a malformed entry", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: [{ jsonrpc: "1.0", id: 9, method: "ping" }],
    });
    expect(res.status).toBe(200);
    const body = res.body as Array<{ error: { code: number } }>;
    expect(body[0]!.error.code).toBe(-32600);
  });
});
