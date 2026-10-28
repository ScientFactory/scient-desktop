// @effect-diagnostics nodeBuiltinImport:off -- Real loopback HTTP servers, synthetic plugin manifest and keys only.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type * as NodeNet from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpMiddleware } from "effect/http";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { McpSessionRegistry, connectorProxyUrl } from "../../mcp/McpSessionRegistry.ts";
import { claudeMcpQueryOverrides } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeHarness } from "../accounts/Accounts.testkit.ts";
import { accountTokenRef } from "../accounts/AccountBoundRef.ts";
import { makePluginKeyBindings } from "./PluginKeyBindings.ts";
import { preparePluginKeyStartup } from "./PluginKeyStartup.ts";
import { preparePluginKeyHttpDelivery } from "./PluginKeyHttpDelivery.ts";
import { ConnectorRuntime } from "./ExtensionsServices.ts";
import { ConnectorCredentialStore } from "./connectors/ConnectorCredentialStore.ts";
import * as PluginConnectorEligibility from "./plugins/PluginConnectorEligibility.ts";
import { makeConnectorRuntime } from "./connectors/ConnectorRuntime.ts";
import * as ConnectorProxyRoute from "./connectors/ConnectorProxyRoute.ts";

const local = vi.hoisted(() => ({ url: "" }));
// Only the destination is remapped. Exercise the real bounded Undici HTTP transport;
// production's plugin egress policy still rejects loopback destinations.
vi.mock("./connectors/ConnectorOutbound.ts", async (original) => {
  const actual = await original<typeof import("./connectors/ConnectorOutbound.ts")>();
  return {
    ...actual,
    proxyFetch: () => (url: string, init: RequestInit) =>
      actual.proxyFetch({ loopbackOrigin: new URL(local.url).origin })(
        local.url + new URL(url).pathname,
        init,
      ),
  };
});

it.effect.each(["json", "sse", "401", "401-challenge", "401-open"] as const)(
  "completes Claude plugin-key MCP initialization/tools or auth refusal: %s",
  (mode) =>
    Effect.gen(function* () {
      const seen: Array<{ method: string; authorization: string | undefined }> = [];
      const connections = new Set<NodeNet.Socket>();
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = NodeHttp.createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const rpc = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
            connections.add(request.socket);
            seen.push({
              method: rpc.method ?? request.method,
              authorization: request.headers.authorization,
            });
            if (mode.startsWith("401")) {
              response.writeHead(401, {
                "content-type": "application/json",
                ...(mode === "401-challenge"
                  ? {
                      "www-authenticate":
                        'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
                    }
                  : {}),
              });
              const body = JSON.stringify({ error: "synthetic unauthorized" });
              if (mode === "401-open") response.write(body);
              else response.end(body);
              return;
            }
            if (request.method === "GET") {
              response.writeHead(405);
              response.end();
              return;
            }
            if (rpc.id === undefined) {
              response.writeHead(202);
              response.end();
              return;
            }
            const result =
              rpc.method === "initialize"
                ? {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "synthetic", version: "1" },
                  }
                : { tools: [{ name: "synthetic_tool", inputSchema: { type: "object" } }] };
            const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
            response.writeHead(200, {
              "content-type": mode === "sse" ? "text/event-stream" : "application/json",
            });
            if (mode === "sse") response.write(`event: message\ndata: ${body}\n\n`);
            else response.end(body);
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          return server;
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
              }),
          ),
      );
      const address = upstream.address();
      if (!address || typeof address === "string") throw Error("Expected TCP upstream");
      local.url = `http://127.0.0.1:${address.port}`;
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-wire-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              api: {
                type: "http",
                url: "https://api.example.com/mcp",
                headers: { Authorization: "Bearer ${TOKEN}" },
              },
            },
          }),
        ),
      );
      const agent = ProviderInstanceId.make("synthetic-agent");
      const projectId = ProjectId.make("synthetic-project");
      const threadId = ThreadId.make("synthetic-thread");
      const provider: ServerProvider = {
        instanceId: agent,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        models: [],
        skills: [],
        slashCommands: [],
        checkedAt: "2026-10-27T00:00:00Z",
      };
      const actions: ProviderPluginActions = {
        listPlugins: () =>
          Effect.succeed({
            sequence: 1,
            plugins: [
              {
                id: "native-plugin",
                name: "sample@synthetic",
                source: "local",
                enabled: true,
                path: root,
              },
            ],
          }),
        readMcpServer: () => Effect.never,
        uninstall: () => Effect.void,
        startMcpSignIn: () => Effect.fail({ message: "unused" }),
        isRetired: Effect.succeed(false),
        whenRetired: Effect.never,
      };
      const providers = Context.get(
        yield* Layer.build(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([provider]),
            getProviderPluginActionsForInstance: () => Effect.succeed(actions),
          }),
        ),
        ProviderRegistry,
      );
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save({
        name: "Synthetic",
        details: { kind: "api-key", sites: ["example.com"], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value: "synthetic-plugin-token" } },
      });
      const bindings = yield* makePluginKeyBindings(root, service);
      yield* bindings.bind({
        agent,
        pluginId: "native-plugin",
        envName: "TOKEN",
        accountRef: accountTokenRef(accountId),
      });
      const runtime = yield* makeConnectorRuntime({ stateDir: root }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectorCredentialStore)({ recordUse: () => Effect.void }),
            Layer.mock(ProjectStoreV2)({}),
            PluginConnectorEligibility.layer,
            NodeServices.layer,
          ),
        ),
      );
      const policies = yield* preparePluginKeyStartup(providers, agent, root);
      const delivered = yield* preparePluginKeyHttpDelivery(providers, runtime, bindings, {
        agent,
        projectId,
        cwd: root,
        policies,
      });
      const scope: McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("synthetic"),
        capabilities: new Set(),
        issuedAt: 0,
        requestNamespace: "synthetic",
        client: undefined,
        thread: { threadId, providerSessionId: "synthetic-session", providerInstanceId: agent },
        connectorIds: new Set(delivered.connectors.map((c) => c.connectorId)),
      };
      const deps = Layer.mergeAll(
        Layer.succeed(ConnectorRuntime, runtime),
        Layer.mock(McpSessionRegistry)({
          resolve: (token) =>
            Effect.succeed(token === "synthetic-session-bearer" ? scope : undefined),
          touch: () => Effect.void,
        }),
        Layer.mock(ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ projectId } as never),
        }),
      );
      const serverContext = yield* Layer.build(
        HttpRouter.serve(
          ConnectorProxyRoute.layer.pipe(
            Layer.provide(HttpRouter.middleware(HttpMiddleware.compression(), { global: true })),
          ),
          {
            disableLogger: true,
            disableListenLog: true,
          },
        ).pipe(
          Layer.provide(deps),
          Layer.provideMerge(
            NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      );
      const proxyAddress = Context.get(serverContext, HttpServer.HttpServer).address;
      if (typeof proxyAddress === "string" || !("port" in proxyAddress))
        throw Error("Expected TCP proxy");
      const endpoint = `http://127.0.0.1:${proxyAddress.port}/mcp`;
      const config = claudeMcpQueryOverrides({
        readOnlySandbox: false,
        mcpSession: {
          environmentId: scope.environmentId,
          threadId,
          providerSessionId: "synthetic-session",
          providerInstanceId: agent,
          endpoint,
          authorizationHeader: "Bearer synthetic-session-bearer",
          capabilities: new Set(),
          connectors: delivered.connectors.map((connector) => ({
            ...connector,
            url: connectorProxyUrl(endpoint, connector.connectorId),
          })),
          pluginKeyServerNames: delivered.serverNames,
        },
      }).mcpServers?.["plugin:sample:api"];
      if (!config || config.type !== "http") throw Error("Expected Claude HTTP replacement");
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Client({ name: "synthetic-client", version: "1" })),
        (client) => Effect.promise(() => client.close()),
      );
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
      if (mode.startsWith("401")) {
        const outcome = yield* Effect.tryPromise({
          try: () => client.connect(transport as Transport),
          catch: (error) => String(error),
        }).pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(String(outcome.failure)).toContain("rejected the key bound in Scient Accounts");
        expect(seen.filter((request) => request.method === "initialize")).toHaveLength(1);
        expect(seen).toHaveLength(1);
      } else {
        yield* Effect.promise(() => client.connect(transport as Transport));
        const tools = yield* Effect.promise(() => client.listTools());
        if (mode === "json") {
          yield* Effect.promise(() => client.listTools());
          expect(connections.size).toBeLessThan(seen.length);
        }
        expect(tools.tools.map((tool) => tool.name)).toEqual(["synthetic_tool"]);
        expect(seen.some((request) => request.method === "initialize")).toBe(true);
        expect(seen.some((request) => request.method === "tools/list")).toBe(true);
      }
      expect(
        seen.every((request) => request.authorization === "Bearer synthetic-plugin-token"),
      ).toBe(true);
    }),
);
