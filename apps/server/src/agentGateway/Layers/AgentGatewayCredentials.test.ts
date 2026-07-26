import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveServerPaths,
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "../../config.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import {
  AGENT_GATEWAY_MCP_PATH,
  AgentGatewayCredentialsLive,
  makeAgentGatewayEndpoint,
  resolveAgentGatewayEndpointHost,
} from "./AgentGatewayCredentials.ts";

const THREAD = ThreadId.makeUnsafe("thread-1");
const TEST_PORT = 47_321;

describe("resolveAgentGatewayEndpointHost", () => {
  it("returns loopback when no host is configured", () => {
    expect(resolveAgentGatewayEndpointHost(undefined)).toBe("127.0.0.1");
  });

  it.each(["0.0.0.0", "::", "[::]"])("returns loopback for the wildcard host %s", (host) => {
    expect(resolveAgentGatewayEndpointHost(host)).toBe("127.0.0.1");
  });

  it("bracket-formats an explicit IPv6 host", () => {
    expect(resolveAgentGatewayEndpointHost("::1")).toBe("[::1]");
  });

  it("passes an explicit IPv4 host through unchanged", () => {
    expect(resolveAgentGatewayEndpointHost("192.168.1.5")).toBe("192.168.1.5");
  });
});

describe("makeAgentGatewayEndpoint", () => {
  it("builds a loopback mcp url with the given port when no host is configured", () => {
    const endpoint = makeAgentGatewayEndpoint(undefined, 3773);
    expect(endpoint.url).toBe(`http://127.0.0.1:3773${AGENT_GATEWAY_MCP_PATH}`);
  });

  it("uses the resolved host", () => {
    const endpoint = makeAgentGatewayEndpoint("192.168.1.5", 3773);
    expect(endpoint.url).toBe(`http://192.168.1.5:3773${AGENT_GATEWAY_MCP_PATH}`);
  });

  it("reflects a listening port set after construction", () => {
    const endpoint = makeAgentGatewayEndpoint(undefined, 3773);
    expect(endpoint.url.endsWith(":3773/mcp")).toBe(true);

    endpoint.setListeningPort(9999);

    expect(endpoint.url).toBe(`http://127.0.0.1:9999${AGENT_GATEWAY_MCP_PATH}`);
  });
});

describe("AgentGatewayCredentialsLive", () => {
  let root: string;
  let homeDir: string;
  let baseDir: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "agent-gateway-credentials-"));
    homeDir = path.join(root, "home");
    baseDir = path.join(homeDir, ".synara");
    cwd = path.join(root, "repo");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const makeConfigLayer = () =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const derived = yield* deriveServerPaths(baseDir, undefined);
        return {
          mode: "web",
          port: TEST_PORT,
          host: undefined,
          cwd,
          homeDir,
          chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir }),
          studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir }),
          baseDir,
          ...derived,
          staticDir: undefined,
          devUrl: undefined,
          noBrowser: true,
          authToken: undefined,
          autoBootstrapProjectFromCwd: false,
          logProviderEvents: false,
          logWebSocketEvents: false,
          agentGatewayEnabled: false,
        } satisfies ServerConfigShape;
      }),
    );

  // AgentGatewayCredentialsLive already composes its own AgentGatewaySessionRegistryLive
  // internally (see AgentGatewayCredentials.ts), so the only remaining requirement to
  // discharge here is ServerConfig (plus the platform services it needs to derive paths).
  const testLayer = () =>
    AgentGatewayCredentialsLive.pipe(
      Layer.provide(makeConfigLayer()),
      Layer.provide(NodeServices.layer),
    );

  const run = <A>(program: Effect.Effect<A, never, AgentGatewayCredentials>): Promise<A> =>
    Effect.runPromise(program.pipe(Effect.provide(testLayer())));

  it("mcpEndpointUrl resolves to loopback with the configured port", async () => {
    const url = await run(
      Effect.gen(function* () {
        const credentials = yield* AgentGatewayCredentials;
        return credentials.mcpEndpointUrl;
      }),
    );

    expect(url).toBe(`http://127.0.0.1:${TEST_PORT}${AGENT_GATEWAY_MCP_PATH}`);
  });

  it("issueSessionToken returns an opaque token", async () => {
    const token = await run(
      Effect.gen(function* () {
        const credentials = yield* AgentGatewayCredentials;
        return credentials.issueSessionToken(THREAD, "claudeAgent");
      }),
    );

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("verifySessionToken resolves an issued token back to its thread id", async () => {
    const threadId = await run(
      Effect.gen(function* () {
        const credentials = yield* AgentGatewayCredentials;
        const token = credentials.issueSessionToken(THREAD, "claudeAgent");
        return credentials.verifySessionToken(token);
      }),
    );

    expect(threadId).toBe(THREAD);
  });

  it("verifySessionToken returns null for an unknown token", async () => {
    const result = await run(
      Effect.gen(function* () {
        const credentials = yield* AgentGatewayCredentials;
        return credentials.verifySessionToken("bad");
      }),
    );

    expect(result).toBeNull();
  });

  it("connectionForThread returns the mcp endpoint url and a bearer token that verifies back to the thread", async () => {
    const result = await run(
      Effect.gen(function* () {
        const credentials = yield* AgentGatewayCredentials;
        const connection = credentials.connectionForThread(THREAD, "claudeAgent");
        return {
          url: connection.url,
          mcpEndpointUrl: credentials.mcpEndpointUrl,
          verifiedThreadId: credentials.verifySessionToken(connection.bearerToken),
        };
      }),
    );

    expect(result.url).toBe(result.mcpEndpointUrl);
    expect(result.verifiedThreadId).toBe(THREAD);
  });

  it("revokeSessionToken invalidates a previously issued bearer token", async () => {
    const verifiedAfterRevoke = await run(
      Effect.gen(function* () {
        const credentials = yield* AgentGatewayCredentials;
        const connection = credentials.connectionForThread(THREAD, "claudeAgent");
        credentials.revokeSessionToken(connection.bearerToken);
        return credentials.verifySessionToken(connection.bearerToken);
      }),
    );

    expect(verifiedAfterRevoke).toBeNull();
  });
});
