/**
 * Transport-level tests for the agent gateway MCP HTTP handler.
 *
 * Exercises the per-request auth spine (bearer verify → thread-existence
 * recheck → provider-ownership recheck → capability gate → turn-active gate)
 * and JSON-RPC batch handling with hand-built fakes for the credential service,
 * the read-model snapshot query, and the tool set. No HTTP or Effect layers are
 * involved so each rule is asserted in isolation.
 */
import {
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import { mcpToolResultJson } from "./protocol.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import type { AgentGatewaySessionIdentity } from "./Services/AgentGatewaySessionRegistry.ts";
import { type ToolEntry } from "./toolRuntime.ts";

const CALLER_THREAD = "thread-caller";
const CALLER_PROJECT = "project-1";
const VALID_TOKEN = "sagw_session_valid";
const RUNNING_TURN = "turn-running";

type Capability = "thread:read" | "thread:write" | "automation:write";

function makeIdentity(overrides?: Partial<AgentGatewaySessionIdentity>): AgentGatewaySessionIdentity {
  return {
    sessionKey: "gateway-session:test",
    threadId: ThreadId.makeUnsafe(CALLER_THREAD),
    provider: "claudeAgent",
    issuedAt: 0,
    capabilities: new Set<Capability>(["thread:read"]),
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
}): AgentGatewayCredentialsShape {
  const session = cfg?.session === undefined ? makeIdentity() : cfg.session;
  return {
    verifySession: (token: string) => (token === VALID_TOKEN ? session : null),
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
  } as unknown as AgentGatewayCredentialsShape;
}

function makeSnapshotQuery(callerShell: Option.Option<OrchestrationThreadShell>): ProjectionSnapshotQueryShape {
  return {
    getThreadShellById: () => Effect.succeed(callerShell),
  } as unknown as ProjectionSnapshotQueryShape;
}

const echoTool: ToolEntry = {
  definition: {
    name: "synara_echo",
    description: "Echo the arguments back.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: (args) => Effect.succeed(mcpToolResultJson({ echoed: args })),
};

const writeTool: ToolEntry = {
  definition: {
    name: "synara_write_thing",
    description: "A write tool that requires an active turn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: () => Effect.succeed(mcpToolResultJson({ wrote: true })),
  requiresActiveTurn: true,
};

function makeTransport(cfg?: {
  readonly credentials?: AgentGatewayCredentialsShape;
  readonly callerShell?: Option.Option<OrchestrationThreadShell>;
  readonly requireShell?: OrchestrationThreadShell;
  readonly tools?: ReadonlyArray<ToolEntry>;
}) {
  const requireShell = cfg?.requireShell ?? makeShell();
  return makeAgentGatewayMcpTransport({
    credentials: cfg?.credentials ?? makeCredentials(),
    snapshotQuery: cfg?.callerShell !== undefined
      ? makeSnapshotQuery(cfg.callerShell)
      : makeSnapshotQuery(Option.some(makeShell())),
    tools: cfg?.tools ?? [echoTool, writeTool],
    instructions: "TEST_INSTRUCTIONS",
    requireThreadShell: () => Effect.succeed(requireShell),
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
  it("answers initialize with a negotiated protocol + synara serverInfo", async () => {
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
    const body = res.body as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("synara");
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
      "synara_echo",
      "synara_write_thing",
    ]);
  });

  it("dispatches a read tool call to its handler", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "synara_echo", arguments: { hello: "world" } },
      },
    });
    expect(res.status).toBe(200);
    expect(toolResultJson(res.body)).toEqual({ echoed: { hello: "world" } });
  });

  it("rejects an unknown tool with invalid params", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "synara_nope" },
      },
    });
    const body = res.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("synara_nope");
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
  it("denies a write tool for a read-only session", async () => {
    const res = await run(makeTransport(), {
      authorizationHeader: auth(VALID_TOKEN),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "synara_write_thing", arguments: {} },
      },
    });
    const parsed = toolResultJson(res.body) as { error: { code: string; details: { requiredCapability: string } } };
    expect(parsed.error.code).toBe("capability_denied");
    expect(parsed.error.details.requiredCapability).toBe("thread:write");
  });

  it("denies a write tool when the caller has the capability but no active turn", async () => {
    // Capability present, but the caller thread's latestTurn is not running, so
    // no write authority is bound at ingress → the turn-active gate fails.
    const res = await run(
      makeTransport({
        credentials: makeCredentials({
          session: makeIdentity({ capabilities: new Set<Capability>(["thread:read", "thread:write"]) }),
        }),
        callerShell: Option.some(makeShell({ latestTurn: null })),
      }),
      {
        authorizationHeader: auth(VALID_TOKEN),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "synara_write_thing", arguments: {} },
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
          session: makeIdentity({ capabilities: new Set<Capability>(["thread:read", "thread:write"]) }),
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
          params: { name: "synara_write_thing", arguments: {} },
        },
      },
    );
    expect(toolResultJson(res.body)).toEqual({ wrote: true });
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
          session: makeIdentity({ capabilities: new Set<Capability>(["thread:read", "thread:write"]) }),
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
          params: { name: "synara_write_thing", arguments: {} },
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
