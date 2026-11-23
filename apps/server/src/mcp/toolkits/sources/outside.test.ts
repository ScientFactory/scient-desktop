// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  pinScientLibrarySource,
  readScientProjectPins,
} from "@scientfactory/scient-sources/project-pins";
import { importScientSource } from "@scientfactory/scient-sources/store";
import {
  EnvironmentId,
  ProjectId,
  type AuthMcpClientAccess,
  type Project,
} from "@t3tools/contracts";
import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../../auth/McpOAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { textPdf } from "../../../scient/annotations/annotationTestUtils.ts";
import { WorkspaceAuthorityScopeRevision } from "../../../scient/projectScope/WorkspaceBinding.ts";
import * as WorkspaceAuthorityProjection from "../../../scient/projectScope/WorkspaceAuthorityProjection.ts";
import * as WorkspaceBindingEvidence from "../../../scient/projectScope/WorkspaceBindingEvidence.ts";
import {
  WorkspaceBindingResolver,
  layer as workspaceBindingResolverLayer,
} from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as WorkspaceBindingStore from "../../../scient/projectScope/WorkspaceBindingStore.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { resetCitationStyleCatalogue } from "../../../scient/sources/CitationStyles.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";

// The style catalogue as recorded from zotero.org, so a cold search downloads without a network.
vi.mock("../../../scient/sources/metadataHttp.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../scient/sources/metadataHttp.ts")>();
  const index = await NodeFSP.readFile(
    NodePath.join(
      import.meta.dirname,
      "../../../scient/sources/fixtures/citation-styles/styles-index.json",
    ),
    "utf8",
  );
  return {
    ...actual,
    requestMetadata: async (url: URL) =>
      url.href === "https://www.zotero.org/styles-files/styles.json"
        ? { status: 200, body: index, url }
        : { status: 404, body: "", url },
  };
});

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
/** Registered, but its folder is verified for another environment. */
const projectElsewhere = "host-binding-c";
/** Registered with B's folder, whose binding names project B. */
const projectMisnamed = "host-binding-d";

async function folders() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-outside-")),
  );
  fixtures.push(base);
  const roots = {
    a: NodePath.join(base, "a"),
    b: NodePath.join(base, "b"),
    c: NodePath.join(base, "c"),
  };
  for (const root of Object.values(roots)) {
    await NodeFSP.mkdir(root);
    await initializeScientProject({ root });
  }
  return { base, ...roots };
}

/** Every file under `root` with its bytes' digest and change time: a write leaves a trace here. */
async function tree(root: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = NodePath.join(entry.parentPath, entry.name);
        const [stat, bytes] = await Promise.all([NodeFSP.stat(path), NodeFSP.readFile(path)]);
        const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        return `${NodePath.relative(root, path)} ${digest} ${stat.mtimeMs}`;
      }),
  ).then((lines) => lines.toSorted());
}

const paper = (sourceKey: string, title: string, pdf: boolean): ScientSourceCandidate => ({
  sourceKey,
  type: "article",
  customType: null,
  title,
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
  pdfAvailable: pdf,
  pdfFileName: pdf ? `${sourceKey}.pdf` : null,
  pdfAttachmentCount: 0,
});

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
const outsideClient = Effect.fn("outsideTest.client")(function* (
  access: AuthMcpClientAccess,
  peerLink = false,
) {
  const { base, a, b, c } = yield* Effect.promise(folders);
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
      candidate: paper("outside", "Sepsis outcomes in adults", false),
    });
    return imported.record!.sourceId;
  });
  const projects = new Map([
    [projectA, project(projectA, a)],
    [projectB, project(projectB, b)],
    [projectElsewhere, project(projectElsewhere, c)],
    [projectMisnamed, project(projectMisnamed, b)],
  ]);
  const bindings = workspaceResolverForTest(
    new Map([
      [a, { projectId: "scient-a", scope: workspaceScopeForTest("binding-a", a) }],
      [b, { projectId: "scient-b", scope: workspaceScopeForTest("binding-b", b) }],
      [c, { projectId: "scient-c", scope: workspaceScopeForTest("binding-c", c) }],
    ]),
  );
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
    peerLink,
    client: { deviceType: "bot" },
  });
  yield* HttpRouter.serve(
    McpHttpServer.layerMcpTransport(McpHttpServer.ScientSourcesToolkitRegistrationLive).pipe(
      Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      // On, so a peer link is refused by the Sources rule, not by the transport.
      Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
      Layer.provide(
        Layer.mock(ProjectService)({
          getById: (projectId) => Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkspaceBindingResolver, {
          ...bindings,
          resolveWorkspaceRoot: (root) =>
            bindings.resolveWorkspaceRoot(root).pipe(
              Effect.map((resolved) =>
                root === c
                  ? {
                      ...resolved,
                      binding: {
                        ...resolved.binding,
                        environmentId: EnvironmentId.make("other-environment"),
                      },
                    }
                  : resolved,
              ),
            ),
        }),
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
            readonly pages?: ReadonlyArray<{ readonly text: string }>;
            readonly citationStyles?: ReadonlyArray<{ readonly id: string }>;
          },
        };
  });
  // The server's state folder holds the Library and the style catalogue's cache.
  const files = () => Promise.all([tree(base), tree(config.stateDir)]);
  return { base, a, b, library: scientLibraryLocation(libraryRoot), files, sourceId, tools, call };
});

it.effect("a read-only outside client reads the Library and leaves every file as it was", () =>
  Effect.gen(function* () {
    const { files, sourceId, tools, call } = yield* outsideClient("read-only");
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

    const before = yield* Effect.promise(files);
    const pin = yield* call("scient_sources_organize", {
      projectId: projectA,
      change: { action: "pin", sourceId },
    });
    expect(pin.error).toContain("approved for read-only access");
    expect(yield* Effect.promise(files)).toEqual(before);
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
    // A registered project is acted on only through its own folder, verified on this server.
    for (const projectId of [projectMisnamed, projectElsewhere]) {
      expect(
        (yield* call("scient_sources_organize", { projectId, change: { action: "pin", sourceId } }))
          .error,
      ).toContain("could not verify this project's folder");
    }
    expect(yield* Effect.promise(() => readScientProjectPins(b))).toEqual([]);

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

it.effect(
  "a read-only outside client reads PDF text in a moved project and one not yet moved, writing nothing",
  () =>
    Effect.gen(function* () {
      const { base, a, b, library, files, call } = yield* outsideClient("read-only");
      // A keeps its own store (not yet moved); B has none, so it reads the Library.
      const ids = yield* Effect.promise(async () => {
        const pdfPath = NodePath.join(base, "trial.pdf");
        await NodeFSP.writeFile(pdfPath, textPdf([["Vasopressin in septic shock"]]));
        const add = (root: typeof a | typeof library, sourceKey: string) =>
          importScientSource({
            root,
            operationId: NodeCrypto.randomUUID(),
            candidate: paper(sourceKey, "Vasopressin trial", true),
            pdfPath,
          }).then((imported) => imported.record!.sourceId);
        const own = await add(a, "own");
        const shared = await add(library, "shared");
        await pinScientLibrarySource({ projectRoot: b, library, sourceId: shared, actor: "user" });
        return { [projectA]: own, [projectB]: shared };
      });
      resetCitationStyleCatalogue();
      const before = yield* Effect.promise(files);

      for (const [projectId, sourceId] of Object.entries(ids)) {
        const found = yield* call("scient_sources_search", { projectId, query: "Vasopressin" });
        expect(found.error).toBeUndefined();
        const read = yield* call("scient_sources_read_text", { projectId, sourceId });
        expect(read.ok?.pages?.[0]?.text).toContain("Vasopressin in septic shock");
        const quote = yield* call("scient_sources_quote_check", {
          projectId,
          quotes: [{ quote: "Vasopressin in septic shock", sourceId }],
        });
        expect(quote.error).toBeUndefined();
      }
      const styles = yield* call("scient_sources_list", {
        projectId: projectA,
        citationStyles: "Scientific Reports",
      });
      expect(styles.ok?.citationStyles?.[0]?.id).toBe("scientific-reports");

      expect(yield* Effect.promise(files)).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a peer link is offered no Sources tool and cannot call one", () =>
  Effect.gen(function* () {
    const { tools, call } = yield* outsideClient("full-access", true);
    expect(
      tools.map((tool) => tool.name).filter((name) => name.startsWith("scient_sources")),
    ).toEqual([]);
    expect(
      (yield* call("scient_sources_list", { projectId: projectA, scope: "library" })).error,
    ).toContain("acts as the calling Scient");
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a read-only outside project call verifies through the real resolver without writing binding rows",
  () =>
    Effect.gen(function* () {
      const { base, a, b, c } = yield* Effect.promise(folders);
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(
          ServerConfig.ServerConfig.layerTest(base, { prefix: "sources-outside-real-" }).pipe(
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
          candidate: paper("real-resolver", "Sepsis outcomes in adults", false),
        });
        await pinScientLibrarySource({
          projectRoot: a,
          library: scientLibraryLocation(libraryRoot),
          sourceId: imported.record!.sourceId,
          actor: "user",
        });
        return imported.record!.sourceId;
      });
      const idA = ProjectId.make("project-real-a");
      const idB = ProjectId.make("project-real-b");
      const idC = ProjectId.make("project-real-c");
      const registered = new Map<ProjectId, Project>([
        [idA, project(idA, a)],
        [idB, project(idB, b)],
        [idC, project(idC, c)],
      ]);
      const projectionLayer = Layer.succeed(
        WorkspaceAuthorityProjection.WorkspaceAuthorityProjection,
        WorkspaceAuthorityProjection.WorkspaceAuthorityProjection.of({
          listRegisteredRoots: () =>
            Effect.succeed(
              [...registered.values()].map((entry) => ({
                projectId: entry.id,
                threadId: null,
                workspaceRoot: entry.workspaceRoot,
              })),
            ),
          getProjectContext: (projectId) =>
            Effect.succeed(
              Option.fromNullishOr(registered.get(projectId)).pipe(
                Option.map((entry) => ({
                  projectId: entry.id,
                  workspaceRoot: entry.workspaceRoot,
                  scopeRevision: WorkspaceAuthorityScopeRevision.make(1),
                })),
              ),
            ),
          getThreadContext: () => Effect.succeedNone,
        }),
      );
      const baseLayer = Layer.mergeAll(
        EnvironmentAuth.layer,
        McpSessionRegistry.layer,
        WorkspaceBindingStore.layer,
      ).pipe(
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
      const vcsLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer));
      const evidenceLayer = WorkspaceBindingEvidence.layer.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(vcsLayer),
      );
      const resolverLayer = workspaceBindingResolverLayer.pipe(
        Layer.provide(evidenceLayer),
        Layer.provide(projectionLayer),
        Layer.provideMerge(baseLayer),
      );
      const services = yield* Layer.build(resolverLayer);
      const resolver = Context.get(services, WorkspaceBindingResolver);
      const bindingStore = Context.get(services, WorkspaceBindingStore.WorkspaceBindingStore);
      const sql = Context.get(services, SqlClient.SqlClient);

      // Project A has an existing verified binding; B has none; C is revoked.
      yield* resolver.resolveWorkspaceRoot(a);
      const bindingC = yield* resolver.resolveWorkspaceRoot(c);
      yield* bindingStore.revoke(bindingC.binding.bindingId);

      const session = yield* Context.get(
        services,
        EnvironmentAuth.EnvironmentAuth,
      ).issueMcpClientSession({
        label: "Outside read-only real",
        access: "read-only",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(McpHttpServer.ScientSourcesToolkitRegistrationLive).pipe(
          Layer.provide(McpOAuth.layerMcpClientAuthenticator),
          Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
          Layer.provide(
            Layer.mock(ProjectService)({
              getById: (projectId) =>
                Effect.succeed(Option.fromNullishOr(registered.get(projectId))),
            }),
          ),
          Layer.provide(Layer.succeed(ScientSourcesBackend, "library")),
          Layer.provide(Layer.succeedContext(services)),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);

      const http = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${session.token}`,
        "mcp-protocol-version": "2025-06-18",
      };
      const post = (sessionId: string | undefined, method: string, params: unknown) =>
        http
          .post("/mcp", {
            headers:
              sessionId === undefined ? headers : { ...headers, "mcp-session-id": sessionId },
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              "application/json",
            ),
          })
          .pipe(
            Effect.flatMap((response) =>
              response.text.pipe(
                Effect.map((text) => ({
                  response,
                  message: JSON.parse(
                    text
                      .split("\n")
                      .find((line) => line.startsWith("data: ") || line.startsWith("{"))!
                      .replace(/^data: /u, ""),
                  ) as McpReply,
                })),
              ),
            ),
          );
      const init = yield* post(undefined, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "outside", version: "1" },
      });
      const sessionId = init.response.headers["mcp-session-id"]!;

      const bindingRows = () =>
        sql.unsafe<Record<string, unknown>>(
          "SELECT * FROM scient_workspace_bindings ORDER BY binding_id",
        );
      const rowsBefore = yield* bindingRows();
      const filesBefore = yield* Effect.promise(() =>
        Promise.all([tree(base), tree(config.stateDir)]),
      );

      const listA = yield* post(sessionId, "tools/call", {
        name: "scient_sources_list",
        arguments: { projectId: idA },
      });
      expect(listA.message.result.isError).not.toBe(true);
      expect(JSON.parse(listA.message.result.content![0]!.text).records).toEqual([
        expect.objectContaining({ sourceId }),
      ]);
      const listB = yield* post(sessionId, "tools/call", {
        name: "scient_sources_list",
        arguments: { projectId: idB },
      });
      expect(listB.message.result.isError).not.toBe(true);
      const listC = yield* post(sessionId, "tools/call", {
        name: "scient_sources_list",
        arguments: { projectId: idC },
      });
      expect(listC.message.result.isError).toBe(true);
      expect(listC.message.result.content![0]!.text).toContain(
        "could not verify this project's folder",
      );

      expect(yield* bindingRows()).toEqual(rowsBefore);
      expect(yield* Effect.promise(() => Promise.all([tree(base), tree(config.stateDir)]))).toEqual(
        filesBefore,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
