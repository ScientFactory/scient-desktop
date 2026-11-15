// @effect-diagnostics nodeBuiltinImport:off
/**
 * Scient's Sources tools over a real Library in a temporary folder, made from a case's
 * `world.library`. The stores, the toolkit registration and the handlers are the product's; only
 * Zotero and the identifier registries are stand-ins. `outcome` says what the run changed.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the eval calls the tools McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import { ServerConfig } from "../../apps/server/src/config.ts";
import * as McpHttpServer from "../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { ScientSourcesLibraryToolkit } from "../../apps/server/src/mcp/toolkits/sources/tools.ts";
import { cancelSourceImport } from "../../apps/server/src/scient/sources/ScientSourcesCoordinator.ts";
import { WorkspaceBindingResolver } from "../../apps/server/src/scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../apps/server/src/scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  SourceIdentifierLookup,
  verifiableSourceIdentifier,
} from "../../apps/server/src/scient/sources/SourceIdentifierResolver.ts";
import {
  fakeZoteroTransport,
  zoteroItem,
} from "../../apps/server/src/scient/sources/Zotero.testkit.ts";
import { ZoteroTransports } from "../../apps/server/src/scient/sources/ZoteroConnections.ts";
import { initializeScientProject } from "../../packages/scient-project-init/src/index.ts";
import { bulkUpdateScientSources } from "../../packages/scient-sources/src/collections.ts";
import { editableMetadataFromRecord } from "../../packages/scient-sources/src/editable.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
} from "../../packages/scient-sources/src/libraryRoot.ts";
import {
  ScientSourceCandidate,
  type ScientSourceRecord,
} from "../../packages/scient-sources/src/model.ts";
import { pinScientLibrarySource } from "../../packages/scient-sources/src/projectPins.ts";
import {
  importScientSource,
  inspectScientLibrarySources,
  listScientSourceRecords,
  readScientSourceTrashEntries,
  removeScientSource,
} from "../../packages/scient-sources/src/store.ts";

const LibrarySource = Schema.Struct({
  title: Schema.String,
  /** Family names. */
  authors: Schema.optional(Schema.Array(Schema.String)),
  year: Schema.optional(Schema.Int),
  /** Defaults to `article`. */
  type: Schema.optional(ScientSourceCandidate.fields.type),
  journal: Schema.optional(Schema.String),
  publisher: Schema.optional(Schema.String),
  doi: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  /** Further details by CSL variable, such as `edition` and `publisher-place`. */
  more: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The person moved it to the Trash before the thread. */
  trashed: Schema.optional(Schema.Boolean),
});
type LibrarySource = typeof LibrarySource.Type;

/** The person's Library when the thread starts. Every source is in the thread's project. */
export const LibraryWorld = Schema.Struct({
  /** Sources by the name `expect.library` uses for them. */
  sources: Schema.Record(Schema.String, LibrarySource),
  /** Tags the person added to several sources at once, oldest first, each by source name. */
  bulkEdits: Schema.optional(
    Schema.Array(
      Schema.Struct({ addTags: Schema.Array(Schema.String), sources: Schema.Array(Schema.String) }),
    ),
  ),
  /**
   * The person's Zotero, open on this computer: that many references in My Library, and notes
   * that belong to no reference. Without it Zotero is closed.
   */
  zotero: Schema.optional(
    Schema.Struct({
      references: Schema.Int,
      looseNotes: Schema.optional(Schema.Int),
      /**
       * The person presses Stop in the panel while an import brings this reference, counted
       * from 1. It and those before it arrive.
       */
      stoppedAt: Schema.optional(Schema.Int),
    }),
  ),
});
type LibraryWorld = typeof LibraryWorld.Type;

/**
 * What the Library must look like when the sample ends, against how it started. A source's
 * details are `state` (`live`, `trash`, `merged`, `gone`), its editable metadata (`title`,
 * `tags`, `type`, ...), its further details as `more.<name>`, and its personal `note`.
 */
export const LibraryExpect = Schema.Struct({
  /** Details that must have changed, by source name, with their exact new values. Any other change fails. */
  changed: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  ),
  /** Sources the run must add: how many, or the details each one must have. Default: none. */
  added: Schema.optional(
    Schema.Union([Schema.Int, Schema.Array(Schema.Record(Schema.String, Schema.Unknown))]),
  ),
});

type SourceState = Readonly<Record<string, unknown>>;

/** What a sample changed in its Library. */
export interface LibraryOutcome {
  /** Each detail of the case's own sources that differs from the start. */
  readonly changes: ReadonlyArray<{
    readonly source: string;
    readonly detail: string;
    readonly before: unknown;
    readonly after: unknown;
  }>;
  /** Sources the run added, as they are at the end. */
  readonly added: ReadonlyArray<SourceState>;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export const gradeLibrary = (
  expect: typeof LibraryExpect.Type | undefined,
  outcome: LibraryOutcome | undefined,
) => {
  if (expect === undefined) return [];
  if (outcome === undefined) return [{ check: "library was read", pass: false }];
  const wanted = Object.entries(expect.changed ?? {}).flatMap(([source, details]) =>
    Object.entries(details).map(([detail, value]) => ({ source, detail, value })),
  );
  const made = (source: string, detail: string) =>
    outcome.changes.find((change) => change.source === source && change.detail === detail);
  const others = outcome.changes.filter(
    (change) =>
      !wanted.some((want) => want.source === change.source && want.detail === change.detail),
  );
  const added = expect.added ?? 0;
  return [
    ...wanted.map(({ source, detail, value }) => {
      const change = made(source, detail);
      return {
        check: `library ${source}.${detail} becomes ${JSON.stringify(value)}`,
        pass: change !== undefined && same(change.after, value),
      };
    }),
    {
      check: `library nothing else changed${others.map((change) => `; ${change.source}.${change.detail} became ${JSON.stringify(change.after)}`).join("")}`,
      pass: others.length === 0,
    },
    {
      check: `library added ${JSON.stringify(added)}`,
      pass:
        typeof added === "number"
          ? outcome.added.length === added
          : outcome.added.length === added.length &&
            added.every((want) =>
              outcome.added.some((source) =>
                Object.entries(want).every(([detail, value]) => same(source[detail], value)),
              ),
            ),
    },
  ];
};

/** The Library's tool list, as a thread in Library mode gets it. */
export const SOURCES_TOOLS: ReadonlyArray<Tool.Any> = Object.values(
  ScientSourcesLibraryToolkit.tools,
);
export const isSourcesTool = (name: string) => name.startsWith("scient_sources_");

const candidate = (name: string, source: LibrarySource): ScientSourceCandidate => ({
  sourceKey: name,
  type: source.type ?? "article",
  customType: null,
  title: source.title,
  creators: (source.authors ?? []).map((familyName) => ({
    creatorType: "author",
    givenName: null,
    familyName,
    literalName: null,
  })),
  issuedRaw: source.year === undefined ? null : String(source.year),
  issuedYear: source.year ?? null,
  identifiers: source.doi === undefined ? [] : [{ scheme: "doi", value: source.doi }],
  abstract: null,
  containerTitle: source.journal ?? null,
  publisher: source.publisher ?? null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  ...(source.more === undefined ? {} : { more: source.more }),
  tags: [...(source.tags ?? [])],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
});

/** Fills the Library as the person left it, and returns each source's name by its ID. */
async function seed(world: LibraryWorld, project: string, library: ScientLibraryLocation) {
  await initializeScientProject({ root: project });
  await ensureScientLibrary(library.root);
  const names = new Map<string, string>();
  const idOf = (name: string) => {
    const found = [...names].find(([, known]) => known === name)?.[0];
    if (found === undefined) throw new Error(`The case's library has no source named ${name}.`);
    return found;
  };
  for (const [name, source] of Object.entries(world.sources)) {
    const { record } = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate(name, source),
      allowPossibleMetadataMatch: true,
    });
    if (!record) throw new Error(`The case's source ${name} is a duplicate of another one.`);
    names.set(record.sourceId, name);
    await pinScientLibrarySource({
      projectRoot: project,
      library,
      sourceId: record.sourceId,
      actor: "user",
    });
  }
  for (const edit of world.bulkEdits ?? []) {
    await bulkUpdateScientSources({
      root: library,
      change: { sourceIds: edit.sources.map(idOf), addTags: [...edit.addTags] },
      actor: "user",
    });
  }
  for (const record of await listScientSourceRecords(library)) {
    if (world.sources[names.get(record.sourceId) ?? ""]?.trashed !== true) continue;
    await removeScientSource({
      root: library,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      actor: "user",
    });
  }
  return names;
}

const stateOf = (record: ScientSourceRecord, state: string): SourceState => {
  const { more, tags, ...details } = editableMetadataFromRecord(record);
  return {
    state,
    ...details,
    tags: tags.toSorted(),
    note: record.note ?? null,
    ...Object.fromEntries(
      Object.entries(more ?? {}).map(([name, value]) => [`more.${name}`, value]),
    ),
  };
};

async function readLibrary(library: ScientLibraryLocation) {
  const [records, trash] = await Promise.all([
    listScientSourceRecords(library),
    readScientSourceTrashEntries(library),
  ]);
  return new Map([
    ...records.map((record) => [record.sourceId, stateOf(record, "live")] as const),
    ...trash.map(
      (entry) =>
        [entry.sourceId, stateOf(entry.record, entry.mergedInto ? "merged" : "trash")] as const,
    ),
  ]);
}

// Zotero's key alphabet has no 0, 1 or O.
const ZOTERO_KEY_DIGITS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const zoteroKey = (index: number) =>
  Array.from(
    { length: 8 },
    (_, place) =>
      ZOTERO_KEY_DIGITS[
        Math.floor(index / ZOTERO_KEY_DIGITS.length ** place) % ZOTERO_KEY_DIGITS.length
      ],
  )
    .toReversed()
    .join("");

/** The panel's Stop on the import that is running. Resolves to what went wrong, if anything. */
const stopRunningImport = (library: ScientLibraryLocation) =>
  inspectScientLibrarySources(library)
    .then(({ activeOperation }) => {
      if (!activeOperation) throw new Error("The case stops an import, and none is running.");
      return cancelSourceImport({ root: library, operationId: activeOperation.operationId });
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

/** The person's Zotero as the case describes it, or a Zotero that is not open. */
function zoteroOf(
  zotero: LibraryWorld["zotero"],
  library: ScientLibraryLocation,
): {
  readonly transports: typeof ZoteroTransports.Service;
  /** What went wrong with the person's Stop; null when it worked or was never pressed. */
  readonly stopFailure: () => Promise<unknown>;
} {
  if (zotero === undefined) {
    return {
      transports: {
        inspectLocal: async () => ({
          state: "unreachable",
          apiVersion: null,
          message: "Open Zotero on the computer running this project, then check again.",
        }),
      },
      stopFailure: async () => null,
    };
  }
  const references = Array.from({ length: zotero.references }, (_, index) =>
    zoteroItem(zoteroKey(index), {
      title: `Reference number ${index + 1}`,
      abstractNote: "A.",
      creators: [{ creatorType: "author", lastName: `Author${index + 1}` }],
      date: String(1500 + index),
    }),
  );
  const notes = Array.from({ length: zotero.looseNotes ?? 0 }, (_, index) =>
    zoteroItem(zoteroKey(zotero.references + index), {
      itemType: "note",
      note: `<p>Reading note ${index + 1}</p>`,
    }),
  );
  const local = fakeZoteroTransport({
    items: new Map([...references, ...notes].map((item) => [item.key, { item, children: [] }])),
  });
  const stopAt =
    zotero.stoppedAt === undefined ? undefined : `/items/${zoteroKey(zotero.stoppedAt - 1)}`;
  let stop: Promise<unknown> | undefined;
  const get: typeof local.get = async (path, ...rest) => {
    // Not awaited: Stop waits its turn behind the reference being brought, as in the product.
    if (stopAt !== undefined && stop === undefined && path.startsWith(stopAt)) {
      stop = stopRunningImport(library);
    }
    const response = await local.get(path, ...rest);
    // Zotero pages a listing by `start` and `limit`; the test Zotero answers it whole.
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const limit = Number(query.get("limit"));
    if (!path.startsWith("/items/top") || query.get("format") !== "json" || !(limit > 0)) {
      return response;
    }
    const start = Number(query.get("start") ?? 0);
    const items: ReadonlyArray<unknown> = JSON.parse(response.body);
    return { ...response, body: JSON.stringify(items.slice(start, start + limit)) };
  };
  return {
    transports: {
      local: { ...local, get },
      inspectLocal: async () => ({ state: "ready", apiVersion: 3, message: "Ready." }),
    },
    stopFailure: async () => stop ?? null,
  };
}

const environmentId = EnvironmentId.make("00000000-0000-4000-8000-0000000000e1");
const threadId = ThreadId.make("mcp-tool-use-eval");
const projectId = ProjectId.make("mcp-tool-use-eval-project");

/**
 * Builds the case's Library and project in a temporary folder that the scope removes, and the
 * product's Sources tools on them. `call` runs one tool as the thread's agent, with write access.
 */
export const makeSourcesLibrary = Effect.fn("evaluateMcpToolUse.makeSourcesLibrary")(function* (
  world: LibraryWorld,
) {
  const base = yield* Effect.acquireRelease(
    Effect.promise(async () =>
      NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-eval-library-")),
      ),
    ),
    (folder) => Effect.promise(() => NodeFSP.rm(folder, { recursive: true, force: true })),
  );
  const project = NodePath.join(base, "project");
  yield* Effect.promise(() => NodeFSP.mkdir(project));
  // Only the temporary folder: an installed Scient's state is never named.
  const config = yield* Layer.build(ServerConfig.layerTest(base, { prefix: "state-" }));
  const library = scientLibraryLocation(
    scientLibraryRootFor(Context.get(config, ServerConfig).stateDir),
  );
  const names = yield* Effect.promise(() => seed(world, project, library));
  const zotero = zoteroOf(world.zotero, library);
  const before = yield* Effect.promise(() => readLibrary(library));

  const resolver = workspaceResolverForTest(
    new Map([
      [project, { projectId, scope: workspaceScopeForTest(`binding:${project}`, project) }],
    ]),
  );
  const resolveThread = () =>
    resolver.resolveWorkspaceRoot(project).pipe(
      Effect.map((resolved) => ({
        ...resolved,
        binding: { ...resolved.binding, environmentId, hostProjectId: projectId },
      })),
    );
  const context = yield* Layer.build(
    McpHttpServer.ScientSourcesToolkitRegistrationLive.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(
        Layer.succeed(WorkspaceBindingResolver, {
          ...resolver,
          resolveThread,
          assertCurrentThreadScope: Effect.fn("WorkspaceBindingResolver.assertCurrentThreadScope")(
            function* () {
              return (yield* resolveThread()).binding;
            },
          ),
        }),
      ),
      Layer.provide(Layer.succeedContext(config)),
      Layer.provide(Layer.succeed(ZoteroTransports, zotero.transports)),
      // No registry is asked: every identifier is reported unreachable.
      Layer.provide(
        Layer.succeed(SourceIdentifierLookup, async (identifiers) => {
          const identifier = verifiableSourceIdentifier(identifiers);
          return identifier ? { status: "unavailable", identifier } : null;
        }),
      ),
    ),
  );
  type Entry = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
  // The registry keeps each tool's handler; its public type lists only definitions.
  const tools = Context.get(context, McpServer.McpServer).tools as ReadonlyArray<Entry>;
  const scope: McpInvocationContext.McpThreadInvocationScope = {
    environmentId,
    requestNamespace: "mcp-tool-use-eval",
    thread: {
      threadId,
      providerSessionId: "mcp-tool-use-eval",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    },
    client: undefined,
    capabilities: new Set<McpInvocationContext.McpCapability>(["sources:read", "sources:write"]),
    issuedAt: 0,
  };
  const request = McpSchema.McpRequestContext.of({
    clientId: 0,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
  });

  const call = Effect.fn("evaluateMcpToolUse.sourcesCall")(function* (
    name: string,
    input: unknown,
  ) {
    const entry = tools.find((tool) => tool.tool.name === name);
    if (entry === undefined) return yield* Effect.die(new Error(`No ${name} tool.`));
    const result = yield* entry.handle(input).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpRequestContext, request),
      // An MCP client shows a protocol error, such as bad parameters, as the tool's error.
      Effect.catch((error) =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            isError: true,
            content: [{ type: "text", text: error.message }],
          }),
        ),
      ),
    );
    if (!("content" in result)) return yield* Effect.die(new Error(`${name} asked for input.`));
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    if (text === "Tool execution failed due to an internal server error.") {
      return yield* Effect.die(new Error(`${name} hit a defect in Scient or the eval.`));
    }
    return { text, isError: result.isError === true };
  });

  const outcome = Effect.promise(async (): Promise<LibraryOutcome> => {
    const failure = await zotero.stopFailure();
    if (failure !== null) throw failure;
    const after = await readLibrary(library);
    return {
      changes: [...before]
        .flatMap(([sourceId, was]): LibraryOutcome["changes"] => {
          const source = names.get(sourceId) ?? sourceId;
          const now = after.get(sourceId);
          if (now === undefined) {
            return [{ source, detail: "state", before: was.state, after: "gone" }];
          }
          return [...new Set([...Object.keys(was), ...Object.keys(now)])]
            .filter((detail) => !same(was[detail], now[detail]))
            .map((detail) => ({
              source,
              detail,
              before: was[detail] ?? null,
              after: now[detail] ?? null,
            }));
        })
        .toSorted(
          (left, right) =>
            left.source.localeCompare(right.source) || left.detail.localeCompare(right.detail),
        ),
      added: [...after].flatMap(([sourceId, state]) => (before.has(sourceId) ? [] : [state])),
    };
  });

  return { call, outcome };
});
export type SourcesLibrary = Effect.Success<ReturnType<typeof makeSourcesLibrary>>;
