// @effect-diagnostics nodeBuiltinImport:off -- The test builds a real v1 project folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
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
import { ScientSourcesListResult } from "./tools.ts";

const fixtures: string[] = [];
const decodeToolEnvelope = Schema.decodeUnknownEffect(
  Schema.Struct({ result: McpSchema.CallToolResult }),
);
const decodeSourceList = Schema.decodeUnknownEffect(ScientSourcesListResult);

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
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(
          ServerConfig.ServerConfig.layerTest(base, { prefix: "library-layers-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const library = scientLibraryLocation(scientLibraryRootFor(config.stateDir));
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
        Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
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
      const call = Effect.fn("libraryLayers.call")(function* (id: number, name: string) {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            ...headers,
            "mcp-session-id": initialize.headers["mcp-session-id"]!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: {} },
            }),
            "application/json",
          ),
        });
        expect(response.status).toBe(200);
        const text = yield* response.text;
        const envelope: unknown = text
          .split("\n")
          .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
          .map((line) => JSON.parse(line.replace(/^data: /u, "")) as { id?: number })
          .find((message) => message.id === id);
        const { result } = yield* decodeToolEnvelope(envelope);
        expect(result.isError).not.toBe(true);
        if (result.structuredContent !== undefined) return result.structuredContent;
        const content = result.content.find((entry) => entry.type === "text");
        if (content?.type !== "text") throw new Error("Expected a JSON tool result.");
        return JSON.parse(content.text) as unknown;
      });
      const before = yield* call(2, "scient_sources_list");
      const beforeList = yield* decodeSourceList(before);
      expect(beforeList.records).toMatchObject([{ title: "Study through the server layers" }]);
      expect(beforeList.records[0]?.pinned).not.toBe(true);
      expect(yield* Effect.promise(() => readScientProjectPins(root))).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(library.root).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);

      yield* call(3, "scient_sources_bibliography");
      const after = yield* call(4, "scient_sources_list");
      const afterList = yield* decodeSourceList(after);
      expect(afterList.records).toMatchObject([
        { sourceId: beforeList.records[0]!.sourceId, pinned: true },
      ]);
      const pins = yield* Effect.promise(() => readScientProjectPins(root));
      expect(pins).toHaveLength(1);
      expect(pins[0]?.sourceId).toBe(beforeList.records[0]!.sourceId);
      expect(yield* Effect.promise(() => listScientSourceRecords(library))).toMatchObject([
        { sourceId: beforeList.records[0]!.sourceId, title: "Study through the server layers" },
      ]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(root, ".scient/sources")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
