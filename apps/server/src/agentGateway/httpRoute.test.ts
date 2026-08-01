// Integration test for the production agent-gateway `/mcp` Effect route.
// Boots the same `agentGatewayRouteLayer` that `makeEffectHttpRouteLayer` wires
// into `effectServer.ts` through a real HTTP listener, with fake credential and
// gateway services so the assertions isolate the route's own responsibilities:
// feature-flag gating (including GET/DELETE parity), bearer-check-before-body,
// the 1 MiB body cap, JSON parse handling, and spec method handling. The
// transport internals behind `handleMcpPost` are covered by mcpTransport.test.ts.
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { AGENT_GATEWAY_MCP_PATH } from "./Layers/AgentGatewayCredentials.ts";
import { AgentGateway, type AgentGatewayShape } from "./Services/AgentGateway.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "./Services/AgentGatewayCredentials.ts";
import { agentGatewayRouteLayer, AGENT_GATEWAY_MCP_MAX_BODY_BYTES } from "./httpRoute.ts";

const KNOWN_TOKEN = "sagw_session_known-token";

// The route only reads `config.agentGatewayEnabled`; everything else on the
// config is irrelevant to route behavior, so a minimal cast keeps the fixture
// focused on the flag under test.
function makeConfig(agentGatewayEnabled: boolean): ServerConfigShape {
  return { agentGatewayEnabled } as unknown as ServerConfigShape;
}

// verifySession is the only credential method the route calls; the deeper
// checks live in the faked handleMcpPost below.
function makeFakeCredentials(): AgentGatewayCredentialsShape {
  return {
    verifySession: (token: string) =>
      token === KNOWN_TOKEN
        ? {
            sessionKey: "gateway-session:known",
            threadId: "thread-1",
            provider: "claudeAgent",
            issuedAt: 0,
            capabilities: ["thread:read"],
          }
        : null,
  } as unknown as AgentGatewayCredentialsShape;
}

interface GatewayCall {
  readonly authorizationHeader: string | undefined;
  readonly body: unknown;
}

function makeFakeGateway(calls: GatewayCall[]): AgentGatewayShape {
  return {
    handleMcpPost: (input: GatewayCall) =>
      Effect.sync(() => {
        calls.push(input);
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: 1, result: { ok: true } },
        };
      }),
  } as unknown as AgentGatewayShape;
}

async function withGatewayServer(
  config: ServerConfigShape,
  calls: GatewayCall[],
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(agentGatewayRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(AgentGatewayCredentials, makeFakeCredentials()),
              Layer.succeed(AgentGateway, makeFakeGateway(calls)),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected effect server to expose an address");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const mcpUrl = (origin: string) => `${origin}${AGENT_GATEWAY_MCP_PATH}`;

describe("agentGatewayRouteLayer (feature flag disabled)", () => {
  const calls: GatewayCall[] = [];
  afterEach(() => {
    calls.length = 0;
  });

  it("returns 404 for POST/GET/DELETE so a disabled instance is indistinguishable from no route", async () => {
    await withGatewayServer(makeConfig(false), calls, async (origin) => {
      const post = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { ...bearer(KNOWN_TOKEN), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(post.status).toBe(404);

      const get = await fetch(mcpUrl(origin), { method: "GET" });
      expect(get.status).toBe(404);
      // Must not leak the "POST is the real verb" hint while disabled.
      expect(get.headers.get("allow")).toBeNull();

      const del = await fetch(mcpUrl(origin), { method: "DELETE" });
      expect(del.status).toBe(404);

      // Nothing reached the transport while disabled.
      expect(calls).toHaveLength(0);
    });
  });
});

describe("agentGatewayRouteLayer (feature flag enabled)", () => {
  const calls: GatewayCall[] = [];
  afterEach(() => {
    calls.length = 0;
  });

  it("rejects GET with 405 and advertises POST", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const response = await fetch(mcpUrl(origin), { method: "GET" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });
  });

  it("rejects DELETE with 405", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const response = await fetch(mcpUrl(origin), { method: "DELETE" });
      expect(response.status).toBe(405);
    });
  });

  it("returns 401 and does not dispatch when the bearer token is missing", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const response = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(response.status).toBe(401);
      const payload = (await response.json()) as { error?: { code?: number; message?: string } };
      expect(payload.error?.code).toBe(-32600);
      expect(payload.error?.message).toContain("caller_session_inactive");
      expect(calls).toHaveLength(0);
    });
  });

  it("returns 401 and does not dispatch when the bearer token is unknown", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const response = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { ...bearer("sagw_session_wrong"), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  });

  it("verifies the bearer token before reading the request body", async () => {
    // A syntactically invalid body must not change the outcome: auth happens
    // first, so the transport is never reached and no parse error surfaces.
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const response = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not json",
      });
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  });

  it("passes a parsed body and the authorization header to the transport on success", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const request = { jsonrpc: "2.0", id: 1, method: "ping" };
      const response = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { ...bearer(KNOWN_TOKEN), "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { result?: { ok?: boolean } };
      expect(payload.result?.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.authorizationHeader).toBe(`Bearer ${KNOWN_TOKEN}`);
      expect(calls[0]!.body).toEqual(request);
    });
  });

  it("returns 400 for an authenticated request with an invalid JSON body", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const response = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { ...bearer(KNOWN_TOKEN), "content-type": "application/json" },
        body: "{ not valid json",
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error?: { code?: number } };
      expect(payload.error?.code).toBe(-32700);
      expect(calls).toHaveLength(0);
    });
  });

  it("returns 413 when the request body exceeds the 1 MiB cap", async () => {
    await withGatewayServer(makeConfig(true), calls, async (origin) => {
      const oversized = "x".repeat(AGENT_GATEWAY_MCP_MAX_BODY_BYTES + 1);
      const response = await fetch(mcpUrl(origin), {
        method: "POST",
        headers: { ...bearer(KNOWN_TOKEN), "content-type": "application/json" },
        body: oversized,
      });
      expect(response.status).toBe(413);
      expect(calls).toHaveLength(0);
    });
  });
});
