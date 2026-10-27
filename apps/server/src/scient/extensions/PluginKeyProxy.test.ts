// @effect-diagnostics nodeBuiltinImport:off -- Synthetic app-private runtime state, no live endpoint or credentials.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Effect, Layer, Stream } from "effect";
import {
  ConnectorId,
  EnvironmentId,
  ExtensionsError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ConnectorCredentialStore } from "./connectors/ConnectorCredentialStore.ts";
import { makeConnectorRuntime } from "./connectors/ConnectorRuntime.ts";
import * as PluginConnectorEligibility from "./plugins/PluginConnectorEligibility.ts";

const synthetic = vi.hoisted(() => ({
  token: "synthetic-plugin-proxy-token",
  headers: [] as string[],
}));
vi.mock("./connectors/ConnectorOutbound.ts", async (original) => {
  const actual = await original<typeof import("./connectors/ConnectorOutbound.ts")>();
  return {
    ...actual,
    proxyFetch: () => async (_url: string, init: RequestInit) => {
      synthetic.headers.push(new Headers(init.headers).get("authorization") ?? "");
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `Reflected ${synthetic.token}` }] },
      });
    },
  };
});

it.effect(
  "uses the connector proxy pipeline, redacts reflected plugin credentials, and refuses a later revoked request",
  () =>
    Effect.gen(function* () {
      synthetic.headers = [];
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-proxy-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const dependencies = Layer.mergeAll(
        Layer.mock(ConnectorCredentialStore)({ recordUse: () => Effect.void }),
        Layer.mock(ProjectStoreV2)({}),
        PluginConnectorEligibility.layer,
        NodeCrypto.layer,
      );
      const runtime = yield* makeConnectorRuntime({ stateDir: root }).pipe(
        Effect.provide(dependencies),
      );
      const connectorId = ConnectorId.make("con_pluginproxy01");
      const projectId = ProjectId.make("synthetic-project");
      let allowed = true;
      yield* runtime.registerPluginKeyHttp!({
        connectorId,
        projectId,
        serverName: "plugin-proxy",
        displayName: "Synthetic plugin",
        url: "https://api.example.com/mcp",
        authorize: () =>
          allowed
            ? Effect.succeed({
                headers: { Authorization: `Bearer ${synthetic.token}` },
                secrets: [synthetic.token],
              })
            : Effect.fail(
                new ExtensionsError({
                  reason: "state-unavailable",
                  message: "Synthetic revocation",
                }),
              ),
      });
      expect((yield* runtime.list()).connectors).toEqual([]);
      expect(yield* runtime.isGranted({ connectorId, projectId })).toBe(true);
      expect(
        yield* runtime.isGranted({ connectorId, projectId: ProjectId.make("other-project") }),
      ).toBe(false);
      const scope: McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("synthetic"),
        capabilities: new Set(),
        issuedAt: 0,
        requestNamespace: "synthetic",
        client: undefined,
        thread: {
          threadId: ThreadId.make("synthetic-thread"),
          providerSessionId: "synthetic-session",
          providerInstanceId: ProviderInstanceId.make("synthetic-agent"),
        },
        connectorIds: new Set([connectorId]),
      };
      const request = {
        connectorId,
        scope,
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "sample", arguments: {} },
          }),
        ),
      };
      const response = yield* runtime.forward(request);
      const body = yield* response.body.pipe(Stream.runCollect);
      const text = Buffer.concat(body).toString("utf8");
      expect(synthetic.headers).toEqual([`Bearer ${synthetic.token}`]);
      expect(text).not.toContain(synthetic.token);
      allowed = false;
      const refused = yield* runtime.forward(request);
      yield* refused.body.pipe(Stream.runDrain);
      expect(synthetic.headers).toHaveLength(1);
    }),
);
