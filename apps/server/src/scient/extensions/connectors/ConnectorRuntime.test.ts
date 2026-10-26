// @effect-diagnostics nodeBuiltinImport:off -- Tests run a real local MCP server and authorization server.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  type ConnectorId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VaultSecretRef,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/http";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import type { McpThreadInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import { type ProjectRow, ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ConnectorRuntime } from "../ExtensionsServices.ts";
import * as PluginConnectorEligibility from "../plugins/PluginConnectorEligibility.ts";
import * as ConnectorCallbackRoute from "./ConnectorCallbackRoute.ts";
import * as ConnectorCredentialStore from "./ConnectorCredentialStore.ts";
import {
  ConnectorOAuthError,
  ConnectorOAuthFlows,
  type ConnectorOAuthMaterial,
  decodeOAuthMaterial,
  encodeOAuthMaterial,
} from "./ConnectorOAuth.ts";
import { controlFetch, egressPolicyFor, STRICT_EGRESS_POLICY } from "./ConnectorOutbound.ts";
import { probeConnector } from "./ConnectorProbe.ts";
import * as ConnectorProxyRoute from "./ConnectorProxyRoute.ts";
import { makeConnectorRuntime, MAX_IN_FLIGHT_PER_CONNECTOR } from "./ConnectorRuntime.ts";
import { CONNECTOR_STATE_FILE } from "./ConnectorStateStore.ts";

/**
 * A fake vendor: MCP endpoints without auth, behind OAuth (with and without
 * protected-resource metadata), and its authorization server. A second origin
 * stands in for an internal service a malicious vendor might point at.
 */
interface UpstreamRequest {
  readonly path: string;
  readonly method: string;
  readonly authorization: string;
  readonly session: string | undefined;
}

interface Gate {
  gate: Promise<void> | undefined;
  arrived: (() => void) | undefined;
}

interface FakeVendor {
  base: string;
  validTokens: Set<string>;
  accessTokenTtlSeconds: number;
  refreshMode: "ok" | "invalid_grant";
  refresh: Gate;
  exchange: Gate;
  /** Tokens the MCP endpoint refuses (even if valid); each refusal passes `refusing` first. */
  refusedTokens: Set<string>;
  refusing: Gate;
  refreshCount: number;
  registrations: Array<Record<string, unknown>>;
  tokenRequests: Array<Record<string, string>>;
  codes: Map<string, { challenge: string; redirectUri: string; resource: string | null }>;
  /** Requests that reached an authenticated MCP endpoint. */
  upstream: UpstreamRequest[];
  revocations: string[];
  expiredSessions: Set<string>;
  releaseSlow: (() => void) | undefined;
  openStreams: number;
  streamClosed: (() => void) | undefined;
  tokenSerial: number;
  revoked: (() => void) | undefined;
  /** Issue the next access and refresh tokens shorter than Scient accepts. */
  shortTokens: boolean;
  /** Access tokens in issue order, with the grant type that produced each. */
  issued: Array<{ readonly grant: string; readonly token: string }>;
}

let vendor: FakeVendor;
let server: NodeHttp.Server;
let internalServer: NodeHttp.Server;
let internalBase: string;
const internalRequests: string[] = [];

const readBody = (request: NodeHttp.IncomingMessage) => {
  const { promise, resolve } = Promise.withResolvers<string>();
  let data = "";
  request.on("data", (chunk) => (data += chunk));
  request.on("end", () => resolve(data));
  return promise;
};

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const issueTokens = (response: NodeHttp.ServerResponse, ttl: number, grant: string) => {
  vendor.tokenSerial += 1;
  const accessToken = vendor.shortTokens
    ? `short-${vendor.tokenSerial}`
    : `vendor-access-token-${vendor.tokenSerial}`;
  vendor.validTokens.add(accessToken);
  vendor.issued.push({ grant, token: accessToken });
  json(response, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: vendor.shortTokens
      ? `rshort-${vendor.tokenSerial}`
      : `vendor-refresh-token-${vendor.tokenSerial}`,
    scope: "read",
  });
};

const passGate = async (gate: Gate) => {
  gate.arrived?.();
  if (gate.gate) await gate.gate;
};

const authServerMetadata = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${vendor.base}/as/authorize`,
  token_endpoint: `${vendor.base}/as/token`,
  registration_endpoint: `${vendor.base}/as/register`,
  revocation_endpoint: `${vendor.base}/as/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
});

const sse = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

const handleMcp = async (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  challenge: string | undefined,
) => {
  const authorization = request.headers.authorization ?? "";
  const session = request.headers["mcp-session-id"] as string | undefined;
  if (challenge !== undefined) {
    const token = authorization.replace(/^Bearer /, "");
    if (vendor.refusedTokens.has(token)) await passGate(vendor.refusing);
    if (vendor.refusedTokens.has(token) || !vendor.validTokens.has(token)) {
      response.writeHead(401, { "www-authenticate": challenge });
      response.end();
      return;
    }
    vendor.upstream.push({
      path: request.url ?? "",
      method: request.method ?? "",
      authorization,
      session,
    });
  }
  if (session !== undefined && vendor.expiredSessions.has(session)) {
    response.writeHead(404);
    response.end("session expired");
    return;
  }
  if (request.method === "DELETE") {
    response.writeHead(200);
    response.end();
    return;
  }
  if (request.method === "GET") {
    if (challenge === undefined) {
      response.writeHead(405);
      response.end();
      return;
    }
    vendor.openStreams += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": open\n\n");
    response.on("close", () => {
      vendor.openStreams -= 1;
      vendor.streamClosed?.();
    });
    return;
  }
  const message = JSON.parse(await readBody(request)) as {
    id?: number;
    method: string;
    params?: { name?: string };
  };
  if (message.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  const result = (value: unknown) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      return json(
        response,
        200,
        result({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-vendor", version: "1.2.3" },
        }),
        { "mcp-session-id": "vendor-session", "mcp-protocol-version": "2025-11-25" },
      );
    case "tools/list":
      return json(
        response,
        200,
        result({
          tools: [
            {
              name: "search",
              description: `Search things (debug: ${authorization})`,
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        }),
      );
    case "tools/call": {
      const token = authorization.replace(/^Bearer /, "");
      switch (message.params?.name) {
        case "slow":
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }),
          );
          vendor.releaseSlow = () => response.end(sse(result({ content: [] })));
          return;
        case "echo-auth":
          // A vendor diagnostic that reflects the credential it received.
          return json(
            response,
            200,
            result({
              content: [
                {
                  type: "text",
                  text: `${authorization} ${Buffer.from(token).toString("base64")} ${encodeURIComponent(token)}`,
                },
              ],
            }),
            { "mcp-session-id": authorization, "x-debug-auth": authorization },
          );
        case "echo-encoded": {
          // Equivalent encodings of the credential, as a vendor diagnostic might produce.
          const unicode = [...token]
            .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
            .join("");
          const lowerPercent = `k=${[...token]
            .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
            .join("")}`;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            `{"jsonrpc":"2.0","id":${message.id},"result":{"content":[{"type":"text","text":"${unicode}"},{"type":"text","text":${JSON.stringify(lowerPercent)}},{"type":"text","text":${JSON.stringify(Buffer.from(`xy${token}`).toString("base64url"))}}],${JSON.stringify(token)}:true}}`,
          );
          return;
        }
        case "priming":
          // A resumable server's priming event (id, empty data), then the reply.
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`id: c1\r\nretry: 500\r\ndata:\r\n\r\n${sse(result({ content: [] }))}`);
          return;
        case "echo-number":
          // A structured result carrying the (digits-only) credential as a number.
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            `{"jsonrpc":"2.0","id":${message.id},"result":{"content":[],"structuredContent":{"n":${token}}}}`,
          );
          return;
        case "echo-version":
          // Date-shaped, but not a protocol version Scient knows.
          return json(response, 200, result({ content: [] }), {
            "mcp-protocol-version": "2026-10-21",
          });
        case "deny-echo":
          return json(response, 403, { error: `debug ${authorization}` });
        case "echo-sse-split": {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const text = sse(result({ content: [{ type: "text", text: authorization }] }));
          const middle = text.indexOf(token) + 6;
          response.write(text.slice(0, middle), () => response.end(text.slice(middle)));
          return;
        }
        default:
          return json(response, 200, result({ content: [{ type: "text", text: "found" }] }));
      }
    }
    default:
      return json(response, 200, result({}));
  }
};

const handleVendor = async (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
) => {
  const url = new URL(request.url ?? "/", vendor.base);
  if (url.pathname.startsWith("/secure/mcp")) {
    return handleMcp(
      request,
      response,
      `Bearer resource_metadata="${vendor.base}/.well-known/oauth-protected-resource/secure/mcp", scope="read"`,
    );
  }
  switch (url.pathname) {
    case "/open/mcp":
      return handleMcp(request, response, undefined);
    case "/noprm/mcp":
      return handleMcp(request, response, "Bearer");
    case "/pivot/mcp":
      return handleMcp(request, response, `Bearer resource_metadata="${internalBase}/prm"`);
    case "/.well-known/oauth-protected-resource/secure/mcp":
      return json(response, 200, {
        resource: `${vendor.base}/secure/mcp`,
        authorization_servers: [`${vendor.base}/as`],
        scopes_supported: ["read"],
      });
    case "/.well-known/oauth-authorization-server/as":
      return json(response, 200, authServerMetadata(`${vendor.base}/as`));
    case "/.well-known/oauth-authorization-server":
      return json(response, 200, authServerMetadata(vendor.base));
    case "/as/register": {
      const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
      vendor.registrations.push(metadata);
      return json(response, 201, {
        ...metadata,
        client_id: `client-${vendor.registrations.length}`,
        client_id_issued_at: 1,
      });
    }
    case "/as/token": {
      const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
      vendor.tokenRequests.push(form);
      if (form.grant_type === "authorization_code") {
        await passGate(vendor.exchange);
        const issued = vendor.codes.get(form.code ?? "");
        vendor.codes.delete(form.code ?? "");
        const challenge = NodeCrypto.createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (
          issued === undefined ||
          issued.challenge !== challenge ||
          issued.redirectUri !== form.redirect_uri ||
          issued.resource === null ||
          form.resource !== issued.resource
        ) {
          return json(response, 400, { error: "invalid_grant" });
        }
        return issueTokens(response, vendor.accessTokenTtlSeconds, "authorization_code");
      }
      if (form.grant_type === "refresh_token") {
        vendor.refreshCount += 1;
        await passGate(vendor.refresh);
        if (vendor.refreshMode === "invalid_grant" || form.resource === undefined) {
          return json(response, 400, { error: "invalid_grant" });
        }
        return issueTokens(response, 3600, "refresh_token");
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    case "/as/revoke": {
      vendor.revocations.push(new URLSearchParams(await readBody(request)).get("token") ?? "");
      vendor.revoked?.();
      response.writeHead(200);
      response.end();
      return;
    }
    default:
      response.writeHead(404);
      response.end();
  }
};

const resetVendor = (base: string): FakeVendor => ({
  base,
  validTokens: new Set(),
  accessTokenTtlSeconds: 3600,
  refreshMode: "ok",
  refresh: { gate: undefined, arrived: undefined },
  exchange: { gate: undefined, arrived: undefined },
  refusedTokens: new Set(),
  refusing: { gate: undefined, arrived: undefined },
  refreshCount: 0,
  registrations: [],
  tokenRequests: [],
  codes: new Map(),
  upstream: [],
  revocations: [],
  expiredSessions: new Set(),
  releaseSlow: undefined,
  openStreams: 0,
  streamClosed: undefined,
  tokenSerial: 0,
  shortTokens: false,
  revoked: undefined,
  issued: [],
});

const listen = async (target: NodeHttp.Server) => {
  const listening = Promise.withResolvers<void>();
  target.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = target.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${address.port}`;
};

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    void handleVendor(request, response);
  });
  vendor = resetVendor(await listen(server));
  internalServer = NodeHttp.createServer((request, response) => {
    internalRequests.push(`${request.method} ${request.url}`);
    json(response, 200, {
      resource: `${vendor.base}/pivot/mcp`,
      authorization_servers: [internalBase],
    });
  });
  internalBase = await listen(internalServer);
});

afterAll(async () => {
  for (const target of [server, internalServer]) {
    target.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    target.close(() => closed.resolve());
    await closed.promise;
  }
});

afterEach(() => {
  vendor = resetVendor(vendor.base);
  internalRequests.length = 0;
});

const PROJECT = ProjectId.make("project-a");
const OTHER_PROJECT = ProjectId.make("project-b");
const AGENT_TOKEN = "agent-session-token";
const OTHER_AGENT_TOKEN = "other-agent-session-token";
const CALLBACK_ORIGIN = "http://127.0.0.1:4777";

/** The projects that exist (not deleted) for availability validation. */
const existingProject = (projectId: ProjectId): ProjectRow => ({
  projectId,
  title: projectId,
  workspaceRoot: `/work/${projectId}`,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});
const EXISTING_PROJECTS = [PROJECT, OTHER_PROJECT].map(existingProject);

const testLayer = ConnectorCredentialStore.layer.pipe(
  Layer.provideMerge(PluginConnectorEligibility.layer),
  Layer.provideMerge(
    Layer.mock(ProjectStoreV2)({
      list: (options) =>
        Effect.succeed(
          EXISTING_PROJECTS.filter(
            (row) =>
              options?.projectIds === undefined || options.projectIds.includes(row.projectId),
          ),
        ),
    }),
  ),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-connectors-" })),
  Layer.provideMerge(NodeServices.layer),
);

const readJson = (response: Response) => Effect.promise(() => response.json());
const readText = (response: Response) => Effect.promise(() => response.text());
const gateOf = (gate: Gate) => {
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  gate.gate = release.promise;
  gate.arrived = arrived.resolve;
  return { arrived: arrived.promise, release: release.resolve };
};
const connectorSecrets = (config: ServerConfig.ServerConfig["Service"]) =>
  Effect.promise(async () =>
    (await NodeFSP.readdir(config.secretsDir)).filter((name) => name.startsWith("connector-")),
  );

const makeHarness = Effect.fn("makeHarness")(function* (
  options: {
    readonly seedStateFile?: string;
    /** Interposes on the credential port, for ordering tests. */
    readonly wrapCredentials?: (
      store: ConnectorCredentialStore.ConnectorCredentialStoreShape,
    ) => ConnectorCredentialStore.ConnectorCredentialStoreShape;
    /** Interposes on plugin eligibility (checked before a forward takes its credential). */
    readonly wrapEligibility?: (
      eligibility: PluginConnectorEligibility.PluginConnectorEligibilityShape,
    ) => PluginConnectorEligibility.PluginConnectorEligibilityShape;
    readonly onStreamClosed?: Effect.Effect<void>;
  } = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const statePath = NodePath.join(config.stateDir, CONNECTOR_STATE_FILE);
  const seed = options.seedStateFile;
  if (seed !== undefined) {
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(config.stateDir, { recursive: true });
      await NodeFSP.writeFile(statePath, seed);
    });
  }
  const credentialStore = yield* ConnectorCredentialStore.ConnectorCredentialStore;
  const eligibility = yield* PluginConnectorEligibility.PluginConnectorEligibility;
  const runtime = yield* makeConnectorRuntime({ stateDir: config.stateDir }).pipe(
    Effect.provideService(
      ConnectorCredentialStore.ConnectorCredentialStore,
      options.wrapCredentials?.(credentialStore) ?? credentialStore,
    ),
    Effect.provideService(
      PluginConnectorEligibility.PluginConnectorEligibility,
      options.wrapEligibility?.(eligibility) ?? eligibility,
    ),
  );

  const delivered = new Set<string>();
  let threadProject: ProjectId = PROJECT;
  const scope = (providerSessionId: string): McpThreadInvocationScope => ({
    environmentId: EnvironmentId.make("env-test"),
    capabilities: new Set(),
    issuedAt: 0,
    requestNamespace: providerSessionId,
    thread: {
      threadId: ThreadId.make(`thread-of-${providerSessionId}`),
      providerSessionId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    connectorIds: new Set(delivered),
  });
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        Layer.mergeAll(ConnectorProxyRoute.layer, ConnectorCallbackRoute.layer).pipe(
          Layer.provideMerge(
            Layer.succeed(ConnectorRuntime, {
              ...runtime,
              forward: (request) =>
                runtime.forward(request).pipe(
                  Effect.map((response) =>
                    request.method === "GET" &&
                    response.status === 200 &&
                    options.onStreamClosed !== undefined
                      ? {
                          ...response,
                          body: response.body.pipe(Stream.ensuring(options.onStreamClosed)),
                        }
                      : response,
                  ),
                ),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(McpSessionRegistry.McpSessionRegistry, {
              resolve: (token: string) =>
                Effect.succeed(
                  token === AGENT_TOKEN
                    ? scope("provider-session-a")
                    : token === OTHER_AGENT_TOKEN
                      ? scope("provider-session-b")
                      : undefined,
                ),
              touch: () => Effect.void,
            } as unknown as McpSessionRegistry.McpSessionRegistryShape),
          ),
          Layer.provideMerge(
            Layer.succeed(ThreadManagementService.ThreadManagementService, {
              getThreadShell: () => Effect.succeed({ projectId: threadProject }),
            } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  );
  const send = (request: Request) => Effect.promise(() => handler(request));

  const request = (
    connectorId: string,
    init: {
      readonly method?: string;
      readonly token?: string | null;
      readonly session?: string;
      readonly body?: string | ReadableStream<Uint8Array>;
    } = {},
  ) =>
    send(
      new Request(`http://scient.test/mcp/connectors/${connectorId}`, {
        method: init.method ?? "POST",
        headers: {
          ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? AGENT_TOKEN}` }),
          ...(init.session === undefined ? {} : { "mcp-session-id": init.session }),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
      }),
    );

  const proxy = (
    connectorId: string,
    body: unknown,
    init: { readonly token?: string | null; readonly session?: string } = {},
  ) => request(connectorId, { ...init, body: JSON.stringify(body) });

  /** Plays the user's browser: authorize at the fake AS, then follow the redirect to Scient. */
  const authorize = Effect.fn("authorize")(function* (connectorId: ConnectorId) {
    const started = yield* runtime.startSignIn({ connectorId, callbackOrigin: CALLBACK_ORIGIN });
    const authorizationUrl = new URL(started.authorizationUrl);
    const code = NodeCrypto.randomBytes(8).toString("hex");
    vendor.codes.set(code, {
      challenge: authorizationUrl.searchParams.get("code_challenge") ?? "",
      redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
      resource: authorizationUrl.searchParams.get("resource"),
    });
    const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
    callback.searchParams.set("code", code);
    return { authorizationUrl, callback };
  });

  const signIn = Effect.fn("signIn")(function* (connectorId: ConnectorId) {
    const { authorizationUrl, callback } = yield* authorize(connectorId);
    const response = yield* send(new Request(callback.href));
    return { authorizationUrl, callback, response };
  });

  const addSecure = Effect.fn("addSecure")(function* (path = "/secure/mcp") {
    const added = yield* runtime.add({
      target: { type: "url", url: `${vendor.base}${path}` },
      displayName: "Vendor",
    });
    delivered.add(added.connector.connectorId);
    return added;
  });

  /** Adds the OAuth connector, signs in, and returns its id. */
  const connectSecure = Effect.fn("connectSecure")(function* (path = "/secure/mcp") {
    const added = yield* addSecure(path);
    yield* signIn(added.connector.connectorId);
    return added.connector.connectorId;
  });

  return {
    config,
    runtime,
    send,
    request,
    proxy,
    authorize,
    signIn,
    addSecure,
    connectSecure,
    delivered,
    statePath,
    setThreadProject: (projectId: ProjectId) => {
      threadProject = projectId;
    },
  };
});

const toolCall = (id: number, name = "search") => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "agent", version: "1" },
  },
});

describe("connector probe", () => {
  it("tells an open MCP server from one that requires OAuth and reads its hints", async () => {
    const fetch = controlFetch(egressPolicyFor(`${vendor.base}/open/mcp`, { type: "url" }));
    const open = await probeConnector({ url: `${vendor.base}/open/mcp`, fetch });
    expect(open).toEqual({ type: "open", serverName: "fake-vendor", serverVersion: "1.2.3" });

    const secured = await probeConnector({ url: `${vendor.base}/secure/mcp`, fetch });
    expect(secured).toEqual({
      type: "auth-required",
      resourceMetadataUrl: new URL(
        `${vendor.base}/.well-known/oauth-protected-resource/secure/mcp`,
      ),
      scope: "read",
    });
  });

  it.live("refuses loopback for addresses the user did not type", () =>
    Effect.gen(function* () {
      const strict = yield* Effect.promise(() =>
        probeConnector({
          url: `${vendor.base}/open/mcp`,
          fetch: controlFetch(STRICT_EGRESS_POLICY),
        }),
      );
      expect(strict.type).toBe("unreachable");

      const harness = yield* makeHarness();
      const added = yield* harness.runtime.add({
        target: { type: "url", url: `${vendor.base}/open/mcp` },
      });
      expect(added.nextStep).toBe("ready");
      const registry = yield* Effect.exit(
        harness.runtime.add({
          target: {
            type: "registry",
            name: "io.test/vendor",
            version: "1.0.0",
            url: `${vendor.base}/open/mcp`,
          },
        }),
      );
      expect(Exit.isFailure(registry)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps the name and description of the Discover entry it was added from", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const added = yield* harness.runtime.add({
        target: { type: "url", url: `${vendor.base}/open/mcp` },
        displayName: "Vendor Docs",
        description: "Search the vendor's documentation.",
      });
      expect(added.connector).toMatchObject({
        displayName: "Vendor Docs",
        description: "Search the vendor's documentation.",
      });
      const listed = yield* harness.runtime.list();
      expect(listed.connectors[0]).toMatchObject({
        description: "Search the vendor's documentation.",
      });
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector OAuth sign-in", () => {
  it.live(
    "registers a client, uses PKCE S256 with the resource, and connects through the callback",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const added = yield* harness.addSecure();
        expect(added.nextStep).toBe("sign-in-required");
        expect(added.connector.status).toBe("needs-auth");

        const { authorizationUrl, callback, response } = yield* harness.signIn(
          added.connector.connectorId,
        );
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorizationUrl.searchParams.get("resource")).toBe(`${vendor.base}/secure/mcp`);
        expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
          `${CALLBACK_ORIGIN}/oauth/connectors/callback`,
        );
        expect(
          Buffer.from(authorizationUrl.searchParams.get("state") ?? "", "base64url"),
        ).toHaveLength(32);
        expect(vendor.registrations).toHaveLength(1);
        expect(vendor.registrations[0]?.redirect_uris).toEqual([
          `${CALLBACK_ORIGIN}/oauth/connectors/callback`,
        ]);
        const exchange = vendor.tokenRequests.find(
          (entry) => entry.grant_type === "authorization_code",
        );
        expect(exchange?.resource).toBe(`${vendor.base}/secure/mcp`);
        expect(exchange?.code_verifier).toBeDefined();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* readText(response)).toContain("Vendor is connected");

        const listed = yield* harness.runtime.list();
        expect(listed.connectors[0]).toMatchObject({
          status: "connected",
          auth: {
            type: "oauth",
            usesOwnClient: false,
            issuer: `${vendor.base}/as`,
            scopes: ["read"],
          },
        });
        const serialized = JSON.stringify(listed);
        expect(serialized).not.toContain("vendor-access-token-");
        expect(serialized).not.toContain("vendor-refresh-token-");
        expect(serialized).not.toContain("client-1");

        // The state is single-claim: replaying the callback fails without touching the AS.
        const tokenRequests = vendor.tokenRequests.length;
        const replay = yield* harness.send(new Request(callback.href));
        expect(replay.status).toBe(400);
        expect(yield* readText(replay)).toContain("invalid or has expired");
        expect(vendor.tokenRequests).toHaveLength(tokenRequests);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "sends the RFC 8707 resource on every request when protected-resource metadata is absent",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        vendor.accessTokenTtlSeconds = 30; // inside the refresh leeway
        const added = yield* harness.addSecure("/noprm/mcp");
        const { authorizationUrl, response } = yield* harness.signIn(added.connector.connectorId);
        expect(authorizationUrl.searchParams.get("resource")).toBe(`${vendor.base}/noprm/mcp`);
        expect(response.status).toBe(200);

        const called = yield* harness.proxy(added.connector.connectorId, toolCall(1));
        expect(yield* readJson(called)).toMatchObject({ id: 1, result: {} });
        expect(vendor.tokenRequests.map((entry) => [entry.grant_type, entry.resource])).toEqual([
          ["authorization_code", `${vendor.base}/noprm/mcp`],
          ["refresh_token", `${vendor.base}/noprm/mcp`],
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("never follows a typed loopback connector's metadata to another loopback origin", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const added = yield* harness.addSecure("/pivot/mcp");
      // The metadata URL names another loopback port; the SDK may fall back to
      // the connector's own origin, but the other origin is never contacted.
      yield* Effect.exit(
        harness.runtime.startSignIn({
          connectorId: added.connector.connectorId,
          callbackOrigin: CALLBACK_ORIGIN,
        }),
      );
      expect(internalRequests).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("only accepts loopback http or https callback origins", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const added = yield* harness.addSecure();
      for (const callbackOrigin of [
        "http://example.com:3000",
        "http://127.0.0.1",
        "https://scient.example/path",
        "javascript:alert(1)",
      ]) {
        const exit = yield* Effect.exit(
          harness.runtime.startSignIn({ connectorId: added.connector.connectorId, callbackOrigin }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(vendor.registrations).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("caps pending sign-ins even when starts race", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const ids = yield* Effect.forEach(
        Array.from({ length: 17 }, (_, index) => index),
        (index) =>
          harness
            .addSecure(`/secure/mcp/${index}`)
            .pipe(Effect.map((added) => added.connector.connectorId)),
      );
      const starts = yield* Effect.forEach(
        ids,
        (connectorId) =>
          Effect.exit(
            harness.runtime.startSignIn({ connectorId, callbackOrigin: CALLBACK_ORIGIN }),
          ),
        { concurrency: "unbounded" },
      );
      expect(starts.filter(Exit.isSuccess)).toHaveLength(16);
      expect(starts.filter(Exit.isFailure)).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("never returns an entered credential in the inventory and refuses short ones", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.validTokens.add("entered-secret-value");
      const added = yield* harness.runtime.add({
        target: { type: "url", url: `${vendor.base}/secure/mcp` },
        credential: { type: "entered", strategy: "bearer", value: "entered-secret-value" },
      });
      expect(added.nextStep).toBe("ready");
      const listed = yield* harness.runtime.list();
      expect(JSON.stringify(listed)).not.toContain("entered-secret-value");
      expect(JSON.stringify(added)).not.toContain("entered-secret-value");
      const short = yield* Effect.exit(
        harness.runtime.add({
          target: { type: "url", url: `${vendor.base}/secure/mcp/short` },
          credential: { type: "entered", strategy: "bearer", value: "abc" },
        }),
      );
      expect(Exit.isFailure(short)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector credential isolation", () => {
  it.live("redacts reflected credentials from bodies and never forwards vendor headers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      const token = "vendor-access-token-1";

      const echoed = yield* harness.proxy(connectorId, toolCall(1, "echo-auth"));
      expect(echoed.status).toBe(200);
      expect([...echoed.headers.keys()].sort()).toEqual([
        "cache-control",
        "content-type",
        "mcp-session-id",
      ]);
      expect(echoed.headers.get("mcp-session-id")).toMatch(/^scs_/);
      const body = yield* readText(echoed);
      for (const form of [
        token,
        Buffer.from(token).toString("base64"),
        encodeURIComponent(token),
      ]) {
        expect(body).not.toContain(form);
      }
      expect(body).toContain("redacted by Scient");

      const denied = yield* harness.proxy(connectorId, toolCall(2, "deny-echo"));
      expect(denied.status).toBe(200);
      const deniedBody = yield* readText(denied);
      expect(deniedBody).not.toContain(token);
      expect(JSON.parse(deniedBody)).toMatchObject({
        id: 2,
        error: { message: "Vendor answered with HTTP 403." },
      });

      const split = yield* harness.proxy(connectorId, toolCall(3, "echo-sse-split"));
      expect(split.headers.get("content-type")).toBe("text/event-stream");
      const splitBody = yield* readText(split);
      expect(splitBody).not.toContain(token);
      expect(splitBody).toContain('"id":3');

      // Connector test results reach the settings UI and are redacted too.
      const tested = yield* harness.runtime.test({ connectorId });
      expect(JSON.stringify(tested)).not.toContain("vendor-access-token-");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("binds upstream MCP sessions to the agent session that opened them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();

      const opened = yield* harness.proxy(connectorId, initialize(1));
      const proxySession = opened.headers.get("mcp-session-id");
      expect(proxySession).toMatch(/^scs_/);
      expect(opened.headers.get("mcp-protocol-version")).toBe("2025-11-25");
      yield* readJson(opened);

      const before = vendor.upstream.length;
      for (const method of ["POST", "GET", "DELETE"]) {
        const foreign = yield* harness.request(connectorId, {
          method,
          token: OTHER_AGENT_TOKEN,
          session: proxySession!,
          ...(method === "POST" ? { body: JSON.stringify(toolCall(2)) } : {}),
        });
        expect(foreign.status).toBe(404);
      }
      // The vendor's own id is meaningless to Scient, even for the owner.
      const raw = yield* harness.proxy(connectorId, toolCall(3), { session: "vendor-session" });
      expect(raw.status).toBe(404);
      expect(vendor.upstream).toHaveLength(before);

      const own = yield* harness.proxy(connectorId, toolCall(4), { session: proxySession! });
      expect(yield* readJson(own)).toMatchObject({ id: 4, result: {} });
      expect(vendor.upstream.at(-1)?.session).toBe("vendor-session");

      const closed = yield* harness.request(connectorId, {
        method: "DELETE",
        session: proxySession!,
      });
      expect(closed.status).toBe(200);
      expect(vendor.upstream.at(-1)).toMatchObject({ method: "DELETE", session: "vendor-session" });
      const afterClose = yield* harness.proxy(connectorId, toolCall(5), { session: proxySession! });
      expect(afterClose.status).toBe(404);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector credential isolation, equivalent encodings", () => {
  it.live(
    "redacts unicode-escaped, percent-encoded and base64 reflections and keeps JSON valid",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const connectorId = yield* harness.connectSecure();
        const echoed = yield* harness.proxy(connectorId, toolCall(1, "echo-encoded"));
        const text = yield* readText(echoed);
        const parsed = JSON.parse(text) as {
          id: number;
          result: { content: Array<{ text: string }> } & Record<string, unknown>;
        };
        expect(parsed.id).toBe(1);
        expect(parsed.result.content.map((item) => item.text)).toEqual([
          "[redacted by Scient]",
          "[redacted by Scient]",
          "[redacted by Scient]",
        ]);
        expect(parsed.result).toHaveProperty("[redacted by Scient]", true);
        expect(text).not.toContain("vendor-access-token");
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("passes only known MCP protocol versions back to the agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      const known = yield* harness.proxy(connectorId, initialize(1));
      expect(known.headers.get("mcp-protocol-version")).toBe("2025-11-25");
      const echoed = yield* harness.proxy(connectorId, toolCall(2, "echo-version"));
      expect(echoed.headers.get("mcp-protocol-version")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("refuses and revokes issued OAuth tokens too short to keep out of agent output", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.shortTokens = true;
      const revoked = Promise.withResolvers<void>();
      vendor.revoked = () => {
        if (vendor.revocations.includes("short-1")) revoked.resolve();
      };
      const added = yield* harness.addSecure();
      const { response } = yield* harness.signIn(added.connector.connectorId);
      expect(response.status).toBe(400);
      expect(yield* readText(response)).toContain(
        "shorter than Scient can keep out of agent output",
      );
      const listed = yield* harness.runtime.list();
      expect(listed.connectors[0]?.status).toBe("needs-auth");
      expect(yield* connectorSecrets(harness.config)).toEqual([]);
      yield* Effect.promise(() => revoked.promise);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("refuses a short refreshed token and asks for sign-in again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.accessTokenTtlSeconds = 30;
      const connectorId = yield* harness.connectSecure();
      vendor.shortTokens = true;
      const response = yield* harness.proxy(connectorId, toolCall(1));
      expect(yield* readJson(response)).toMatchObject({ id: 1, error: { code: -32001 } });
      expect(vendor.upstream.map((entry) => entry.authorization)).not.toContain("Bearer short-2");
      const listed = yield* harness.runtime.list();
      expect(listed.connectors[0]).toMatchObject({
        status: "needs-auth",
        lastError: expect.stringContaining("16 characters"),
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("passes a priming event through the proxy before the reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      const response = yield* harness.proxy(connectorId, toolCall(3, "priming"));
      expect(yield* readText(response)).toBe(
        'id: c1\nretry: 500\ndata:\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[]}}\n\n',
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "marks an already connected connector needs-auth when a new sign-in issues short tokens",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const connectorId = yield* harness.connectSecure();
        vendor.shortTokens = true;
        const { response } = yield* harness.signIn(connectorId);
        expect(response.status).toBe(400);
        const listed = yield* harness.runtime.list();
        expect(listed.connectors[0]).toMatchObject({
          status: "needs-auth",
          lastError: expect.stringContaining("16 characters"),
        });
        const call = yield* harness.proxy(connectorId, toolCall(1));
        expect(yield* readJson(call)).toMatchObject({ id: 1, error: { code: -32001 } });
      }).pipe(Effect.provide(testLayer)),
  );

  it("refuses a legacy short own client secret and re-registers over a legacy short DCR secret", async () => {
    const flows = new ConnectorOAuthFlows(() => 0);
    const fetch = controlFetch(egressPolicyFor(`${vendor.base}/secure/mcp`, { type: "url" }));
    const start = (connectorId: string, material: ConnectorOAuthMaterial) =>
      flows.start({
        connectorId,
        serverUrl: `${vendor.base}/secure/mcp`,
        callbackOrigin: CALLBACK_ORIGIN,
        material,
        fetch,
        resourceMetadataUrl: undefined,
        scope: undefined,
      });
    const ownClient = await start("con_ownclient", {
      format: 1,
      ownClient: { clientId: "legacy-client", clientSecret: "short" },
      registrations: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(ownClient).toBeInstanceOf(ConnectorOAuthError);
    expect(vendor.tokenRequests).toEqual([]);

    const started = await start("con_registered", {
      format: 1,
      registrations: [
        {
          issuer: `${vendor.base}/as`,
          redirectUri: `${CALLBACK_ORIGIN}/oauth/connectors/callback`,
          client: { client_id: "legacy-dcr", client_secret: "short" },
        },
      ],
    });
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("client-1");
    expect(vendor.registrations).toHaveLength(1);
  });

  it.live("keeps the agent's own tainted numeric id and refuses a retyped numeric field", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const digits = "1234567890123456";
      vendor.validTokens.add(digits);
      const added = yield* harness.runtime.add({
        target: { type: "url", url: `${vendor.base}/secure/mcp` },
        credential: { type: "entered", strategy: "bearer", value: digits },
      });
      const connectorId = added.connector.connectorId;
      harness.delivered.add(connectorId);
      const kept = yield* harness.proxy(connectorId, toolCall(Number(digits)));
      expect(yield* readText(kept)).toBe(
        `{"jsonrpc":"2.0","id":${digits},"result":{"content":[{"type":"text","text":"found"}]}}`,
      );
      const refused = yield* harness.proxy(connectorId, toolCall(7, "echo-number"));
      expect(yield* readJson(refused)).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32001, message: expect.stringContaining("withheld") },
      });

      // Refusals answer with the agent's id exactly as written, never a rounded number.
      const bigId = "9007199254740993";
      const rawCall = (name: string) =>
        `{"jsonrpc":"2.0","id":${bigId},"method":"tools/call","params":{"name":"${name}","arguments":{}}}`;
      const withheld = yield* harness.request(connectorId, { body: rawCall("echo-number") });
      expect(yield* readText(withheld)).toMatch(
        new RegExp(`^\\{"jsonrpc":"2\\.0","id":${bigId},"error":\\{"code":-32001,`),
      );
      yield* harness.runtime.update({
        connectorId,
        availability: { type: "projects", projectIds: [] },
      });
      const deselected = yield* harness.request(connectorId, { body: rawCall("search") });
      expect(yield* readText(deselected)).toMatch(
        new RegExp(`^\\{"jsonrpc":"2\\.0","id":${bigId},"error":\\{"code":-32001,`),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("retires a legacy short DCR registration at another redirect URI on recovery", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      const connectorId = yield* first.connectSecure();
      const state: { connectors: Array<{ auth: { credentialRef: string } }> } = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(first.statePath, "utf8")),
      );
      const ref = VaultSecretRef.make(state.connectors[0]!.auth.credentialRef);
      const store = yield* ConnectorCredentialStore.ConnectorCredentialStore;
      const owner = { type: "connector", connectorId } as const;
      const stored = yield* store.readOwned(ref, owner);
      expect(Option.isSome(stored)).toBe(true);
      if (Option.isNone(stored)) return;
      const material = decodeOAuthMaterial(stored.value.material);
      expect(material).toBeDefined();
      yield* store.replace(
        ref,
        encodeOAuthMaterial({
          ...material!,
          registrations: [
            ...material!.registrations,
            {
              issuer: `${vendor.base}/as`,
              redirectUri: "http://localhost:9/oauth/connectors/callback",
              client: { client_id: "legacy", client_secret: "short" },
            },
          ],
        }),
        stored.value.version,
      );

      // A fresh runtime reads the legacy material: it is refused until a new sign-in.
      const second = yield* makeHarness();
      second.delivered.add(connectorId);
      const blocked = yield* second.proxy(connectorId, toolCall(1));
      expect(yield* readJson(blocked)).toMatchObject({ id: 1, error: { code: -32001 } });
      const { response } = yield* second.signIn(connectorId);
      expect(response.status).toBe(200);
      const call = yield* second.proxy(connectorId, toolCall(2));
      expect(yield* readJson(call)).toMatchObject({ id: 2, result: {} });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("refuses a Basic credential whose password half is short", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const exit = yield* Effect.exit(
        harness.runtime.add({
          target: { type: "url", url: `${vendor.base}/secure/mcp` },
          credential: { type: "entered", strategy: "basic", value: "averylongusername:x" },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector proxy", () => {
  it.live("swaps the agent bearer for the vendor token and streams SSE responses", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();

      const plain = yield* harness.proxy(connectorId, toolCall(1));
      expect(plain.status).toBe(200);
      expect(yield* readJson(plain)).toMatchObject({
        id: 1,
        result: { content: [{ text: "found" }] },
      });
      expect(vendor.upstream.at(-1)?.authorization).toBe("Bearer vendor-access-token-1");
      expect(vendor.upstream.map((entry) => entry.authorization)).not.toContain(
        `Bearer ${AGENT_TOKEN}`,
      );

      const streamed = yield* harness.proxy(connectorId, toolCall(2, "slow"));
      expect(streamed.headers.get("content-type")).toBe("text/event-stream");
      expect(streamed.headers.get("www-authenticate")).toBeNull();
      const reader = streamed.body!.pipeThrough(new TextDecoderStream()).getReader();
      const first = yield* Effect.promise(() => reader.read());
      // The progress event arrives while the upstream response is still open.
      expect(first.value).toContain("notifications/progress");
      expect(vendor.releaseSlow).toBeDefined();
      vendor.releaseSlow!();
      const rest = yield* Effect.promise(async () => {
        let text = "";
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          text += chunk.value;
        }
        return text;
      });
      expect(rest).toContain('"id":2');
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("passes 202, 405 and expired-session 404 through with server-owned bodies", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const open = yield* harness.runtime.add({
        target: { type: "url", url: `${vendor.base}/open/mcp` },
      });
      harness.delivered.add(open.connector.connectorId);
      const notified = yield* harness.proxy(open.connector.connectorId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(notified.status).toBe(202);
      expect(yield* readText(notified)).toBe("");
      const noStream = yield* harness.request(open.connector.connectorId, { method: "GET" });
      expect(noStream.status).toBe(405);

      const opened = yield* harness.proxy(open.connector.connectorId, initialize(1));
      const proxySession = opened.headers.get("mcp-session-id")!;
      vendor.expiredSessions.add("vendor-session");
      const expired = yield* harness.proxy(open.connector.connectorId, toolCall(2), {
        session: proxySession,
      });
      expect(expired.status).toBe(404);
      expect(yield* readText(expired)).not.toContain("session expired");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("rejects a request body over 4 MiB even without a content length", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      const chunk = new Uint8Array(1024 * 1024).fill(32);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
          controller.close();
        },
      });
      const before = vendor.upstream.length;
      const response = yield* harness.request(connectorId, { body });
      expect(response.status).toBe(413);
      expect(vendor.upstream).toHaveLength(before);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("holds a permit for each open stream until it ends and answers busy when full", () =>
    Effect.gen(function* () {
      const streamClosed = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        onStreamClosed: Deferred.succeed(streamClosed, undefined).pipe(Effect.asVoid),
      });
      const connectorId = yield* harness.connectSecure();
      const streams: Response[] = [];
      for (let index = 0; index < MAX_IN_FLIGHT_PER_CONNECTOR; index += 1) {
        const opened = yield* harness.request(connectorId, { method: "GET" });
        expect(opened.status).toBe(200);
        streams.push(opened);
      }
      expect(vendor.openStreams).toBe(MAX_IN_FLIGHT_PER_CONNECTOR);
      const busy = yield* harness.request(connectorId, { method: "GET" });
      expect(busy.status).toBe(503);
      const busyCall = yield* harness.proxy(connectorId, toolCall(1));
      expect(yield* readJson(busyCall)).toMatchObject({ id: 1, error: { code: -32001 } });
      expect(vendor.openStreams).toBe(MAX_IN_FLIGHT_PER_CONNECTOR);

      // Cancelling one stream closes its upstream exchange and frees its permit.
      const closed = Promise.withResolvers<void>();
      vendor.streamClosed = closed.resolve;
      yield* Effect.promise(() => streams.pop()!.body!.cancel());
      yield* Effect.promise(() => closed.promise);
      yield* Deferred.await(streamClosed);
      const reopened = yield* harness.request(connectorId, { method: "GET" });
      expect(reopened.status).toBe(200);
      streams.push(reopened);
      yield* Effect.promise(() => Promise.all(streams.map((stream) => stream.body!.cancel())));
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "rejects a missing or foreign bearer, an undelivered connector and a deselected project",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const connectorId = yield* harness.connectSecure();
        const upstreamCalls = vendor.upstream.length;

        const missing = yield* harness.proxy(connectorId, toolCall(1), { token: null });
        expect(missing.status).toBe(401);
        expect(missing.headers.get("www-authenticate")).toBe("Bearer");

        const foreign = yield* harness.proxy(connectorId, toolCall(1), { token: "someone-else" });
        expect(foreign.status).toBe(401);
        expect(foreign.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');

        harness.delivered.delete(connectorId);
        const undelivered = yield* harness.proxy(connectorId, toolCall(1));
        expect(undelivered.status).toBe(403);
        harness.delivered.add(connectorId);

        yield* harness.runtime.update({
          connectorId,
          availability: { type: "projects", projectIds: [OTHER_PROJECT] },
        });
        const deselected = yield* harness.proxy(connectorId, toolCall(7));
        expect(deselected.status).toBe(200);
        expect(yield* readJson(deselected)).toMatchObject({
          id: 7,
          error: { message: expect.stringContaining("Settings → Extensions") },
        });
        expect(vendor.upstream).toHaveLength(upstreamCalls);

        harness.setThreadProject(OTHER_PROJECT);
        const selected = yield* harness.proxy(connectorId, toolCall(8));
        expect(yield* readJson(selected)).toMatchObject({ id: 8, result: {} });
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("validates, deduplicates and applies availability as part of the grant", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const added = yield* harness.runtime.add({
        target: { type: "url", url: `${vendor.base}/open/mcp` },
      });
      const connectorId = added.connector.connectorId;
      const granted = (projectId: ProjectId) =>
        harness.runtime.isGranted({ connectorId, projectId });
      const before = (yield* harness.runtime.list()).revision;

      yield* harness.runtime.update({
        connectorId,
        availability: { type: "projects", projectIds: [OTHER_PROJECT, PROJECT, OTHER_PROJECT] },
      });
      const selected = yield* harness.runtime.list();
      expect(selected.connectors[0]?.availability).toEqual({
        type: "projects",
        projectIds: [OTHER_PROJECT, PROJECT],
      });
      expect(selected.revision).toBeGreaterThan(before);
      expect(yield* granted(PROJECT)).toBe(true);

      // An unknown project fails the whole update; nothing is saved.
      const unknown = yield* Effect.flip(
        harness.runtime.update({
          connectorId,
          displayName: "Renamed",
          availability: { type: "projects", projectIds: [PROJECT, ProjectId.make("project-gone")] },
        }),
      );
      expect(unknown).toMatchObject({
        reason: "not-found",
        message: expect.stringContaining("project-gone"),
      });
      const unchanged = yield* harness.runtime.list();
      expect(unchanged.connectors).toEqual(selected.connectors);
      expect(unchanged.revision).toBe(selected.revision);

      // An empty list means no project at all.
      yield* harness.runtime.update({
        connectorId,
        availability: { type: "projects", projectIds: [] },
      });
      expect(yield* granted(PROJECT)).toBe(false);
      expect(
        (yield* harness.runtime.resolveDelivery({ projectId: PROJECT })).skipped.map(
          (entry) => entry.reason,
        ),
      ).toEqual(["project-deselected"]);

      yield* harness.runtime.update({ connectorId, availability: { type: "all-projects" } });
      expect(yield* granted(PROJECT)).toBe(true);
      // Availability never overrides a disabled connector.
      yield* harness.runtime.update({ connectorId, enabled: false });
      expect(yield* granted(PROJECT)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector token lifecycle", () => {
  it.live("shares one refresh between concurrent requests while the token is expiring", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.accessTokenTtlSeconds = 30; // inside the 60 s leeway
      const connectorId = yield* harness.connectSecure();

      const refresh = gateOf(vendor.refresh);
      const pending = yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => index + 1),
        (id) => harness.proxy(connectorId, toolCall(id)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(() => refresh.arrived);
      refresh.release();
      const responses = yield* Fiber.join(pending);
      for (const response of responses) {
        expect(yield* readJson(response)).toMatchObject({
          result: { content: [{ text: "found" }] },
        });
      }
      expect(vendor.refreshCount).toBe(1);
      expect(new Set(vendor.upstream.slice(-6).map((entry) => entry.authorization))).toEqual(
        new Set(["Bearer vendor-access-token-2"]),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("refreshes once and replays the request after an upstream 401", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      vendor.validTokens.delete("vendor-access-token-1");
      const before = vendor.upstream.length;

      const response = yield* harness.proxy(connectorId, toolCall(3));
      expect(yield* readJson(response)).toMatchObject({
        id: 3,
        result: { content: [{ text: "found" }] },
      });
      expect(vendor.refreshCount).toBe(1);
      expect(vendor.upstream.slice(before).map((entry) => entry.authorization)).toEqual([
        "Bearer vendor-access-token-2",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live.each(["invalid_grant", "unprotectable refresh"] as const)(
    "publishes the loss of the current grant (%s) for a request holding an older record",
    (loss) =>
      Effect.gen(function* () {
        let hold:
          | { skip: number; readonly arrived: () => void; readonly gate: Promise<void> }
          | undefined;
        const harness = yield* makeHarness({
          // The proxy route checks the grant (one eligibility check); the
          // forward then takes its record snapshot and checks eligibility again
          // before taking the credential. Holding that second check makes the
          // snapshot stale.
          wrapEligibility: (inner) => ({
            ...inner,
            isEligible: (input) => {
              const held = hold;
              if (held === undefined) return inner.isEligible(input);
              if (held.skip > 0) {
                held.skip -= 1;
                return inner.isEligible(input);
              }
              hold = undefined;
              held.arrived();
              return Effect.promise(() => held.gate).pipe(Effect.andThen(inner.isEligible(input)));
            },
          }),
        });
        const connectorId = yield* harness.connectSecure();
        const current = Effect.map(harness.runtime.list(), (listed) => listed.connectors[0]!);
        const arrived = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        hold = { skip: 1, arrived: arrived.resolve, gate: released.promise };
        const stale = yield* harness.proxy(connectorId, toolCall(1)).pipe(Effect.forkScoped);
        yield* Effect.promise(() => arrived.promise);

        // Grant B is signed in (already within the refresh leeway) while the
        // request still holds the record of grant A.
        vendor.accessTokenTtlSeconds = 30;
        const { response } = yield* harness.signIn(connectorId);
        expect(response.status).toBe(200);
        expect(yield* current).toMatchObject({ status: "connected", authRevision: 2 });
        if (loss === "invalid_grant") vendor.refreshMode = "invalid_grant";
        else vendor.shortTokens = true;
        released.resolve();

        // The request refreshes B (the current grant), which is lost.
        expect(yield* readJson(yield* Fiber.join(stale))).toMatchObject({
          id: 1,
          error: { code: -32001 },
        });
        expect(vendor.refreshCount).toBe(1);
        expect(yield* current).toMatchObject({ status: "needs-auth", authRevision: 3 });

        // B's session is gone from storage, the status is persisted, and the
        // connector is no longer delivered.
        const state: { connectors: Array<{ auth: { credentialRef: string } }> } = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8")),
        );
        const stored = yield* (yield* ConnectorCredentialStore.ConnectorCredentialStore).readOwned(
          VaultSecretRef.make(state.connectors[0]!.auth.credentialRef),
          { type: "connector", connectorId },
        );
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(decodeOAuthMaterial(stored.value.material)?.session).toBeUndefined();
        }
        const reloaded = yield* makeConnectorRuntime({ stateDir: harness.config.stateDir });
        expect((yield* reloaded.list()).connectors[0]).toMatchObject({
          status: "needs-auth",
          authRevision: 3,
        });
        expect((yield* harness.runtime.resolveDelivery({ projectId: PROJECT })).eligible).toEqual(
          [],
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "ignores a refused replay of an older grant once a newer sign-in owns the connector",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const connectorId = yield* harness.connectSecure();
        const current = Effect.map(harness.runtime.list(), (listed) => listed.connectors[0]!);
        expect((yield* current).authRevision).toBe(1);
        // The next call gets 401, refreshes, and its replay is refused, but held.
        const refuseNextReplay = () => {
          vendor.validTokens.clear();
          vendor.refusedTokens.add(`vendor-access-token-${vendor.tokenSerial + 1}`);
        };
        refuseNextReplay();
        const refusing = gateOf(vendor.refusing);
        const stale = yield* harness.proxy(connectorId, toolCall(1)).pipe(Effect.forkScoped);
        yield* Effect.promise(() => refusing.arrived);

        // Account B signs in while the old grant's replay is in flight.
        const { response } = yield* harness.signIn(connectorId);
        expect(response.status).toBe(200);
        expect(yield* current).toMatchObject({ status: "connected", authRevision: 2 });
        refusing.release();
        expect(yield* readJson(yield* Fiber.join(stale))).toMatchObject({
          id: 1,
          error: { code: -32001 },
        });

        // The newer sign-in is untouched and keeps working.
        expect(yield* current).toMatchObject({ status: "connected", authRevision: 2 });
        const fresh = yield* harness.proxy(connectorId, toolCall(2));
        expect(yield* readJson(fresh)).toMatchObject({ id: 2, result: {} });

        // The same refusal of the grant that owns the connector still counts.
        refuseNextReplay();
        const refused = yield* harness.proxy(connectorId, toolCall(3));
        expect(yield* readJson(refused)).toMatchObject({ id: 3, error: { code: -32001 } });
        expect(yield* current).toMatchObject({ status: "needs-auth", authRevision: 3 });
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps a newer sign-in when a refresh of the previous grant finishes around it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.accessTokenTtlSeconds = 30;
      const connectorId = yield* harness.connectSecure();

      const refresh = gateOf(vendor.refresh);
      const stale = yield* harness.proxy(connectorId, toolCall(1)).pipe(Effect.forkScoped);
      yield* Effect.promise(() => refresh.arrived);
      // A fresh sign-in exchanges its code while the old grant's refresh is still in flight.
      vendor.accessTokenTtlSeconds = 3600;
      const exchange = gateOf(vendor.exchange);
      const signIn = yield* harness.signIn(connectorId).pipe(Effect.forkScoped);
      yield* Effect.promise(() => exchange.arrived);
      exchange.release();
      refresh.release();
      yield* Fiber.join(stale);
      const { response } = yield* Fiber.join(signIn);
      expect(response.status).toBe(200);

      const after = yield* harness.proxy(connectorId, toolCall(2));
      expect(yield* readJson(after)).toMatchObject({ id: 2, result: {} });
      const signInToken = vendor.issued.filter((entry) => entry.grant === "authorization_code")[1];
      expect(signInToken).toBeDefined();
      expect(vendor.upstream.at(-1)?.authorization).toBe(`Bearer ${signInToken!.token}`);
      expect(vendor.refreshCount).toBe(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "never lets a credential read that finishes after a new sign-in restore the old account",
    () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const connectorId = yield* first.connectSecure();

        // A fresh runtime (cold cache) whose first credential read is held after it read.
        const readGate: Gate = { gate: undefined, arrived: undefined };
        const read = gateOf(readGate);
        let holdNextRead = true;
        const second = yield* makeHarness({
          wrapCredentials: (store) => ({
            ...store,
            readOwned: (ref, owner) => {
              if (!holdNextRead) return store.readOwned(ref, owner);
              holdNextRead = false;
              return store
                .readOwned(ref, owner)
                .pipe(Effect.tap(() => Effect.promise(() => passGate(readGate))));
            },
          }),
        });
        second.delivered.add(connectorId);
        const stale = yield* second.proxy(connectorId, toolCall(1)).pipe(Effect.forkScoped);
        yield* Effect.promise(() => read.arrived);
        const { response } = yield* second.signIn(connectorId);
        expect(response.status).toBe(200);
        read.release();
        yield* readJson(yield* Fiber.join(stale));
        yield* readJson(yield* second.proxy(connectorId, toolCall(2)));

        const signInToken = vendor.issued.filter(
          (entry) => entry.grant === "authorization_code",
        )[1];
        expect(signInToken).toBeDefined();
        expect(vendor.upstream.slice(-2).map((entry) => entry.authorization)).toEqual([
          `Bearer ${signInToken!.token}`,
          `Bearer ${signInToken!.token}`,
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "marks needs-auth on invalid_grant and answers the agent with a JSON-RPC error, not 401",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const connectorId = yield* harness.connectSecure();
        const signedIn = (yield* harness.runtime.list()).connectors[0]!.authRevision;
        vendor.validTokens.clear();
        vendor.refreshMode = "invalid_grant";

        const response = yield* harness.proxy(connectorId, toolCall(4));
        expect(response.status).toBe(200);
        expect(response.headers.get("www-authenticate")).toBeNull();
        expect(yield* readJson(response)).toMatchObject({
          id: 4,
          error: {
            message: expect.stringContaining("reconnect it in Scient Settings → Extensions"),
          },
        });

        const listed = yield* harness.runtime.list();
        expect(listed.connectors[0]?.status).toBe("needs-auth");
        // The lost grant is a new credential generation.
        expect(listed.connectors[0]?.authRevision).toBe(signedIn + 1);
        const delivery = yield* harness.runtime.resolveDelivery({ projectId: PROJECT });
        expect(delivery.eligible).toEqual([]);
        expect(delivery.skipped).toMatchObject([{ connectorId, reason: "needs-auth" }]);

        const next = yield* harness.proxy(connectorId, toolCall(5));
        expect(yield* readJson(next)).toMatchObject({ id: 5, error: { code: -32001 } });
        // Further refusals while already needs-auth are not new generations.
        expect((yield* harness.runtime.list()).connectors[0]?.authRevision).toBe(signedIn + 1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("advances the auth revision on every sign-in and only on credential changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.accessTokenTtlSeconds = 30;
      const connectorId = yield* harness.connectSecure();
      const current = Effect.map(harness.runtime.list(), (listed) => listed.connectors[0]!);
      const first = yield* current;
      expect(first.authRevision).toBe(1);

      // Re-signing in with the same issuer, scopes and client looks identical
      // publicly, but may be another account: it is a new revision.
      const { response } = yield* harness.signIn(connectorId);
      expect(response.status).toBe(200);
      const second = yield* current;
      expect(second.auth).toEqual(first.auth);
      expect(second.authRevision).toBe(2);

      // Token refresh, Test, toggling, renaming and availability keep the revision.
      const used = yield* harness.proxy(connectorId, toolCall(1));
      expect(yield* readJson(used)).toMatchObject({ id: 1, result: {} });
      expect(vendor.refreshCount).toBeGreaterThan(0);
      yield* harness.runtime.test({ connectorId });
      yield* harness.runtime.update({ connectorId, enabled: false });
      yield* harness.runtime.update({ connectorId, enabled: true, displayName: "Renamed" });
      yield* harness.runtime.update({
        connectorId,
        availability: { type: "projects", projectIds: [PROJECT] },
      });
      const settled = yield* current;
      expect(settled.displayName).toBe("Renamed");
      expect(settled.authRevision).toBe(2);

      // Persisted: a fresh runtime over the same state reads the same revision.
      const reloaded = yield* makeConnectorRuntime({ stateDir: harness.config.stateDir });
      expect((yield* reloaded.list()).connectors[0]?.authRevision).toBe(2);
      const written: { connectors: ReadonlyArray<{ authRevision?: number }> } = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8")),
      );
      expect(written.connectors[0]?.authRevision).toBe(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps a rotated token in memory when it cannot be saved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.accessTokenTtlSeconds = 30;
      const connectorId = yield* harness.connectSecure();
      yield* Effect.promise(() => NodeFSP.chmod(harness.config.secretsDir, 0o500));
      yield* Effect.gen(function* () {
        for (const id of [1, 2]) {
          const response = yield* harness.proxy(connectorId, toolCall(id));
          expect(yield* readJson(response)).toMatchObject({ id, result: {} });
        }
      }).pipe(
        Effect.ensuring(Effect.promise(() => NodeFSP.chmod(harness.config.secretsDir, 0o700))),
      );
      expect(vendor.refreshCount).toBe(1);
      expect(vendor.upstream.slice(-2).map((entry) => entry.authorization)).toEqual([
        "Bearer vendor-access-token-2",
        "Bearer vendor-access-token-2",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector disconnect", () => {
  it.live("stops forwarding as soon as the connector is removed and revokes its grant", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      yield* harness.runtime.remove({ connectorId });
      const calls = vendor.upstream.length;
      const response = yield* harness.proxy(connectorId, toolCall(9));
      expect(response.status).toBe(200);
      expect(yield* readJson(response)).toMatchObject({ id: 9, error: { code: -32001 } });
      expect(vendor.upstream).toHaveLength(calls);
      expect(yield* connectorSecrets(harness.config)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("cancels an in-flight refresh so nothing is sent or kept after removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.accessTokenTtlSeconds = 30;
      const connectorId = yield* harness.connectSecure();
      const calls = vendor.upstream.length;

      const refresh = gateOf(vendor.refresh);
      const inFlight = yield* harness.proxy(connectorId, toolCall(1)).pipe(Effect.forkScoped);
      yield* Effect.promise(() => refresh.arrived);
      yield* harness.runtime.remove({ connectorId });
      refresh.release();
      const response = yield* Fiber.join(inFlight);
      expect(yield* readJson(response)).toMatchObject({ id: 1, error: { code: -32001 } });
      expect(vendor.upstream).toHaveLength(calls);
      expect(yield* connectorSecrets(harness.config)).toEqual([]);
      expect((yield* harness.runtime.list()).connectors).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("fails a sign-in whose code exchange is in flight when the connector is removed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const added = yield* harness.addSecure();
      const connectorId = added.connector.connectorId;
      const { callback } = yield* harness.authorize(connectorId);
      const exchange = gateOf(vendor.exchange);
      const completing = yield* harness.send(new Request(callback.href)).pipe(Effect.forkScoped);
      yield* Effect.promise(() => exchange.arrived);
      yield* harness.runtime.remove({ connectorId });
      exchange.release();
      const response = yield* Fiber.join(completing);
      expect(response.status).toBe(400);
      expect(yield* connectorSecrets(harness.config)).toEqual([]);
      expect((yield* harness.runtime.list()).connectors).toEqual([]);
      expect(vendor.upstream).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector test", () => {
  it.live("lists tools with the stored credential", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const connectorId = yield* harness.connectSecure();
      const result = yield* harness.runtime.test({ connectorId });
      expect(result).toMatchObject({
        outcome: "ok",
        serverName: "fake-vendor",
        serverVersion: "1.2.3",
        tools: [{ name: "search", readOnly: true }],
      });
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector state file", () => {
  it.live("preserves a corrupt file and refuses changes instead of overwriting it", () =>
    Effect.gen(function* () {
      const corrupt = "{ this is not json";
      const harness = yield* makeHarness({ seedStateFile: corrupt });
      const listed = yield* harness.runtime.list();
      expect(listed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["state-unreadable"]);
      const exit = yield* Effect.exit(
        harness.runtime.add({ target: { type: "url", url: `${vendor.base}/open/mcp` } }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8"))).toBe(
        corrupt,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps unreadable entries and writes them back on the next change", () =>
    Effect.gen(function* () {
      const unreadable = { connectorId: "con_broken", serverName: "BROKEN NAME" };
      const harness = yield* makeHarness({
        seedStateFile: JSON.stringify({
          formatVersion: 2,
          connectors: [unreadable],
        }),
      });
      const listed = yield* harness.runtime.list();
      expect(listed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "connector-record-unreadable",
      ]);
      yield* harness.runtime.add({ target: { type: "url", url: `${vendor.base}/open/mcp` } });
      const written: unknown = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8")),
      );
      // Readable records are written first; the unreadable entry follows verbatim.
      expect(written).toHaveProperty("connectors", [
        expect.objectContaining({ url: `${vendor.base}/open/mcp` }),
        unreadable,
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("never resurrects a preserved duplicate after its connector is removed", () =>
    Effect.gen(function* () {
      const record = {
        connectorId: "con_abcdefgh",
        serverName: "dup",
        displayName: "Original",
        url: `${vendor.base}/open/mcp`,
        source: { type: "url" },
        auth: { type: "none" },
        status: "connected",
        enabled: true,
        availability: { type: "all-projects" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const harness = yield* makeHarness({
        seedStateFile: JSON.stringify({
          formatVersion: 2,
          connectors: [record, { ...record, displayName: "Duplicate" }],
        }),
      });
      const listed = yield* harness.runtime.list();
      expect(listed.connectors.map((connector) => connector.displayName)).toEqual(["Original"]);
      // Records written before auth revisions existed start at 0.
      expect(listed.connectors[0]?.authRevision).toBe(0);
      yield* harness.runtime.remove({ connectorId: listed.connectors[0]!.connectorId });
      const reloaded = yield* makeConnectorRuntime({ stateDir: harness.config.stateDir });
      const after = yield* reloaded.list();
      expect(after.connectors).toEqual([]);
      expect(after.diagnostics).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("migrates a format-1 file: policies become availability, selections are dropped", () =>
    Effect.gen(function* () {
      const legacy = (connectorId: string, projectPolicy: string) => ({
        connectorId,
        serverName: connectorId.slice(4),
        displayName: connectorId,
        url: `${vendor.base}/open/mcp`,
        source: { type: "url" },
        auth: { type: "none" },
        status: "connected",
        enabled: true,
        projectPolicy,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const unknownPolicy = legacy("con_unknownp", "some-future-policy");
      const third = ProjectId.make("project-c");
      // The exact shape Scient wrote before availability existed.
      const fixture = `${JSON.stringify(
        {
          formatVersion: 1,
          connectors: [
            legacy("con_everywhr", "all-projects"),
            legacy("con_selected", "selected-projects"),
            legacy("con_nonesele", "selected-projects"),
            unknownPolicy,
          ],
          projectSelections: [
            { connectorId: "con_selected", projectId: OTHER_PROJECT, enabled: true },
            { connectorId: "con_selected", projectId: PROJECT, enabled: false },
            { connectorId: "con_selected", projectId: third, enabled: true },
            { connectorId: "con_selected", projectId: OTHER_PROJECT, enabled: true },
            { connectorId: "con_everywhr", projectId: PROJECT, enabled: false },
            { connectorId: "con_nonesele", projectId: PROJECT, enabled: false },
            { connectorId: "con_selected", projectId: 7, enabled: true },
          ],
        },
        null,
        2,
      )}\n`;
      const harness = yield* makeHarness({ seedStateFile: fixture });
      const expected = {
        con_everywhr: { type: "all-projects" },
        con_selected: { type: "projects", projectIds: [OTHER_PROJECT, third] },
        con_nonesele: { type: "projects", projectIds: [] },
      };
      const listed = yield* harness.runtime.list();
      expect(
        Object.fromEntries(
          listed.connectors.map((entry) => [entry.connectorId, entry.availability]),
        ),
      ).toEqual(expected);
      expect(listed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "connector-record-unreadable",
      ]);

      // Saved in the new format at once: no policy, no selection records.
      const written: {
        formatVersion: number;
        connectors: ReadonlyArray<Record<string, unknown>>;
      } = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8")));
      expect(written.formatVersion).toBe(2);
      expect(written).not.toHaveProperty("projectSelections");
      expect(written.connectors.slice(0, 3).map((entry) => entry.availability)).toEqual(
        Object.values(expected),
      );
      expect(written.connectors.slice(0, 3).some((entry) => "projectPolicy" in entry)).toBe(false);
      expect(written.connectors[3]).toEqual(unknownPolicy);

      const delivery = yield* harness.runtime.resolveDelivery({ projectId: PROJECT });
      expect(delivery.eligible.map((entry) => entry.connectorId)).toEqual(["con_everywhr"]);
      expect(delivery.skipped.map((entry) => [entry.connectorId, entry.reason])).toEqual([
        ["con_selected", "project-deselected"],
        ["con_nonesele", "project-deselected"],
      ]);
      const elsewhere = yield* harness.runtime.resolveDelivery({ projectId: third });
      expect(elsewhere.eligible.map((entry) => entry.connectorId)).toEqual([
        "con_everywhr",
        "con_selected",
      ]);

      // Reloading the migrated file gives the same connectors.
      const reloaded = yield* makeConnectorRuntime({ stateDir: harness.config.stateDir });
      expect((yield* reloaded.list()).connectors).toEqual(listed.connectors);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("leaves no credential behind when the record cannot be saved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      vendor.validTokens.add("entered-secret-value");
      yield* Effect.promise(() => NodeFSP.chmod(harness.config.stateDir, 0o500));
      const exit = yield* Effect.exit(
        harness.runtime.add({
          target: { type: "url", url: `${vendor.base}/secure/mcp` },
          credential: { type: "entered", strategy: "bearer", value: "entered-secret-value" },
        }),
      ).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.chmod(harness.config.stateDir, 0o700))));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* connectorSecrets(harness.config)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connector credential store", () => {
  it.live("replaces material only at the expected version and reads only for its owner", () =>
    Effect.gen(function* () {
      const store = yield* ConnectorCredentialStore.ConnectorCredentialStore;
      const encode = (text: string) => new TextEncoder().encode(text);
      const owner = { type: "connector", connectorId: "con_abcdefgh" } as const;
      const ref = yield* store.put(owner, "bearer", encode("one"), { label: "test" });
      expect(yield* store.replace(ref, encode("two"), 1)).toBe(2);
      const conflict = yield* store.replace(ref, encode("three"), 1).pipe(Effect.flip);
      expect(conflict._tag).toBe("SecretVersionConflict");
      const foreign = yield* store.readOwned(ref, {
        type: "connector",
        connectorId: "con_other123",
      });
      expect(Option.isNone(foreign)).toBe(true);
      const read = yield* store.readOwned(ref, owner);
      expect(
        Option.map(read, ({ material, version }) => ({
          text: new TextDecoder().decode(material),
          version,
        })),
      ).toEqual(Option.some({ text: "two", version: 2 }));
      yield* store.remove(ref);
      expect(Option.isNone(yield* store.readOwned(ref, owner))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
