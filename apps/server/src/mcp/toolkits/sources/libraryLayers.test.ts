// @effect-diagnostics nodeBuiltinImport:off -- The test builds a real v1 project folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import { importScientSource } from "@scientfactory/scient-sources/store";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const environmentId = EnvironmentId.make("environment-library-layers");
const threadId = ThreadId.make("thread-library-layers");
const token = "libraryLayersProviderToken";

async function v1Project(base: string) {
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: {
      sourceKey: "layers",
      type: "article",
      customType: null,
      title: "Study through the server layers",
      creators: [],
      issuedRaw: "2026",
      issuedYear: 2026,
      identifiers: [],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      tags: [],
      externalReferences: [],
      fieldProvenance: [],
      pdfAvailable: false,
      pdfFileName: null,
      pdfAttachmentCount: 0,
    },
  });
  return root;
}

// ServerConfig reaches the handlers only through the layers, as in server.ts: nothing provides
// it to the call. Without it the library backend would die ("needs the server configuration").
it.effect("a library-mode agent tool runs through the real MCP layers with the server config", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.promise(async () =>
        NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-layers-"))),
      );
      fixtures.push(base);
      const root = yield* Effect.promise(() => v1Project(base));
      const projectId = ProjectId.make("project-library-layers");
      const resolver = workspaceResolverForTest(
        new Map([[root, { projectId, scope: workspaceScopeForTest(`binding:${root}`, root) }]]),
      );
      const resolveThread = () =>
        resolver.resolveWorkspaceRoot(root).pipe(
          Effect.map((resolved) => ({
            ...resolved,
            binding: { ...resolved.binding, environmentId, hostProjectId: projectId },
          })),
        );
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["sources:read", "sources:write"]),
        issuedAt: 1,
      };
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.ScientSourcesToolkitRegistrationLive,
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: () => Effect.undefined,
          }),
        ),
        Layer.provide(
          Layer.succeed(WorkspaceBindingResolver, {
            ...resolver,
            resolveThread,
            assertCurrentThreadScope: () =>
              resolveThread().pipe(Effect.map((resolved) => resolved.binding)),
          }),
        ),
        Layer.provide(Layer.succeed(ScientSourcesBackend, "library")),
        Layer.provide(ServerConfig.ServerConfig.layerTest(base, { prefix: "library-layers-" })),
        Layer.provide(NodeServices.layer),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"layers","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initialize.status).toBe(200);
      const called = yield* httpClient.post("/mcp", {
        headers: {
          ...headers,
          "mcp-session-id": initialize.headers["mcp-session-id"]!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scient_sources_list","arguments":{}}}`,
          "application/json",
        ),
      });
      const text = yield* called.text;
      // The write-authorized call moved the project and lists its pin.
      expect(text).toContain('\\"pinned\\":true');
      expect(text).not.toContain('"isError":true');
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, ".scient/library/pins.json"), "utf8"),
        ),
      ).toContain("Study through the server layers");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
