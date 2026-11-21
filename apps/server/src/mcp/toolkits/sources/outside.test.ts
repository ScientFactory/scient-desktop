// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import { importScientSource } from "@scientfactory/scient-sources/store";
import { EnvironmentId, type AuthMcpClientAccess, type Project } from "@t3tools/contracts";
import { afterEach, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../../auth/McpOAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

// The binding fixture's environment; its host project IDs are `host-<bindingId>`.
const environmentId = EnvironmentId.make("test-environment");
const projectA = "host-binding-a";
const projectB = "host-binding-b";

async function folders() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-outside-")),
  );
  fixtures.push(base);
  const roots = { a: NodePath.join(base, "a"), b: NodePath.join(base, "b") };
  for (const root of Object.values(roots)) {
    await NodeFSP.mkdir(root);
    await initializeScientProject({ root });
  }
  return { base, ...roots };
}

/** Every file under `root` with its size and change time: a write leaves a trace here. */
async function tree(root: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = NodePath.join(entry.parentPath, entry.name);
        const stat = await NodeFSP.stat(path);
        return `${NodePath.relative(root, path)} ${stat.size} ${stat.mtimeMs}`;
      }),
  ).then((lines) => lines.toSorted());
}

interface McpReply {
  readonly result: {
    readonly tools?: ReadonlyArray<{
      readonly name: string;
      readonly inputSchema: { readonly properties: Record<string, unknown> };
    }>;
    readonly content?: ReadonlyArray<{ readonly text: string }>;
    readonly isError?: boolean;
  };
}

const project = (id: string, workspaceRoot: string): Project => ({
  id: id as Project["id"],
  title: id,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
  deletedAt: null,
});

/**
 * The real OAuth client session, MCP transport, tool listing and Sources toolkit over two
 * registered projects and a Library holding one paper no project pins.
 */
const outsideClient = Effect.fn("outsideTest.client")(function* (access: AuthMcpClientAccess) {
  const { base, a, b } = yield* Effect.promise(folders);
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(
      ServerConfig.ServerConfig.layerTest(base, { prefix: "sources-outside-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  const libraryRoot = scientLibraryRootFor(config.stateDir);
  const sourceId = yield* Effect.promise(async () => {
    await ensureScientLibrary(libraryRoot);
    const imported = await importScientSource({
      root: scientLibraryLocation(libraryRoot),
      operationId: NodeCrypto.randomUUID(),
      candidate: {
        sourceKey: "outside",
        type: "article",
        customType: null,
        title: "Sepsis outcomes in adults",
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
    return imported.record!.sourceId;
  });
  const projects = new Map([
    [projectA, project(projectA, a)],
    [projectB, project(projectB, b)],
  ]);
  const layerAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
  );
  const authServices = yield* Layer.build(layerAuth);
  const session = yield* Context.get(
    authServices,
    EnvironmentAuth.EnvironmentAuth,
  ).issueMcpClientSession({
    label: "Outside agent",
    access,
    peerLink: false,
    client: { deviceType: "bot" },
  });
  yield* HttpRouter.serve(
    McpHttpServer.layerMcpTransport(McpHttpServer.ScientSourcesToolkitRegistrationLive).pipe(
      Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mock(ProjectService)({
          getById: (projectId) => Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
        }),
      ),
      Layer.provide(
        Layer.succeed(
          WorkspaceBindingResolver,
          workspaceResolverForTest(
            new Map([
              [a, { projectId: "scient-a", scope: workspaceScopeForTest("binding-a", a) }],
              [b, { projectId: "scient-b", scope: workspaceScopeForTest("binding-b", b) }],
            ]),
          ),
        ),
      ),
      Layer.provide(Layer.succeed(ScientSourcesBackend, "library")),
      Layer.provide(Layer.succeedContext(authServices)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.build);
  const http = yield* HttpClient.HttpClient;
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${session.token}`,
    "mcp-protocol-version": "2025-06-18",
  };
  const post = Effect.fn("outsideTest.post")(function* (
    sessionId: string | undefined,
    method: string,
    params: unknown,
  ) {
    const response = yield* http.post("/mcp", {
      headers: sessionId === undefined ? headers : { ...headers, "mcp-session-id": sessionId },
      body: HttpBody.text(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        "application/json",
      ),
    });
    expect(response.status).toBe(200);
    const text = yield* response.text;
    const line = text
      .split("\n")
      .find((entry) => entry.startsWith("data: ") || entry.startsWith("{"));
    return { response, message: JSON.parse(line!.replace(/^data: /u, "")) as McpReply };
  });
  const initialized = yield* post(undefined, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "outside", version: "1" },
  });
  const sessionId = initialized.response.headers["mcp-session-id"]!;
  const tools = (yield* post(sessionId, "tools/list", {})).message.result.tools ?? [];
  const call = Effect.fn("outsideTest.call")(function* (name: string, args: unknown) {
    const { result } = (yield* post(sessionId, "tools/call", { name, arguments: args })).message;
    const text = result.content?.[0]?.text ?? "";
    return result.isError === true
      ? { error: text }
      : {
          ok: JSON.parse(text) as {
            readonly records?: ReadonlyArray<object>;
            readonly outcome?: string;
          },
        };
  });
  return { base, a, b, sourceId, tools, call };
});

it.effect("a read-only outside client reads the Library and leaves every file as it was", () =>
  Effect.gen(function* () {
    const { base, sourceId, tools, call } = yield* outsideClient("read-only");
    const list = tools.find((tool) => tool.name === "scient_sources_list");
    expect(list?.inputSchema.properties.projectId).toBeDefined();
    expect(tools.map((tool) => tool.name)).not.toContain("scient_sources_organize");

    const library = yield* call("scient_sources_list", { scope: "library" });
    expect(library.ok?.records).toEqual([
      expect.objectContaining({ sourceId, title: "Sepsis outcomes in adults" }),
    ]);
    // Nothing of a checkout: no project named, so no pin state.
    expect(library.ok?.records?.[0]).not.toHaveProperty("pinned");
    expect((yield* call("scient_sources_list", {})).error).toContain("pass its projectId");

    const before = yield* Effect.promise(() => tree(base));
    const pin = yield* call("scient_sources_organize", {
      projectId: projectA,
      change: { action: "pin", sourceId },
    });
    expect(pin.error).toContain("approved for read-only access");
    expect(yield* Effect.promise(() => tree(base))).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an outside client's pin lands in the project it names", () =>
  Effect.gen(function* () {
    const { a, b, sourceId, tools, call } = yield* outsideClient("full-access");
    expect(tools.map((tool) => tool.name)).toContain("scient_sources_organize");
    expect(
      (yield* call("scient_sources_organize", {
        projectId: "project-nobody-registered",
        change: { action: "pin", sourceId },
      })).error,
    ).toContain("scient_project_list");

    const pinned = yield* call("scient_sources_organize", {
      projectId: projectB,
      change: { action: "pin", sourceId },
    });
    expect(pinned.ok?.outcome).toBe("pinned");
    expect(yield* Effect.promise(() => readScientProjectPins(b))).toEqual([
      expect.objectContaining({ sourceId }),
    ]);
    expect(yield* Effect.promise(() => readScientProjectPins(a))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
