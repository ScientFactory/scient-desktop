// @effect-diagnostics nodeBuiltinImport:off -- Tests run a real local MCP server and authorization server.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  type AccountSummary,
  AccountsError,
  AccountId,
  type ConnectorId,
  type DiscoverEntry,
  EnvironmentId,
  ExtensionsError,
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
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/http";
import * as yazl from "yazl";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import type { McpThreadInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import { type ProjectRow, ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { AccountsService } from "../../accounts/AccountsService.ts";
import { accountTokenRef } from "../../accounts/AccountBoundRef.ts";
import { noKeychain } from "../../accounts/Accounts.testkit.ts";
import * as AccountsConnectorCredentials from "../../accounts/AccountsConnectorCredentials.ts";
import { AccountVault, makeAccountVault } from "../../accounts/AccountVault.ts";
import * as LocalDuplexProcess from "../../execution/LocalDuplexProcess.ts";
import {
  addConnector,
  controlConnector,
  listConnectors,
  testConnector,
  changeReport,
} from "../ConnectorAgentControl.ts";
import { ConnectorRuntime, ExtensionsDiscover } from "../ExtensionsServices.ts";
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
import {
  type ConnectorFetch,
  controlFetch,
  egressPolicyFor,
  STRICT_EGRESS_POLICY,
} from "./ConnectorOutbound.ts";
import { probeConnector } from "./ConnectorProbe.ts";
import { GitHubSourceControlCredential } from "./GitHubSourceControlCredential.ts";
import * as ConnectorProxyRoute from "./ConnectorProxyRoute.ts";
import { makeConnectorRuntime, MAX_IN_FLIGHT_PER_CONNECTOR } from "./ConnectorRuntime.ts";
import { CONNECTOR_STATE_FILE } from "./ConnectorStateStore.ts";
import type { RunTool } from "./PackageSource.ts";
import type { ConnectorSessionsShape } from "../../accounts/connectorSessions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SourceControlCredentialError } from "@t3tools/source-control-core/server/driver";

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
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: `Query (debug: ${authorization})` },
                },
                required: ["query"],
              },
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
  if (url.pathname.startsWith("/gh/mcp")) return handleMcp(request, response, "Bearer");
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
  pinnedAt: null,
  archivedAt: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});
const EXISTING_PROJECTS = [PROJECT, OTHER_PROJECT].map(existingProject);

const testVault = Layer.effect(
  AccountVault,
  Effect.gen(function* () {
    return yield* makeAccountVault(
      yield* ServerSecretStore.ServerSecretStore,
      (yield* ServerConfig.ServerConfig).stateDir,
      noKeychain,
    );
  }),
);

const testLayer = AccountsConnectorCredentials.layer.pipe(
  Layer.provideMerge(testVault),
  Layer.provideMerge(PluginConnectorEligibility.layer),
  Layer.provideMerge(
    Layer.mock(ProjectStoreV2)({
      get: () => Effect.succeedNone,
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
  Layer.provideMerge(LocalDuplexProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
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
    /** Stands in for Source Control's GitHub credential. */
    readonly github?: GitHubSourceControlCredential["Service"];
    /** Stands in for Accounts' sessions for signed-in connectors. */
    readonly signInSessions?: ConnectorSessionsShape;
    /** Stands in for the network when a registry bundle is downloaded. */
    readonly bundleFetch?: ConnectorFetch;
    /** Stands in for npm and uv when a copy brings in a package's code. */
    readonly runTool?: RunTool;
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
  const runtime = yield* makeConnectorRuntime({
    stateDir: config.stateDir,
    ...(options.signInSessions === undefined ? {} : { signInSessions: options.signInSessions }),
    ...(options.bundleFetch === undefined ? {} : { bundleFetch: options.bundleFetch }),
    ...(options.runTool === undefined ? {} : { runTool: options.runTool }),
  }).pipe(
    Effect.provideService(
      ConnectorCredentialStore.ConnectorCredentialStore,
      options.wrapCredentials?.(credentialStore) ?? credentialStore,
    ),
    Effect.provideService(
      PluginConnectorEligibility.PluginConnectorEligibility,
      options.wrapEligibility?.(eligibility) ?? eligibility,
    ),
    options.github === undefined
      ? (effect) => effect
      : Effect.provideService(GitHubSourceControlCredential, options.github),
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
      expect(tested.tools[0]?.parameters).toEqual([
        {
          name: "query",
          type: "string",
          required: true,
          description: "Query (debug: Bearer [redacted by Scient]",
        },
      ]);
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

describe("bound connector credentials", () => {
  it.live(
    "uses live account rotation after reload and loses access on removal without fallback",
    () =>
      Effect.gen(function* () {
        let token: string | undefined = NodeCrypto.randomUUID();
        const ref = accountTokenRef(AccountId.make("acc_synthetic01"));
        const bindings = Layer.mock(AccountsService)({
          resolveBound: (candidate, consumer) =>
            Effect.suspend(() => {
              if (
                candidate !== ref ||
                consumer.kind !== "connector" ||
                consumer.origin !== vendor.base ||
                token === undefined
              )
                return Effect.fail(
                  new AccountsError({
                    reason: "not-found",
                    message: "Synthetic account unavailable.",
                  }),
                );
              return Effect.succeed(Redacted.make(token));
            }),
        });
        const harness = yield* makeHarness().pipe(Effect.provide(bindings));
        vendor.validTokens.add(token);
        const added = yield* harness.runtime.add({
          target: { type: "url", url: `${vendor.base}/secure/mcp` },
          credential: { type: "bound", strategy: "bearer", secretRef: ref },
        });
        const connectorId = added.connector.connectorId;
        harness.delivered.add(connectorId);
        const firstCall = yield* harness.proxy(connectorId, toolCall(101, "echo-auth"));
        const firstText = yield* readText(firstCall);
        expect(firstText.includes(token)).toBe(false);
        expect(firstText).toContain("[redacted by Scient]");
        expect(vendor.upstream.at(-1)?.authorization === `Bearer ${token}`).toBe(true);
        expect(added.connector.auth).toMatchObject({ storage: "bound" });
        expect(yield* connectorSecrets(harness.config)).toEqual([]);
        const state = yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8"));
        expect(state.includes(token)).toBe(false);
        const reloaded = yield* makeConnectorRuntime({ stateDir: harness.config.stateDir }).pipe(
          Effect.provide(bindings),
        );
        expect((yield* reloaded.list()).connectors[0]?.auth).toMatchObject({ storage: "bound" });
        expect((yield* reloaded.test({ connectorId })).outcome).toBe("ok");
        vendor.validTokens.delete(token);
        token = NodeCrypto.randomUUID();
        vendor.validTokens.add(token);
        const before = vendor.upstream.length;
        const rotatedCall = yield* harness.proxy(connectorId, toolCall(102, "echo-auth"));
        const rotatedText = yield* readText(rotatedCall);
        expect(rotatedText.includes(token)).toBe(false);
        expect(rotatedText).toContain("[redacted by Scient]");
        expect((yield* reloaded.test({ connectorId })).outcome).toBe("ok");
        expect(
          vendor.upstream
            .slice(before)
            .every((request) => request.authorization === `Bearer ${token}`),
        ).toBe(true);
        token = undefined;
        const sent = vendor.upstream.length;
        yield* reloaded.test({ connectorId });
        const removedCall = yield* harness.proxy(connectorId, toolCall(103));
        expect(yield* readJson(removedCall)).toMatchObject({ id: 103, error: { code: -32001 } });
        expect(vendor.upstream.length).toBe(sent);
        expect((yield* reloaded.list()).connectors[0]?.status).toBe("needs-credential");
        yield* reloaded.remove({ connectorId });
        expect(yield* connectorSecrets(harness.config)).toEqual([]);
      }).pipe(Effect.provide(testLayer)),
  );
});

/** Source Control's GitHub logins: tokens in Source Control's own order, each with its login. */
const fakeSourceControl = (logins: Record<string, string>) => {
  const state = {
    tokens: Object.keys(logins),
    failing: false,
    reads: 0,
    invalidated: [] as Array<string>,
  };
  const service = GitHubSourceControlCredential.of({
    mcpUrl: `${vendor.base}/gh/mcp/`,
    get: (host, options) =>
      Effect.suspend(() => {
        state.reads++;
        if (state.failing) return Effect.fail(new SourceControlCredentialError({ host }));
        const token = state.tokens.find(
          (candidate) => options?.account === undefined || logins[candidate] === options.account,
        );
        return Effect.succeed(
          token === undefined
            ? Option.none()
            : Option.some({
                token: Redacted.make(token),
                via: "cli" as const,
                login: logins[token]!,
              }),
        );
      }),
    invalidate: (_host, credential) =>
      Effect.sync(() => {
        const token = Redacted.value(credential.token);
        state.invalidated.push(token);
        state.tokens = state.tokens.filter((candidate) => candidate !== token);
      }),
  });
  return { state, service };
};

const OCTO_TOKEN = "gho_octo_first_token_0000";
const OCTO_ROTATED = "gho_octo_rotated_token_111";
const OTHER_TOKEN = "gho_someone_else_token_22";

describe("GitHub with Source Control's account", () => {
  const connectGitHub = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
    harness.runtime
      .add({
        target: { type: "url", url: `${vendor.base}/gh/mcp/` },
        displayName: "GitHub",
        credential: { type: "source-control" },
      })
      .pipe(
        Effect.tap((added) =>
          Effect.sync(() => harness.delivered.add(added.connector.connectorId)),
        ),
        Effect.map((added) => added.connector),
      );

  it.live("connects as the account's login and never shows or stores the token", () =>
    Effect.gen(function* () {
      vendor.validTokens.add(OCTO_TOKEN);
      const github = fakeSourceControl({ [OCTO_TOKEN]: "octo" });
      const harness = yield* makeHarness({ github: github.service });
      const connector = yield* connectGitHub(harness);
      expect(connector).toMatchObject({
        status: "connected",
        auth: { type: "source-control", host: "github.com", account: "octo" },
      });
      const echoed = yield* harness.proxy(connector.connectorId, toolCall(1, "echo-auth"));
      expect(vendor.upstream.at(-1)?.authorization).toBe(`Bearer ${OCTO_TOKEN}`);
      expect(yield* readText(echoed)).not.toContain(OCTO_TOKEN);
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8")),
      ).not.toContain(OCTO_TOKEN);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("hands a refused token back to Source Control and replays once with its successor", () =>
    Effect.gen(function* () {
      vendor.validTokens.add(OCTO_TOKEN).add(OCTO_ROTATED);
      const github = fakeSourceControl({ [OCTO_TOKEN]: "octo", [OCTO_ROTATED]: "octo" });
      const harness = yield* makeHarness({ github: github.service });
      const connector = yield* connectGitHub(harness);
      vendor.refusedTokens.add(OCTO_TOKEN);
      const answered = yield* harness.proxy(connector.connectorId, toolCall(1));
      expect(JSON.parse(yield* readText(answered))).toMatchObject({ id: 1, result: {} });
      expect(github.state.invalidated).toEqual([OCTO_TOKEN]);
      expect(vendor.upstream.at(-1)?.authorization).toBe(`Bearer ${OCTO_ROTATED}`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "never falls back to another account, and reconnects after a restart once it is back",
    () =>
      Effect.gen(function* () {
        vendor.validTokens.add(OCTO_TOKEN).add(OTHER_TOKEN);
        const github = fakeSourceControl({ [OCTO_TOKEN]: "octo", [OTHER_TOKEN]: "someone-else" });
        const harness = yield* makeHarness({ github: github.service });
        const connector = yield* connectGitHub(harness);
        github.state.tokens = [OTHER_TOKEN];
        const refused = yield* harness.proxy(connector.connectorId, toolCall(1));
        expect(yield* readText(refused)).toContain("error");
        expect(vendor.upstream.some((entry) => entry.authorization.includes(OTHER_TOKEN))).toBe(
          false,
        );
        expect((yield* harness.runtime.list()).connectors[0]).toMatchObject({
          status: "needs-credential",
          lastError: expect.stringContaining("octo"),
        });

        github.state.tokens = [OCTO_TOKEN];
        const restarted = yield* makeConnectorRuntime({ stateDir: harness.config.stateDir }).pipe(
          Effect.provideService(GitHubSourceControlCredential, github.service),
        );
        expect((yield* restarted.list()).connectors[0]).toMatchObject({
          status: "connected",
          auth: { account: "octo" },
        });
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("sends the credential only to GitHub's own MCP server", () =>
    Effect.gen(function* () {
      const github = fakeSourceControl({ [OCTO_TOKEN]: "octo" });
      const hostile = {
        connectorId: "con_hostile1",
        serverName: "github",
        displayName: "GitHub",
        url: `${vendor.base}/secure/mcp`,
        source: { type: "url" },
        auth: { type: "source-control", host: "github.com", account: "octo" },
        status: "connected",
        enabled: true,
        availability: { type: "all-projects" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const harness = yield* makeHarness({
        github: github.service,
        seedStateFile: JSON.stringify({ formatVersion: 2, connectors: [hostile] }),
      });
      harness.delivered.add(hostile.connectorId);
      const refused = yield* Effect.flip(
        harness.runtime.add({
          target: { type: "url", url: `${vendor.base}/open/mcp` },
          credential: { type: "source-control" },
        }),
      );
      expect(refused.reason).toBe("invalid-input");
      yield* harness.proxy(hostile.connectorId, toolCall(1));
      expect(vendor.upstream).toEqual([]);
      expect(github.state.reads).toBe(0);
      expect((yield* harness.runtime.list()).connectors[0]?.status).toBe("needs-credential");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("answers a retry when Source Control cannot hand over its credential", () =>
    Effect.gen(function* () {
      vendor.validTokens.add(OCTO_TOKEN);
      const github = fakeSourceControl({ [OCTO_TOKEN]: "octo" });
      const harness = yield* makeHarness({ github: github.service });
      const connector = yield* connectGitHub(harness);
      github.state.failing = true;
      const answered = yield* harness.proxy(connector.connectorId, toolCall(1));
      expect(yield* readText(answered)).toContain("Retry shortly");
      const after = (yield* harness.runtime.list()).connectors[0];
      expect(after?.status).toBe("connected");
      expect(after?.lastError).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("connects GitHub on its own and keeps the user's choices until they remove it", () =>
    Effect.gen(function* () {
      const github = fakeSourceControl({ [OCTO_TOKEN]: "octo" });
      const harness = yield* makeHarness({ github: github.service });
      const restart = makeConnectorRuntime({ stateDir: harness.config.stateDir }).pipe(
        Effect.provideService(GitHubSourceControlCredential, github.service),
      );
      const [added] = (yield* harness.runtime.list()).connectors;
      expect(added).toMatchObject({
        url: `${vendor.base}/gh/mcp/`,
        status: "connected",
        enabled: true,
        availability: { type: "all-projects" },
        auth: { type: "source-control", account: "octo" },
      });
      const availability = { type: "projects", projectIds: [PROJECT] } as const;
      yield* harness.runtime.update({
        connectorId: added!.connectorId,
        enabled: false,
        availability,
      });
      expect((yield* (yield* restart).list()).connectors).toMatchObject([
        { connectorId: added!.connectorId, enabled: false, availability },
      ]);

      yield* harness.runtime.remove({ connectorId: added!.connectorId });
      expect((yield* (yield* restart).list()).connectors).toEqual([]);

      // Adding it again is the user's go: it stays, and is never added twice.
      vendor.validTokens.add(OCTO_TOKEN);
      yield* connectGitHub(harness);
      expect((yield* (yield* restart).list()).connectors).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );
});

/** A stdio MCP server: echoes its key, argument and folder; `MODE=crash` fails on first input. */
const LOCAL_SERVER = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.MODE === "crash") {
    process.stderr.write("boom: missing config\\n");
    process.exit(3);
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "local-echo", version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "whoami", inputSchema: { type: "object" } }] } });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [
      { type: "text", text: JSON.stringify({ greeting: process.argv[2], cwd: process.cwd() }) },
      { type: "text", text: process.env.TOKEN }] } });
  }
});
`;

const LOCAL_KEY = "sk-local-0123456789abcdef";

const writeBundle = (file: string) =>
  Effect.promise(async () => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.from(
        JSON.stringify({
          manifest_version: "0.3",
          name: "local-echo",
          display_name: "Local Echo",
          version: "1.2.0",
          description: "Echoes what it was started with.",
          author: { name: "Scient tests" },
          server: {
            type: "node",
            entry_point: "server/index.mjs",
            mcp_config: {
              command: "node",
              args: ["${__dirname}/server/index.mjs", "${user_config.greeting}"],
              env: { TOKEN: "${user_config.api_key}" },
            },
          },
          user_config: {
            api_key: { type: "string", title: "API key", sensitive: true, required: true },
            greeting: { type: "string", title: "Greeting", default: "hi" },
          },
        }),
      ),
      "manifest.json",
    );
    zip.addBuffer(Buffer.from(LOCAL_SERVER), "server/index.mjs");
    zip.end();
    await NodeStreamPromises.pipeline(zip.outputStream, NodeFS.createWriteStream(file));
  });

const readEvents = (response: Response) =>
  Effect.promise(async () => {
    const text = await response.text();
    return text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
  });

/** Accounts with API-key accounts kept in memory, as local connectors use them. */
const fakeKeyAccounts = () => {
  const keys = new Map<string, { name: string; value: string; envName?: string }>();
  let next = 0;
  let revision = 0;
  const summaries = () =>
    [...keys].map(([accountId, key]) => ({
      accountId,
      name: key.name,
      details: {
        kind: "api-key",
        sites: [],
        auth: { type: "bearer" },
        ...(key.envName === undefined ? {} : { envName: key.envName }),
      },
      secrets: { token: { source: { type: "scient" } } },
      controls: { access: "allowed" },
    }));
  const layer = Layer.mock(AccountsService)({
    snapshot: Effect.sync(() => ({ accounts: summaries() }) as never),
    bindingRevision: Effect.sync(() => revision),
    save: (input) =>
      Effect.sync(() => {
        const accountId =
          input.accountId ?? AccountId.make(`acc_localkey${String(++next).padStart(4, "0")}`);
        const token = input.secrets.token;
        revision += 1;
        keys.set(accountId, {
          name: input.name,
          value: token?.type === "scient" ? token.value : "",
          ...(input.details.kind === "api-key" && input.details.envName !== undefined
            ? { envName: input.details.envName }
            : {}),
        });
        return { accountId };
      }),
    remove: (accountId) => Effect.sync(() => void keys.delete(accountId)),
    resolveBound: (ref, consumer) =>
      Effect.suspend(() => {
        const accountId = ref.replace(/^account:/, "").replace(/:token$/, "");
        const key = keys.get(accountId);
        return key === undefined || consumer.kind !== "local-connector"
          ? Effect.fail(
              new AccountsError({ reason: "not-found", message: "Synthetic key unavailable." }),
            )
          : Effect.succeed(Redacted.make(key.value));
      }),
  });
  return { keys, layer };
};

describe("local connectors", () => {
  it.live(
    "runs a bundle per agent session through the proxy, with its key only in its environment",
    () =>
      Effect.gen(function* () {
        const accounts = fakeKeyAccounts();
        const harness = yield* makeHarness().pipe(Effect.provide(accounts.layer));
        const archive = NodePath.join(harness.config.stateDir, "..", "local-echo.mcpb");
        yield* writeBundle(archive);
        const inspected = yield* harness.runtime.inspectLocal({ path: archive });
        expect(inspected).toMatchObject({
          kind: "bundle",
          displayName: "Local Echo",
          runtime: "node",
          fields: [
            { key: "api_key", sensitive: true, required: true, envName: "TOKEN" },
            { key: "greeting", sensitive: false, default: "hi" },
          ],
        });

        const added = yield* harness.runtime.add({
          target: {
            type: "local-bundle",
            path: archive,
            settings: { greeting: "hello" },
            keys: { api_key: { type: "value", value: LOCAL_KEY } },
          },
        });
        const connectorId = added.connector.connectorId;
        harness.delivered.add(connectorId);
        expect(added.connector.local).toMatchObject({
          kind: "bundle",
          version: "1.2.0",
          running: 0,
          missing: [],
          setup: [{ field: { key: "api_key" }, account: "Local Echo API key" }, { value: "hello" }],
        });
        // The key is an Accounts key; nothing of it is on the connector.
        expect([...accounts.keys.values()]).toMatchObject([{ value: LOCAL_KEY }]);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(harness.statePath, "utf8")),
        ).not.toContain(LOCAL_KEY);

        const opened = yield* harness.proxy(connectorId, initialize(1));
        expect(opened.headers.get("content-type")).toBe("text/event-stream");
        const session = opened.headers.get("mcp-session-id")!;
        expect(yield* readEvents(opened)).toMatchObject([
          { id: 1, result: { serverInfo: { name: "local-echo" } } },
        ]);
        const called = yield* readEvents(
          yield* harness.proxy(connectorId, toolCall(2), { session }),
        );
        // The program got its key and argument and runs in its own folder; an echoed key is redacted.
        const [first, second] = (called[0] as { result: { content: Array<{ text: string }> } })
          .result.content;
        expect(JSON.parse(first!.text)).toMatchObject({ greeting: "hello" });
        expect(JSON.parse(first!.text).cwd).toContain(NodePath.join("connectors", "local-echo-"));
        expect(second!.text).toBe("[redacted by Scient]");

        // A second agent session gets its own process.
        const other = yield* harness.proxy(connectorId, initialize(1), {
          token: OTHER_AGENT_TOKEN,
        });
        expect(other.headers.get("mcp-session-id")).not.toBe(session);
        yield* readEvents(other);
        const running = (yield* harness.runtime.list()).connectors.find(
          (connector) => connector.connectorId === connectorId,
        );
        expect(running?.local?.running).toBe(2);

        const closed = yield* harness.request(connectorId, { method: "DELETE", session });
        expect(closed.status).toBe(204);
        const test = yield* harness.runtime.test({ connectorId });
        expect(test).toMatchObject({
          outcome: "ok",
          serverName: "local-echo",
          tools: [{ name: "whoami" }],
        });

        const folder = added.connector.local!.directory;
        yield* harness.runtime.remove({ connectorId });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(folder).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        // Its key stays in Accounts for the user.
        expect(accounts.keys.size).toBe(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("adds a registry bundle only when its download matches the listed checksum", () =>
    Effect.gen(function* () {
      const accounts = fakeKeyAccounts();
      const config = yield* ServerConfig.ServerConfig;
      const archive = NodePath.join(config.stateDir, "..", "registry-echo.mcpb");
      yield* writeBundle(archive);
      const bytes = yield* Effect.promise(() => NodeFSP.readFile(archive));
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const harness = yield* makeHarness({
        bundleFetch: async (url) =>
          String(url) === "https://example.com/echo.mcpb"
            ? new Response(bytes)
            : new Response("missing", { status: 404 }),
      }).pipe(Effect.provide(accounts.layer));
      const target = (hash: string) =>
        ({
          type: "registry-bundle",
          name: "example/echo",
          version: "1.2.0",
          bundle: { url: "https://example.com/echo.mcpb", sha256: hash },
        }) as const;
      const refused = yield* Effect.flip(harness.runtime.add({ target: target("0".repeat(64)) }));
      expect(refused.message).toContain("checksum");
      expect((yield* harness.runtime.list()).connectors).toEqual([]);
      const folders = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(config.stateDir, "connectors")),
      );
      expect(folders.filter((name) => !name.startsWith(".scient-setup"))).toEqual([]);

      const added = yield* harness.runtime.add({ target: target(sha256) });
      expect(added.connector).toMatchObject({
        source: { type: "local", registry: { name: "example/echo", version: "1.2.0" } },
        local: { kind: "bundle", owned: true, missing: ["API key"] },
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("is added without its key, says what it needs, and runs once the key is linked", () =>
    Effect.gen(function* () {
      const accounts = fakeKeyAccounts();
      const harness = yield* makeHarness().pipe(Effect.provide(accounts.layer));
      const archive = NodePath.join(harness.config.stateDir, "..", "local-echo.mcpb");
      yield* writeBundle(archive);
      const added = yield* harness.runtime.add({
        target: { type: "local-bundle", path: archive, settings: {}, keys: {} },
      });
      const connectorId = added.connector.connectorId;
      harness.delivered.add(connectorId);
      expect(added.connector.local?.missing).toEqual(["API key"]);
      expect(yield* harness.runtime.test({ connectorId })).toMatchObject({
        outcome: "needs-setup",
        message: "Needs API key.",
      });

      // Until it is set up, Scient answers for it and says how to fix it.
      const opened = yield* harness.proxy(connectorId, initialize(1));
      const session = opened.headers.get("mcp-session-id")!;
      yield* readEvents(opened);
      const asked = yield* readEvents(yield* harness.proxy(connectorId, toolCall(2), { session }));
      expect(asked).toMatchObject([{ id: 2, result: { isError: true } }]);
      expect(JSON.stringify(asked)).toContain("scient_connector_setup");

      yield* harness.runtime.update({
        connectorId,
        localSetup: { settings: {}, keys: { api_key: { type: "value", value: LOCAL_KEY } } },
      });
      // The stand-in stopped; the agent's next session reaches the program.
      expect((yield* harness.proxy(connectorId, toolCall(3), { session })).status).toBe(404);
      const reopened = yield* harness.proxy(connectorId, initialize(4));
      const live = reopened.headers.get("mcp-session-id")!;
      expect(yield* readEvents(reopened)).toMatchObject([
        { id: 4, result: { serverInfo: { name: "local-echo" } } },
      ]);

      // A key changed in Accounts restarts copies holding the old one.
      const [accountId] = [...accounts.keys.keys()];
      yield* AccountsService.pipe(
        Effect.flatMap((service) =>
          service.save({
            accountId: AccountId.make(accountId!),
            name: "Local Echo API key",
            details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
            secrets: { token: { type: "scient", value: `${LOCAL_KEY}-rotated` } },
          }),
        ),
        Effect.provide(accounts.layer),
      );
      // Even when a copy with the new key started first.
      yield* readEvents(
        yield* harness.proxy(connectorId, initialize(6), { token: OTHER_AGENT_TOKEN }),
      );
      expect((yield* harness.proxy(connectorId, toolCall(5), { session: live })).status).toBe(404);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "imports a folder's .mcp.json server, running it there with its key moved to Accounts",
    () =>
      Effect.gen(function* () {
        const accounts = fakeKeyAccounts();
        const harness = yield* makeHarness().pipe(Effect.provide(accounts.layer));
        const folder = yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.join(harness.config.stateDir, "..")),
        );
        const script = NodePath.join(folder, "echo.mjs");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(script, LOCAL_SERVER);
          await NodeFSP.writeFile(
            NodePath.join(folder, ".mcp.json"),
            JSON.stringify({
              mcpServers: {
                echo: {
                  command: process.execPath,
                  args: [script, "from .mcp.json"],
                  env: { TOKEN: LOCAL_KEY, REGION: "eu" },
                },
                remote: { type: "http", url: "https://example.com/mcp" },
                // Neither could start here, so neither is offered.
                off: { command: process.execPath, args: [script], disabled: true },
                elsewhere: { command: "./Other.app/Contents/MacOS/helper", args: ["mcp"] },
                // A pass-through variable its own `env` supplies is not app-only.
                given: {
                  command: process.execPath,
                  args: [script],
                  env: { SCIENT_TEST_REGION: "eu" },
                  env_vars: ["SCIENT_TEST_REGION"],
                },
              },
            }),
          );
        });
        const inspected = yield* harness.runtime.inspectLocal({ path: folder });
        expect(inspected).toMatchObject({
          kind: "servers",
          servers: [{ name: "echo", keys: ["TOKEN"] }, { name: "given" }],
        });
        const added = yield* harness.runtime.add({
          target: { type: "local-import", source: { type: "file", path: folder }, name: "echo" },
        });
        const local = added.connector.local!;
        expect(local).toMatchObject({ kind: "import", missing: [] });
        const manifest = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(local.directory, "manifest.json"), "utf8"),
        );
        expect(manifest).not.toContain(LOCAL_KEY);
        expect(JSON.parse(manifest)._meta).toEqual({
          "com.scientfactory.scient": { workingDirectory: folder },
        });
        expect([...accounts.keys.values()]).toMatchObject([{ value: LOCAL_KEY, envName: "TOKEN" }]);

        harness.delivered.add(added.connector.connectorId);
        const opened = yield* harness.proxy(added.connector.connectorId, initialize(1));
        const session = opened.headers.get("mcp-session-id")!;
        yield* readEvents(opened);
        const called = yield* readEvents(
          yield* harness.proxy(added.connector.connectorId, toolCall(2), { session }),
        );
        const [first, second] = (called[0] as { result: { content: Array<{ text: string }> } })
          .result.content;
        expect(JSON.parse(first!.text)).toMatchObject({ greeting: "from .mcp.json", cwd: folder });
        expect(second!.text).toBe("[redacted by Scient]");

        // A key on the command line is never shown or added.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(folder, ".mcp.json"),
            JSON.stringify({
              mcpServers: {
                argv: { command: process.execPath, args: [script, "--api-key", LOCAL_KEY] },
                equals: { command: process.execPath, args: [script, "--password==hunter2"] },
              },
            }),
          ),
        );
        const listed = yield* harness.runtime.inspectLocal({ path: folder });
        expect(JSON.stringify(listed)).not.toContain(LOCAL_KEY);

        // A folder with nothing that could start here says why.
        const appOnly = NodePath.join(folder, "app-only");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(appOnly);
          await NodeFSP.writeFile(
            NodePath.join(appOnly, ".mcp.json"),
            JSON.stringify({ mcpServers: { helper: { command: "./Helper.app/helper" } } }),
          );
        });
        const nothing = yield* harness.runtime.inspectLocal({ path: appOnly }).pipe(Effect.flip);
        expect(nothing.message).toContain(NodePath.join(appOnly, "Helper.app/helper"));

        // A Scient plugin folder is recognized, to be installed as a plugin.
        const plugin = NodePath.join(folder, "plugin");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(plugin);
          await NodeFSP.writeFile(
            NodePath.join(plugin, "scient.plugin.json"),
            JSON.stringify({
              apiVersion: "scient.plugins/v1alpha1",
              id: "acme.lab",
              version: "1.0.0",
              displayName: "Acme Lab",
              description: "Lab notebook guidance.",
              publisher: "Acme",
              contributes: { skills: ["skills/lab-notes"] },
            }),
          );
        });
        expect(yield* harness.runtime.inspectLocal({ path: plugin })).toEqual({
          kind: "plugin",
          displayName: "Acme Lab",
        });
        const refused = yield* harness.runtime
          .add({
            target: { type: "local-import", source: { type: "file", path: folder }, name: "argv" },
          })
          .pipe(Effect.flip);
        expect(refused.message).toContain("--api-key");
        const refusedEquals = yield* harness.runtime
          .add({
            target: {
              type: "local-import",
              source: { type: "file", path: folder },
              name: "equals",
            },
          })
          .pipe(Effect.flip);
        expect(refusedEquals.message).toContain("--password");
      }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "answers with the program's own error when it cannot start, and shows it on the row",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const script = NodePath.join(harness.config.stateDir, "..", "crash.mjs");
        yield* Effect.promise(() => NodeFSP.writeFile(script, LOCAL_SERVER));
        const added = yield* harness.runtime.add({
          target: {
            type: "local-command",
            command: process.execPath,
            args: [script],
            environment: [{ name: "MODE", value: "crash", secret: false }],
          },
          displayName: "Crasher",
        });
        const connectorId = added.connector.connectorId;
        harness.delivered.add(connectorId);
        // A typed command becomes a folder with a manifest Scient wrote.
        const manifest = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(added.connector.local!.directory, "manifest.json"),
              "utf8",
            ),
          ),
        );
        expect(manifest.server.mcp_config).toMatchObject({
          command: process.execPath,
          args: [script],
          env: { MODE: "crash" },
        });
        const answered = yield* readEvents(yield* harness.proxy(connectorId, initialize(7)));
        expect(answered).toMatchObject([
          { id: 7, error: { message: "Crasher could not start: boom: missing config." } },
        ]);
        const row = (yield* harness.runtime.list()).connectors.find(
          (connector) => connector.connectorId === connectorId,
        );
        expect(row?.lastError).toBe("Crasher could not start: boom: missing config.");
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("refuses a bundle that puts its key on the command line", () =>
    Effect.gen(function* () {
      const accounts = fakeKeyAccounts();
      const harness = yield* makeHarness().pipe(Effect.provide(accounts.layer));
      const folder = NodePath.join(harness.config.stateDir, "..", "argv-key");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(folder, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(folder, "manifest.json"),
          JSON.stringify({
            name: "argv-key",
            version: "1.0.0",
            server: {
              type: "node",
              entry_point: "index.mjs",
              mcp_config: { command: "node", args: ["index.mjs", "--key=${user_config.key}"] },
            },
            user_config: { key: { type: "string", title: "Key", sensitive: true, required: true } },
          }),
        );
      });
      const refused = yield* harness.runtime
        .add({
          target: {
            type: "local-bundle",
            path: folder,
            settings: {},
            keys: { key: { type: "value", value: LOCAL_KEY } },
          },
        })
        .pipe(Effect.flip);
      expect(refused.message).toContain("command line");
      expect(accounts.keys.size).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );
});

/** A connector an agent writes: logs a line, then answers `version` with its manifest version. */
const AGENT_SERVER = `
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
process.stderr.write("starting " + manifest.version + "\\n");
if (process.env.MODE === "broken") { process.stderr.write("cannot find module ./lib.mjs\\n"); process.exit(1); }
// MODE "gate:<file>": answers its first message only once <file> exists.
const gate = process.env.MODE?.startsWith("gate:") ? process.env.MODE.slice(5) : undefined;
const opened = gate === undefined ? Promise.resolve() : new Promise((resolve) => {
  const check = () => { if (existsSync(gate)) { watcher.close(); resolve(); } };
  const watcher = watch(dirname(gate), check);
  writeFileSync(gate + ".started", "");
  check();
});
const send = (message) => opened.then(() => process.stdout.write(JSON.stringify(message) + "\\n"));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "agent-made", version: manifest.version } } });
  else if (message.method === "tools/list")
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "version", description: "Its version.", inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call")
    send({ jsonrpc: "2.0", id: message.id, result: { content: [
      { type: "text", text: "version " + manifest.version + (process.env.TOKEN ? " with key" : "") }] } });
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

const writeConnectorFolder = (
  folder: string,
  options: {
    readonly version: string;
    readonly mode?: string;
    readonly meta?: unknown;
    readonly keyRequired?: boolean;
  },
) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(folder, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(folder, "manifest.json"),
      JSON.stringify({
        manifest_version: "0.3",
        name: "agent-made",
        display_name: "Agent Made",
        version: options.version,
        server: {
          type: "node",
          entry_point: "server.mjs",
          mcp_config: {
            command: "node",
            args: ["${__dirname}/server.mjs"],
            env: { TOKEN: "${user_config.api_key}", MODE: options.mode ?? "" },
          },
        },
        user_config: {
          api_key: {
            type: "string",
            title: "API key",
            sensitive: true,
            required: options.keyRequired ?? true,
          },
        },
        ...(options.meta === undefined
          ? {}
          : { _meta: { "com.scientfactory.scient": options.meta } }),
      }),
    );
    await NodeFSP.writeFile(NodePath.join(folder, "server.mjs"), AGENT_SERVER);
  });

/** Plays npm: installs a tiny MCP server package whose code needs a dependency beside it. */
const FAKE_NPM: RunTool = (_tool, args) =>
  Effect.promise(async () => {
    const modules = NodePath.join(args[args.indexOf("--prefix") + 1]!, "node_modules");
    const files: Record<string, string> = {
      "@acme/mcp/package.json": JSON.stringify({
        name: "@acme/mcp",
        version: "1.0.0",
        type: "module",
        bin: { mcp: "./bin/server.js" },
      }),
      "@acme/mcp/lib/tools.js": "export const description = 'Search mail';\n",
      "@acme/mcp/bin/server.js": PACKAGE_SERVER,
      "dep/package.json": JSON.stringify({ name: "dep", type: "module", main: "index.js" }),
      "dep/index.js": "export const hi = () => 'dep says hi';\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(modules, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(modules, path), text);
    }
  });

const PACKAGE_SERVER = `
import { createInterface } from "node:readline";
import { hi } from "dep";
import { description } from "../lib/tools.js";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "acme", version: "1.0.0" } } });
  else if (message.method === "tools/list")
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "search", description, inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call")
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: hi() }] } });
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

/** Resolves once `path` exists, watching its folder rather than polling. */
const appears = (path: string) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!NodeFS.existsSync(path)) return;
          watcher.close();
          resolve();
        };
        const watcher = NodeFS.watch(NodePath.dirname(path), check);
        check();
      }),
  );

/** Accounts stand-ins with one website sign-in per site, so a manifest's site picks its account. */
const siteSignIns = (sites: Readonly<Record<string, string>>): ConnectorSessionsShape => {
  const accounts = Object.entries(sites).map(
    ([site, accountId]) =>
      ({
        accountId,
        name: accountId,
        details: { kind: "website", sites: [site] },
      }) as unknown as AccountSummary,
  );
  const ready = Effect.succeed({ environment: {}, hide: [] });
  return {
    accountsFor: (site) =>
      Effect.succeed(
        accounts.filter((account) =>
          (account.details as { readonly sites: ReadonlyArray<string> }).sites.includes(site),
        ),
      ),
    account: (accountId) =>
      Effect.succeed(accounts.find((account) => account.accountId === accountId)),
    prepare: () => ready,
    signInAgain: () => ready,
    allowed: () => Effect.succeed(true),
    remove: () => Effect.void,
  };
};

const versionOf = (folder: string) =>
  Effect.promise(
    async () =>
      (
        JSON.parse(await NodeFSP.readFile(NodePath.join(folder, "manifest.json"), "utf8")) as {
          version: string;
        }
      ).version,
  );

describe("connectors agents run", () => {
  const noBrowser = () => Effect.succeed(false);

  it.live("lists, adds from Discover and switches a connector as the page does", () =>
    Effect.gen(function* () {
      const accounts = fakeKeyAccounts();
      const config = yield* ServerConfig.ServerConfig;
      const archive = NodePath.join(config.stateDir, "..", "agent-echo.mcpb");
      yield* writeBundle(archive);
      const bytes = yield* Effect.promise(() => NodeFSP.readFile(archive));
      const harness = yield* makeHarness({ bundleFetch: async () => new Response(bytes) }).pipe(
        Effect.provide(accounts.layer),
      );
      const echo: DiscoverEntry = {
        name: "io.example/echo",
        version: "1.2.0",
        title: "Echo",
        remotes: [],
        categories: [],
        installable: true,
        localBundle: {
          url: "https://example.com/echo.mcpb",
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        },
      };
      const docker: DiscoverEntry = {
        name: "io.example/docker",
        version: "1.0.0",
        remotes: [],
        categories: [],
        installable: false,
        unsupportedReason: "Runs in Docker, which Scient doesn't start",
      };
      let installed: ConnectorId | undefined;
      const known = () => [
        installed === undefined ? echo : { ...echo, installedConnectorId: installed },
        docker,
      ];
      const discover = Layer.mock(ExtensionsDiscover)({
        entry: ({ name }) => {
          const found = known().find((entry) => entry.name === name);
          return found === undefined
            ? Effect.fail(new ExtensionsError({ reason: "not-found", message: "Not listed." }))
            : Effect.succeed(found);
        },
        search: ({ scope }) =>
          Effect.succeed({
            entries: scope === "registry" ? known() : [],
            fetchedAt: "2026-11-11T00:00:00.000Z",
          }),
      });
      const agent = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.provideService(ConnectorRuntime, harness.runtime),
          Effect.provide(discover),
        );

      const added = yield* agent(addConnector({ from: echo.name }));
      expect(added).toMatchObject({ status: "needs-setup", missing: ["API key"], tools: [] });
      // regression: what an agent added was shown as the user's change.
      expect((yield* harness.runtime.list()).connectors[0]?.local?.changedBy).toBe("agent");
      expect(added.message).toContain("scient_connector_setup");
      installed = (yield* harness.runtime.list()).connectors[0]!.connectorId;
      expect((yield* agent(addConnector({ from: echo.name }))).message).toContain("already added");
      const refused = yield* Effect.flip(agent(addConnector({ from: docker.name })));
      expect(refused.message).toContain("Runs in Docker");

      const row = {
        connector: added.connector,
        name: "Echo",
        kind: "local",
        on: true,
        status: "needs-setup",
        missing: ["API key"],
      };
      expect(yield* agent(listConnectors({ query: "echo" }))).toEqual({
        connectors: [row],
        found: [
          { name: echo.name, title: "Echo", addable: false, added: added.connector },
          { name: docker.name, addable: false, reason: docker.unsupportedReason },
        ],
      });

      yield* agent(controlConnector({ connector: added.connector, action: "off" }, noBrowser));
      expect((yield* agent(listConnectors({}))).connectors).toEqual([
        { ...row, on: false, status: "off" },
      ]);
      const on = yield* agent(
        controlConnector({ connector: added.connector, action: "on" }, noBrowser),
      );
      expect(on).toMatchObject({ status: "needs-setup" });
      expect(
        (yield* agent(controlConnector({ connector: "Echo", action: "restart" }, noBrowser)))
          .message,
      ).toContain("restarted");
      const local = yield* Effect.flip(
        agent(controlConnector({ connector: "Echo", action: "sign-in" }, noBrowser)),
      );
      expect(local.message).toContain("scient_connector_setup");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("tests a hosted connector and opens its sign-in for the user", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const config = yield* ServerConfig.ServerConfig;
      const added = yield* harness.addSecure();
      const server = added.connector.serverName;
      const agent = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.provideService(ConnectorRuntime, harness.runtime),
          Effect.provideService(ServerConfig.ServerConfig, { ...config, port: 4777 }),
        );

      const checked = yield* agent(testConnector(server, undefined));
      expect(checked).toMatchObject({ ok: false, tools: [] });
      expect(checked.error).toContain('"action":"sign-in"');

      const opened: string[] = [];
      const signIn = yield* agent(
        controlConnector({ connector: server, action: "sign-in" }, (url) =>
          Effect.sync(() => opened.push(url) > 0),
        ),
      );
      expect(signIn).toMatchObject({ status: "needs-sign-in" });
      expect(signIn.message).toContain("Opened Vendor's sign-in");
      expect(signIn).not.toHaveProperty("signInUrl");
      expect(new URL(opened[0]!).searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:4777/oauth/connectors/callback",
      );
      // Without a browser in the chat, the agent gets the link to give the user.
      const linked = yield* agent(
        controlConnector({ connector: server, action: "sign-in" }, noBrowser),
      );
      expect(linked.signInUrl).toContain(`${vendor.base}/as/authorize`);

      const restart = yield* Effect.flip(
        agent(controlConnector({ connector: server, action: "restart" }, noBrowser)),
      );
      expect(restart.message).toContain("runs online");
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("connectors agents make and fix", () => {
  it.live("checks a folder without its key, saves it with history, and Undo walks back", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const work = NodePath.join(harness.config.stateDir, "..", "chat", "connectors", "agent-made");
      yield* writeConnectorFolder(work, { version: "1.0.0" });

      const checked = yield* harness.runtime.checkFolder(
        { folder: work, calls: [{ tool: "version" }] },
        undefined,
      );
      // Templates must start and list tools without keys; what they ran without is reported.
      expect(checked).toMatchObject({
        ok: true,
        tools: [{ name: "version", description: "Its version." }],
        calls: [{ tool: "version", isError: false, text: "version 1.0.0" }],
        missing: ["API key"],
      });
      expect(checked.log).toContain("starting 1.0.0");

      const saved = yield* harness.runtime.saveFolder({ folder: work }, undefined);
      expect(saved.tools).toEqual(["version"]);
      const connectorId = saved.connector.connectorId;
      expect(saved.connector.local).toMatchObject({
        owned: true,
        changedBy: "agent",
        // Undoing a creation would delete it for good; Remove (with its own Undo) is offered.
        canUndo: false,
        missing: ["API key"],
      });
      const installed = saved.connector.local!.directory;
      expect(NodePath.dirname(installed)).toBe(
        NodePath.join(harness.config.stateDir, "connectors"),
      );

      // A fix replaces the folder in place, keeping the earlier one for Undo.
      yield* writeConnectorFolder(work, { version: "1.1.0" });
      const fixed = yield* harness.runtime.saveFolder(
        { folder: work, connector: saved.connector.serverName },
        undefined,
      );
      expect(fixed.connector.connectorId).toBe(connectorId);
      expect(yield* versionOf(installed)).toBe("1.1.0");

      yield* harness.runtime.undo({ connectorId });
      expect(yield* versionOf(installed)).toBe("1.0.0");
      const afterUndo = (yield* harness.runtime.list()).connectors.find(
        (item) => item.connectorId === connectorId,
      );
      expect(afterUndo?.local?.changedBy).toBe("you");

      // Remove keeps a copy; Undo brings the same connector back.
      yield* harness.runtime.remove({ connectorId });
      expect((yield* harness.runtime.list()).connectors).toEqual([]);
      yield* harness.runtime.undo({ connectorId });
      const back = (yield* harness.runtime.list()).connectors;
      expect(back).toMatchObject([{ connectorId, local: { directory: installed } }]);
      expect(yield* versionOf(installed)).toBe("1.0.0");

      const exported = yield* harness.runtime.exportLocal({ connectorId });
      expect(exported.fileName).toBe("agent-made.mcpb");
      expect(Buffer.from(exported.base64, "base64").toString("latin1")).toContain("manifest.json");

      // Undoing the creation removes it.
      yield* harness.runtime.undo({ connectorId });
      expect((yield* harness.runtime.list()).connectors).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(installed).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("copies a package connector with its code, which starts, saves and exports", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ runTool: FAKE_NPM });
      const added = yield* harness.runtime.add({
        target: {
          type: "local-package",
          name: "io.example/acme",
          version: "1.0.0",
          package: {
            runner: "npx",
            identifier: "@acme/mcp",
            version: "1.0.0",
            args: [],
            environment: [],
          },
          environment: [],
        },
      });
      const connectorId = added.connector.connectorId;
      const chat = NodePath.join(harness.config.stateDir, "..", "chat");
      const copied = yield* harness.runtime.copyForAgent({
        workingFolder: chat,
        connector: connectorId,
      });
      expect(copied).toMatchObject({
        source: expect.stringContaining("@acme/mcp 1.0.0 is in package/"),
      });
      // The agent's edit, in the package's own code.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(copied.folder, "package", "lib", "tools.js"),
          "export const description = 'Search mail, edited';\n",
        ),
      );
      // regression: package copies were checked only for their files, never started.
      const checked = yield* harness.runtime.checkFolder(
        { folder: copied.folder, connector: connectorId, calls: [{ tool: "search" }] },
        undefined,
      );
      expect(checked).toMatchObject({
        ok: true,
        tools: [{ name: "search", description: "Search mail, edited" }],
        calls: [{ tool: "search", isError: false, text: "dep says hi" }],
      });
      const saved = yield* harness.runtime.saveFolder(
        { folder: copied.folder, connector: connectorId },
        undefined,
      );
      expect(saved.tools).toEqual(["search"]);
      const exported = yield* harness.runtime.exportLocal({ connectorId });
      const zip = Buffer.from(exported.base64, "base64").toString("latin1");
      expect(zip).toContain("package/lib/tools.js");
      expect(zip).toContain("node_modules/dep/index.js");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("says a saved connector is off when the user turned it off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const work = NodePath.join(harness.config.stateDir, "..", "chat", "connectors", "agent-made");
      yield* writeConnectorFolder(work, { version: "1.0.0", keyRequired: false });
      const saved = yield* harness.runtime.saveFolder({ folder: work }, undefined);
      const connectorId = saved.connector.connectorId;
      expect(changeReport("Saved", saved.connector, saved.tools)).toMatchObject({
        status: "ready",
        message: expect.stringContaining("on for every project"),
      });
      yield* harness.runtime.update({ connectorId, enabled: false });
      const fixed = yield* harness.runtime.saveFolder(
        { folder: work, connector: connectorId },
        undefined,
      );
      const report = changeReport("Saved", fixed.connector, fixed.tools);
      // regression: a save always said ready and on for every project.
      expect(report).toMatchObject({ status: "off", message: expect.stringContaining("is off") });
      expect(report.message).not.toContain("on for every project");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("exports a connector whose program still runs once unpacked", () =>
    Effect.gen(function* () {
      // Windows runs no file by its mode bits, so there is nothing to keep there.
      if ((yield* HostProcess.Platform) === "win32") return;
      const harness = yield* makeHarness();
      const work = NodePath.join(harness.config.stateDir, "..", "chat", "connectors", "runner");
      yield* writeConnectorFolder(work, { version: "1.0.0", keyRequired: false });
      yield* Effect.promise(async () => {
        const manifest = JSON.parse(
          await NodeFSP.readFile(NodePath.join(work, "manifest.json"), "utf8"),
        );
        manifest.server = {
          type: "binary",
          entry_point: "run",
          mcp_config: { command: "${__dirname}/run", args: [] },
        };
        await NodeFSP.writeFile(NodePath.join(work, "manifest.json"), JSON.stringify(manifest));
        await NodeFSP.writeFile(NodePath.join(work, "run"), `#!/usr/bin/env node\n${AGENT_SERVER}`);
        await NodeFSP.chmod(NodePath.join(work, "run"), 0o755);
      });
      const saved = yield* harness.runtime.saveFolder({ folder: work }, undefined);
      const exported = yield* harness.runtime.exportLocal({
        connectorId: saved.connector.connectorId,
      });
      const bundle = NodePath.join(harness.config.stateDir, "..", "shared.mcpb");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(bundle, Buffer.from(exported.base64, "base64")),
      );
      const added = yield* harness.runtime.add({
        target: { type: "local-bundle", path: bundle, settings: {}, keys: {} },
      });
      // regression: every file was exported 0644, so the unpacked program could not start.
      expect(
        yield* harness.runtime.test({ connectorId: added.connector.connectorId }),
      ).toMatchObject({ outcome: "ok", tools: [{ name: "version" }] });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("lets a save finish before an Undo of the same connector starts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const work = NodePath.join(harness.config.stateDir, "..", "chat", "connectors", "agent-made");
      yield* writeConnectorFolder(work, { version: "1.0.0" });
      const saved = yield* harness.runtime.saveFolder({ folder: work }, undefined);
      const connectorId = saved.connector.connectorId;
      const installed = saved.connector.local!.directory;
      yield* writeConnectorFolder(work, { version: "1.1.0" });
      yield* harness.runtime.saveFolder({ folder: work, connector: connectorId }, undefined);

      const gate = NodePath.join(harness.config.stateDir, "..", "gate", "open");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(gate), { recursive: true }));
      yield* writeConnectorFolder(work, { version: "1.2.0", mode: `gate:${gate}` });
      const saving = yield* harness.runtime
        .saveFolder({ folder: work, connector: connectorId }, undefined)
        .pipe(Effect.forkScoped);
      // The save is in its check; an Undo now must wait for it rather than run inside it.
      yield* appears(`${gate}.started`);
      const undoing = yield* harness.runtime.undo({ connectorId }).pipe(Effect.forkScoped);
      yield* Effect.promise(() => NodeFSP.writeFile(gate, ""));
      yield* Fiber.join(saving);
      yield* Fiber.join(undoing);
      // regression: Undo ran during the save, which then wrote over what it restored.
      expect(yield* versionOf(installed)).toBe("1.1.0");
      yield* harness.runtime.undo({ connectorId });
      expect(yield* versionOf(installed)).toBe("1.0.0");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("brings back the earlier site's sign-in when Undo restores its manifest", () =>
    Effect.gen(function* () {
      const [siteA, siteB] = ["https://a.example.edu", "https://b.example.edu"];
      const harness = yield* makeHarness({
        signInSessions: siteSignIns({ [siteA]: "acc_site_a", [siteB]: "acc_site_b" }),
      });
      const work = NodePath.join(harness.config.stateDir, "..", "chat", "connectors", "portal");
      const write = (version: string, site: string) =>
        writeConnectorFolder(work, { version, keyRequired: false, meta: { signIn: { site } } });
      yield* write("1.0.0", siteA);
      const saved = yield* harness.runtime.saveFolder({ folder: work }, undefined);
      const connectorId = saved.connector.connectorId;
      expect(saved.connector.local?.signIn).toMatchObject({ site: siteA, accountId: "acc_site_a" });
      yield* write("1.1.0", siteB);
      const moved = yield* harness.runtime.saveFolder(
        { folder: work, connector: connectorId },
        undefined,
      );
      expect(moved.connector.local?.signIn).toMatchObject({ site: siteB, accountId: "acc_site_b" });

      yield* harness.runtime.undo({ connectorId });
      const undone = (yield* harness.runtime.list()).connectors[0]!;
      // regression: Undo restored site A's manifest but kept site B's sign-in.
      expect(undone.local?.signIn).toMatchObject({ site: siteA, accountId: "acc_site_a" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("refuses to save what fails its check, with the program's error output", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const work = NodePath.join(harness.config.stateDir, "..", "chat", "connectors", "broken");
      yield* writeConnectorFolder(work, { version: "1.0.0", mode: "broken" });
      const checked = yield* harness.runtime.checkFolder({ folder: work }, undefined);
      expect(checked.ok).toBe(false);
      expect(checked.log).toContain("cannot find module ./lib.mjs");
      const refused = yield* harness.runtime
        .saveFolder({ folder: work }, undefined)
        .pipe(Effect.flip);
      expect(refused.message).toContain("cannot find module ./lib.mjs");
      expect((yield* harness.runtime.list()).connectors).toEqual([]);

      // A malformed Scient block is a problem to fix, not silently ignored.
      yield* writeConnectorFolder(work, { version: "1.0.0", meta: { signIn: "moodle.test" } });
      const malformed = yield* harness.runtime.checkFolder({ folder: work }, undefined);
      expect(malformed).toMatchObject({ ok: false });
      expect(malformed.error).toContain("is not valid");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("fixes a bundle used in place as the user's own copy, and copies it for an agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const vendor = NodePath.join(harness.config.stateDir, "..", "vendor-bundle");
      yield* writeConnectorFolder(vendor, { version: "2.0.0" });
      const added = yield* harness.runtime.add({
        target: { type: "local-bundle", path: vendor, settings: {}, keys: {} },
      });
      const connectorId = added.connector.connectorId;
      expect(added.connector.local).toMatchObject({ owned: false, changedBy: "you" });

      const chat = NodePath.join(harness.config.stateDir, "..", "chat");
      const copied = yield* harness.runtime.copyForAgent({
        workingFolder: chat,
        connector: added.connector.serverName,
      });
      expect(copied).toMatchObject({
        folder: NodePath.join(chat, "connectors", "agent-made"),
        status: "needs-setup",
        missing: ["API key"],
        manifest: { name: "agent-made", version: "2.0.0", runtime: "node" },
      });
      // A later copy of the same connector replaces this one; other files are never touched.
      yield* harness.runtime.copyForAgent({ workingFolder: chat, connector: connectorId });
      const other = NodePath.join(chat, "connectors", "elsewhere");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(other, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(other, "notes.txt"), "mine");
      });
      const beside = yield* harness.runtime.copyForAgent({
        workingFolder: chat,
        name: "Elsewhere",
      });
      expect(beside.folder).toBe(NodePath.join(chat, "connectors", "elsewhere-2"));
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(other, "notes.txt"), "utf8")),
      ).toBe("mine");

      yield* writeConnectorFolder(copied.folder, { version: "2.0.1" });
      const forked = yield* harness.runtime.saveFolder(
        { folder: copied.folder, connector: added.connector.serverName },
        undefined,
      );
      expect(forked.connector.local).toMatchObject({
        owned: true,
        forkedFrom: "Agent Made",
        changedBy: "agent",
      });
      expect(forked.connector.local!.directory).not.toBe(vendor);
      // The vendor's bundle is never edited.
      expect(yield* versionOf(vendor)).toBe("2.0.0");

      yield* harness.runtime.undo({ connectorId });
      const undone = (yield* harness.runtime.list()).connectors.find(
        (item) => item.connectorId === connectorId,
      );
      expect(undone?.local).toMatchObject({ directory: vendor, owned: false });
      expect(undone?.local?.forkedFrom).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps a connector's error output on disk and says when its sign-in is missing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const plain = NodePath.join(harness.config.stateDir, "..", "plain-bundle");
      yield* writeConnectorFolder(plain, { version: "3.0.0", keyRequired: false, mode: "broken" });
      const added = yield* harness.runtime.add({
        target: { type: "local-bundle", path: plain, settings: {}, keys: {} },
      });
      const connectorId = added.connector.connectorId;
      expect(yield* harness.runtime.test({ connectorId })).toMatchObject({
        outcome: "error",
        message: expect.stringContaining("cannot find module ./lib.mjs"),
      });
      const log = NodePath.join(harness.config.stateDir, "connector-logs", `${connectorId}.log`);
      expect(yield* Effect.promise(() => NodeFSP.readFile(log, "utf8"))).toContain(
        "starting 3.0.0",
      );
      const copied = yield* harness.runtime.copyForAgent({
        workingFolder: NodePath.join(harness.config.stateDir, "..", "chat"),
        connector: connectorId,
      });
      expect(copied).toMatchObject({ log: expect.stringContaining("starting 3.0.0") });
      yield* harness.runtime.remove({ connectorId });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(log).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);

      const portal = NodePath.join(harness.config.stateDir, "..", "portal-bundle");
      yield* writeConnectorFolder(portal, {
        version: "1.0.0",
        keyRequired: false,
        meta: { signIn: { site: "https://moodle.example.edu/login" } },
      });
      const signedIn = yield* harness.runtime.add({
        target: { type: "local-bundle", path: portal, settings: {}, keys: {} },
      });
      expect(signedIn.connector.local).toMatchObject({
        signIn: { site: "https://moodle.example.edu", state: "missing" },
        missing: ["Sign-in to moodle.example.edu"],
      });
      expect(
        yield* harness.runtime.test({ connectorId: signedIn.connector.connectorId }),
      ).toMatchObject({ outcome: "needs-setup" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("never copies through a link out of the chat's folder", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const outside = NodePath.join(harness.config.stateDir, "..", "elsewhere");
      const chat = NodePath.join(harness.config.stateDir, "..", "chat-linked");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(outside, "open-works"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(outside, "open-works", "keep.txt"), "mine");
        await NodeFSP.mkdir(chat, { recursive: true });
        await NodeFSP.symlink(outside, NodePath.join(chat, "connectors"));
      });
      // regression: copy wrote (and replaced) folders at the link's other end.
      const refused = yield* harness.runtime
        .copyForAgent({ workingFolder: chat, name: "Open Works" })
        .pipe(Effect.flip);
      expect(refused.message).toContain("is a link to another folder");

      // A linked folder in a real connectors folder is skipped, never removed or written.
      const second = NodePath.join(harness.config.stateDir, "..", "chat-second");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(second, "connectors"), { recursive: true });
        await NodeFSP.symlink(
          NodePath.join(outside, "open-works"),
          NodePath.join(second, "connectors", "open-works"),
        );
      });
      const copied = yield* harness.runtime.copyForAgent({
        workingFolder: second,
        name: "Open Works",
      });
      expect(copied.folder).toBe(NodePath.join(second, "connectors", "open-works-2"));
      expect(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(outside, "open-works"))),
      ).toEqual(["keep.txt"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "writes the connector-authoring template, which starts and lists its tools with no key",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const chat = NodePath.join(harness.config.stateDir, "..", "chat");
        const copied = yield* harness.runtime.copyForAgent({
          workingFolder: chat,
          name: "Open Works",
        });
        expect(copied.folder).toBe(NodePath.join(chat, "connectors", "open-works"));
        const manifest = yield* Effect.promise(async () =>
          JSON.parse(await NodeFSP.readFile(NodePath.join(copied.folder, "manifest.json"), "utf8")),
        );
        expect(manifest).toMatchObject({ name: "open-works", display_name: "Open Works" });
        const checked = yield* harness.runtime.checkFolder({ folder: copied.folder }, undefined);
        expect(checked.ok).toBe(true);
        expect(checked.tools.map((tool) => tool.name).sort()).toEqual(["get_work", "search_works"]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps a signed-in connector's short cookie from agents", () =>
    Effect.gen(function* () {
      const portal = yield* signedInPortal(["s6k9xq"]);
      const called = yield* portal.call(2);
      // regression: cookies used the 16-character key minimum, so a 6-character one got through.
      expect(JSON.stringify(called)).not.toContain("s6k9xq");
      expect(JSON.stringify(called)).toContain("[redacted by Scient]");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("hides the cookies of a new sign-in in the retried answer", () =>
    Effect.gen(function* () {
      const portal = yield* signedInPortal(["old-session-value-1"], ["fresh-session-value-2"]);
      const called = yield* portal.call(2);
      expect(portal.state.signIns).toBe(1);
      // regression: the answer was checked against the cookies from before the new sign-in.
      expect(JSON.stringify(called)).not.toContain("fresh-session-value-2");
      expect(JSON.stringify(called)).toContain("[redacted by Scient]");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps a connector's session out of both checks, in any encoding and every field", () =>
    Effect.gen(function* () {
      const cookie = "portal-session-0123456789abcdef";
      const leak = Buffer.from(cookie).toString("base64");
      const portal = yield* signedInPortal([cookie], [cookie], LEAKY_SESSION_SERVER);
      const installed = yield* portal.harness.runtime.test({ connectorId: portal.connectorId });
      const folder = yield* portal.harness.runtime.checkFolder(
        { folder: portal.folder, connector: portal.connectorId, calls: [{ tool: "find" }] },
        undefined,
      );
      // regression: checks hid only literal values, and the installed one never knew the cookies.
      for (const checked of [installed, folder]) {
        const shown = JSON.stringify(checked);
        expect(shown).not.toContain(leak);
        expect(shown).not.toContain(cookie);
        expect(checked.tools.map((tool) => tool.name)).toEqual(["find", "[redacted by Scient]"]);
      }
      expect(folder.tools[0]).toMatchObject({
        description: "Session [redacted by Scient] here.",
        parameters: { properties: { q: { description: "[redacted by Scient]" } } },
      });
      expect(folder.calls[0]).toMatchObject({ isError: true });
      expect(folder.log).toContain("using [redacted by Scient]");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("tests a connector for an agent with only the sign-ins its project may use", () =>
    Effect.gen(function* () {
      const cookie = "portal-session-0123456789abcdef";
      const portal = yield* signedInPortal([cookie], [cookie], LEAKY_SESSION_SERVER);
      portal.state.project = PROJECT;
      const agent = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(ConnectorRuntime, portal.harness.runtime));
      const server = (yield* portal.harness.runtime.list()).connectors[0]!.serverName;
      // regression: an agent's test ran without its project, so Accounts' scope was skipped.
      const elsewhere = yield* agent(
        testConnector(server, { projectId: OTHER_PROJECT, worktreePath: null }),
      );
      expect(elsewhere.ok).toBe(false);
      expect(elsewhere.error).toContain("not available in this project");
      expect(
        yield* agent(testConnector(server, { projectId: PROJECT, worktreePath: null })),
      ).toMatchObject({ ok: true });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("stops a signed-in connector and drops its session when the sign-in is revoked", () =>
    Effect.gen(function* () {
      const portal = yield* signedInPortal(["portal-session-0123456789abcdef"]);
      yield* portal.call(2);
      portal.state.revoked = true;
      const after = yield* portal.harness.proxy(portal.connectorId, toolCall(3), {
        session: portal.session,
      });
      // regression: running copies kept using the revoked sign-in's cookies.
      expect(after.status).toBe(404);
      expect(portal.state.removed).toEqual([portal.connectorId]);
    }).pipe(Effect.provide(testLayer)),
  );
});

/**
 * A signed-in local connector over Accounts stand-ins: its session holds `cookies`, and a new
 * sign-in hands it `renewed`. Returns an open agent session.
 */
const signedInPortal = Effect.fn("signedInPortal")(function* (
  cookies: ReadonlyArray<string>,
  renewed: ReadonlyArray<string> = cookies,
  server: string = ECHO_SESSION_SERVER,
) {
  const SITE = "https://portal.example.edu";
  const state = {
    cookies: [...cookies],
    revoked: false,
    /** The one project the sign-in is limited to, as Accounts' scope would. */
    project: undefined as string | undefined,
    removed: [] as string[],
    signIns: 0,
  };
  const outOfScope = (projectId: string | undefined) =>
    state.project !== undefined && projectId !== undefined && projectId !== state.project;
  const files = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-portal-session-")),
  );
  const write = Effect.promise(async () => {
    const file = NodePath.join(files, "cookies.json");
    await NodeFSP.writeFile(
      file,
      JSON.stringify(state.cookies.map((value, index) => ({ name: `c${index}`, value }))),
    );
    return { environment: { SCIENT_SIGN_IN_COOKIES: file }, hide: [...state.cookies] };
  });
  const account = {
    accountId: "acc_portal0001",
    name: "Portal",
    details: { kind: "website", sites: [SITE] },
  } as unknown as AccountSummary;
  const signInSessions: ConnectorSessionsShape = {
    accountsFor: () => Effect.succeed([account]),
    account: () => Effect.succeed(state.revoked ? undefined : account),
    prepare: (target) =>
      state.revoked
        ? Effect.fail({ reason: "needs-user", message: "Portal is turned off." })
        : outOfScope(target.projectId)
          ? Effect.fail({
              reason: "needs-user",
              message: "Portal is not available in this project.",
            })
          : write,
    signInAgain: () =>
      Effect.suspend(() => {
        state.signIns += 1;
        state.cookies = [...renewed];
        return write;
      }),
    allowed: (target) => Effect.succeed(!state.revoked && !outOfScope(target.projectId)),
    remove: (connectorId) => Effect.sync(() => void state.removed.push(connectorId)),
  };
  const harness = yield* makeHarness({ signInSessions });
  const folder = NodePath.join(harness.config.stateDir, "..", "portal-bundle");
  yield* writeConnectorFolder(folder, {
    version: "1.0.0",
    keyRequired: false,
    meta: { signIn: { site: SITE } },
  });
  yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(folder, "server.mjs"), server));
  const added = yield* harness.runtime.add({
    target: { type: "local-bundle", path: folder, settings: {}, keys: {} },
  });
  const connectorId = added.connector.connectorId;
  harness.delivered.add(connectorId);
  const opened = yield* harness.proxy(connectorId, initialize(1));
  const session = opened.headers.get("mcp-session-id")!;
  yield* readEvents(opened);
  const call = (id: number) =>
    harness.proxy(connectorId, toolCall(id), { session }).pipe(Effect.flatMap(readEvents));
  return { harness, connectorId, folder, session, state, call };
});

/** Puts its session cookie, base64-encoded, everywhere a check reports: a careless connector. */
const LEAKY_SESSION_SERVER = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const cookie = JSON.parse(readFileSync(process.env.SCIENT_SIGN_IN_COOKIES, "utf8"))[0].value;
const leak = Buffer.from(cookie).toString("base64");
process.stderr.write("using " + leak + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "portal", version: "1" } } });
  else if (message.method === "tools/list")
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "find", description: "Session " + leak + " here.", inputSchema: { type: "object",
        properties: { q: { type: "string", description: "Sent as " + leak } } } },
      { name: "s_" + leak, inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call")
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "denied for " + leak } });
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

/**
 * Echoes the session cookies it was handed, as a careless connector might; a session whose cookie
 * starts with `old-` has ended, which it reports as the template does.
 */
const ECHO_SESSION_SERVER = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "portal", version: "1" } } });
  else if (message.method === "tools/call") {
    const values = JSON.parse(readFileSync(process.env.SCIENT_SIGN_IN_COOKIES, "utf8")).map((c) => c.value);
    send({ jsonrpc: "2.0", id: message.id, result: values[0].startsWith("old-")
      ? { isError: true, content: [{ type: "text", text: "SCIENT_SIGN_IN_EXPIRED: sent to the sign-in page" }] }
      : { content: [{ type: "text", text: "session " + values.join(" ") }] } });
  } else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;
