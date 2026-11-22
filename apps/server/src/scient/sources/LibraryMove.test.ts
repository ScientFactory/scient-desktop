// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project, library and git folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  moveScientProjectBackIntoProject,
  readScientLibraryMoveState,
  ScientLibraryMoveCrash,
  scientLibraryMoveStatusLines,
} from "@scientfactory/scient-sources/library-move";
import { readScientLibraryAliases } from "@scientfactory/scient-sources/library-aliases";
import {
  mergeScientLibrarySources,
  undoScientLibraryMerge,
} from "@scientfactory/scient-sources/library-merge";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import {
  organizeScientSources,
  readScientSourcesOrganization,
} from "@scientfactory/scient-sources/collections";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import {
  attachScientSourcePdf,
  importScientSource,
  listScientSourceRecords,
} from "@scientfactory/scient-sources/store";
import type { ScientSourcesMoveStatus } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../../config.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  moveProjectBackIntoProject,
  readLibraryMoveStatus,
  type ScientLibraryMoveBusyError,
  ScientLibraryMoveTestFaults,
  ScientLibraryMoveWait,
} from "./LibraryMove.ts";
import { runLibraryMovePass } from "./LibraryMovePass.ts";
import { organizeLibrarySources } from "./LibrarySourcesRoutes.ts";
import {
  ScientSourcesBackend,
  resolveScientSourcesStoreFor,
  type ScientLibraryRecoveryError,
} from "./SourcesBackend.ts";

const KEPT_COPY_LINE = expect.stringMatching(
  /^A copy of this project's sources from before the move is kept in \.scient\/library\/retained-before-library\/move_[0-9a-f]+\.$/u,
);
/** Every finished move says where the Library is and that the copy from before it is kept. */
const SUMMARY_LINES = [expect.stringMatching(/^Your Library is in .+\.$/u), KEPT_COPY_LINE];

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup(name = "project") {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-move-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  const stateDir = NodePath.join(base, "state");
  return { base, root, stateDir, library: scientLibraryLocation(scientLibraryRootFor(stateDir)) };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const addV1Source = (root: string, sourceKey: string) => addSource(root, sourceKey);

async function addSource(root: ScientSourceStoreLocation, sourceKey: string) {
  const imported = await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: {
      sourceKey,
      type: "article",
      customType: null,
      title: `Study ${sourceKey}`,
      creators: [
        { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
      ],
      issuedRaw: "2026",
      issuedYear: 2026,
      identifiers: [],
      abstract: null,
      containerTitle: "Scient Journal",
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
  return imported.record!;
}

const git = (cwd: string, ...args: string[]) =>
  execFile(
    "git",
    ["-c", "user.name=Scient Test", "-c", "user.email=test@example.invalid", ...args],
    {
      cwd,
    },
  ).then(({ stdout }) => stdout);

const gitLayer = (fixture: Fixture) =>
  GitVcsDriver.layer.pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(fixture.base, { prefix: "library-move-" }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
  );

type TestFaults = typeof ScientLibraryMoveTestFaults.Service;

/** A write call on the library backend, with this fixture's state folder and the git driver. */
const writeStore = (
  fixture: Fixture,
  options: { readonly faults?: TestFaults; readonly wait?: "0 millis" } = {},
) =>
  resolveScientSourcesStoreFor({ projectId: "project", root: fixture.root }, "write").pipe(
    Effect.provideService(ServerConfig.ServerConfig, {
      stateDir: fixture.stateDir,
    } as ServerConfig.ServerConfig["Service"]),
    Effect.provideService(ScientSourcesBackend, "library"),
    Effect.provideService(ScientLibraryMoveTestFaults, options.faults ?? {}),
    options.wait ? Effect.provideService(ScientLibraryMoveWait, options.wait) : (effect) => effect,
    Effect.provide(gitLayer(fixture)),
  );

const statusOf = (fixture: Fixture) =>
  readLibraryMoveStatus({ root: fixture.root, library: fixture.library });

/** A v1 source with a PDF, so the move has a file copy to pause at. */
async function addV1SourceWithPdf(fixture: Fixture, sourceKey: string) {
  const record = await addV1Source(fixture.root, sourceKey);
  const pdf = NodePath.join(fixture.base, `${sourceKey}.pdf`);
  await NodeFSP.writeFile(pdf, `%PDF-1.7\n${sourceKey}\n`);
  await attachScientSourcePdf({
    root: fixture.root,
    sourceId: record.sourceId,
    expectedRevision: record.revision,
    pdfPath: pdf,
  });
  return record;
}

/** Holds the move at its first file copy until `release`. */
function pauseAtFirstFileCopy() {
  let paused!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  return {
    reached,
    release,
    beforeFileCopy: async () => {
      if (!first) return;
      first = false;
      paused();
      await gate;
    },
  };
}

const journalOf = async (fixture: Fixture) =>
  (await readScientLibraryMoveState({ library: fixture.library, projectRoot: fixture.root }))
    .journal;

describe("the lazy move on the library backend", () => {
  it.effect("tracked .scient/sources: deletes stay uncommitted and the notice is produced", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(async () => {
        await addV1Source(fixture.root, "tracked");
        await git(fixture.root, "init", "-q");
        await git(fixture.root, "add", "-A");
        await git(fixture.root, "commit", "-q", "-m", "project");
      });
      const head = yield* Effect.promise(() => git(fixture.root, "rev-parse", "HEAD"));
      const store = yield* writeStore(fixture);
      expect(store.kind).toBe("library");
      const status = yield* Effect.promise(() => git(fixture.root, "status", "--porcelain"));
      expect(status).toMatch(/^ D \.scient\/sources\/records\//mu);
      expect(yield* Effect.promise(() => git(fixture.root, "rev-parse", "HEAD"))).toBe(head);
      expect(scientLibraryMoveStatusLines(yield* Effect.promise(() => journalOf(fixture)))).toEqual(
        [
          KEPT_COPY_LINE,
          "The Library moved out of this project. Commit the change to stop storing PDFs in git.",
        ],
      );
    }),
  );

  it.effect("an untracked project's summary names only the copy it keeps", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(async () => {
        await addV1Source(fixture.root, "untracked");
        await git(fixture.root, "init", "-q");
      });
      yield* writeStore(fixture);
      const journal = yield* Effect.promise(() => journalOf(fixture));
      expect(journal?.state).toBe("done");
      expect(scientLibraryMoveStatusLines(journal)).toEqual([KEPT_COPY_LINE]);
    }),
  );

  it.effect("names a moved collection that clashes after the project's title, not its folder", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      const fjord = { ...fixture, root: NodePath.join(fixture.base, "fjord-field-notes") };
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(fjord.root);
        await initializeScientProject({ root: fjord.root });
        for (const [root, key] of [
          [fixture.root, "a"],
          [fjord.root, "b"],
        ] as const) {
          const source = await addV1Source(root, key);
          await organizeScientSources({
            root,
            change: { action: "create-collection", name: "Methods", sourceIds: [source.sourceId] },
            actor: "user",
          });
        }
      });
      yield* writeStore(fixture);
      yield* writeStore(fjord).pipe(
        Effect.provideService(ProjectStoreV2, {
          list: () => Effect.succeed([{ workspaceRoot: fjord.root, title: "Fjord field notes" }]),
        } as unknown as ProjectStoreV2["Service"]),
      );
      const organization = yield* Effect.promise(() =>
        readScientSourcesOrganization(fixture.library),
      );
      expect(organization.collections.map((collection) => collection.name).toSorted()).toEqual([
        "Methods",
        "Methods (Fjord field notes)",
      ]);
    }),
  );

  it.effect("move-back through organize puts the project on its v1 store for good", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      const source = yield* Effect.promise(() => addV1Source(fixture.root, "back"));
      const store = yield* writeStore(fixture);
      if (store.kind !== "library") throw new Error("Expected the library backend.");
      const result = yield* Effect.promise(() =>
        organizeLibrarySources(store, { change: { action: "move-back" } }),
      );
      expect(result).toMatchObject({ outcome: "moved-back", restoredSources: 1 });
      expect(yield* Effect.promise(() => readScientProjectPins(fixture.root))).toEqual([]);
      expect(
        (yield* Effect.promise(() => listScientSourceRecords(fixture.root))).map(
          (record) => record.sourceId,
        ),
      ).toEqual([source.sourceId]);
      // A later write call keeps it there instead of moving it again.
      expect((yield* writeStore(fixture)).kind).toBe("project");
    }),
  );

  it.effect("retry-move runs a failed move again and answers from the Library", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(() => addV1Source(fixture.root, "again"));
      const failed = yield* writeStore(fixture, { faults: { crashAt: "after-library-copy" } });
      expect(failed.kind).toBe("project");
      expect(yield* statusOf(fixture)).toMatchObject({ state: "failed" });
      // Try again is a write call like any other: resolving its store runs the move first.
      const store = yield* writeStore(fixture);
      if (store.kind !== "library") throw new Error("Expected the library backend.");
      expect(
        yield* Effect.promise(() =>
          organizeLibrarySources(store, { change: { action: "retry-move" } }),
        ),
      ).toEqual({ outcome: "moved" });
      expect(yield* statusOf(fixture)).toMatchObject({ state: "done" });
    }),
  );
});

describe("the background pass", () => {
  it.effect("moves listed projects on the library backend and waits for absent ones", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(() => addV1Source(fixture.root, "pass"));
      const absent = NodePath.join(fixture.base, "unplugged-drive", "project");
      const pass = (backend: "project" | "library") =>
        runLibraryMovePass([fixture.root, absent]).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            stateDir: fixture.stateDir,
          } as ServerConfig.ServerConfig["Service"]),
          Effect.provideService(ScientSourcesBackend, backend),
        );

      expect((yield* pass("project")).size).toBe(0);
      expect(yield* Effect.promise(() => journalOf(fixture))).toBeNull();

      const outcomes = yield* pass("library");
      expect(Object.fromEntries(outcomes)).toEqual({ [fixture.root]: "moved", [absent]: "absent" });
      expect((yield* Effect.promise(() => readScientProjectPins(fixture.root))).length).toBe(1);
    }),
  );
});

describe("one move per project in this server", () => {
  it.effect("two write calls on an unmoved project run one move and both end on the library", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(() => addV1SourceWithPdf(fixture, "twice"));
      const pause = pauseAtFirstFileCopy();
      let runs = 0;
      let arrived!: () => void;
      const secondArrived = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const faults: TestFaults = {
        beforeFileCopy: pause.beforeFileCopy,
        onRun: () => {
          runs += 1;
          if (runs === 2) arrived();
        },
        onJoin: arrived,
      };
      const first = yield* writeStore(fixture, { faults }).pipe(Effect.forkChild);
      yield* Effect.promise(() => pause.reached);
      const second = yield* writeStore(fixture, { faults }).pipe(Effect.forkChild);
      yield* Effect.promise(() => secondArrived);
      pause.release();
      expect((yield* Fiber.join(first)).kind).toBe("library");
      expect((yield* Fiber.join(second)).kind).toBe("library");
      expect(runs).toBe(1);
      expect((yield* Effect.promise(() => journalOf(fixture)))?.run).toBe(1);
    }),
  );

  it.effect("a write past the bound gets the progress and may retry; the move goes on", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(() => addV1SourceWithPdf(fixture, "bound"));
      const pause = pauseAtFirstFileCopy();
      const first = yield* writeStore(fixture, {
        faults: { beforeFileCopy: pause.beforeFileCopy },
      }).pipe(Effect.forkChild);
      yield* Effect.promise(() => pause.reached);
      const busy = yield* writeStore(fixture, { wait: "0 millis" }).pipe(Effect.flip);
      expect(busy).toMatchObject({
        _tag: "ScientLibraryMoveBusyError",
        message:
          "This project's sources are still moving into your Library (copying PDFs, 0 of 1). Try again shortly.",
      });
      pause.release();
      expect((yield* Fiber.join(first)).kind).toBe("library");
      expect((yield* writeStore(fixture)).kind).toBe("library");
      expect((yield* Effect.promise(() => readScientProjectPins(fixture.root))).length).toBe(1);
    }),
  );
});

type ArrangeError =
  | PlatformError.PlatformError
  | ScientLibraryMoveBusyError
  | ScientLibraryRecoveryError;

interface StatusRow {
  readonly name: string;
  /** Brings the fixture into the state; what it returns runs after the status is read. */
  readonly arrange: (
    fixture: Fixture,
  ) => Effect.Effect<Effect.Effect<unknown, ArrangeError> | void, ArrangeError>;
  readonly expected: ScientSourcesMoveStatus;
}

const STATUS_ROWS: ReadonlyArray<StatusRow> = [
  { name: "nothing to move", arrange: () => Effect.void, expected: { state: "nothing-to-move" } },
  {
    name: "waiting",
    arrange: (fixture) =>
      Effect.promise(() => addV1Source(fixture.root, "waiting")).pipe(Effect.asVoid),
    expected: { state: "waiting" },
  },
  {
    name: "moving, with progress",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => addV1SourceWithPdf(fixture, "moving"));
        const pause = pauseAtFirstFileCopy();
        const moving = yield* writeStore(fixture, {
          faults: { beforeFileCopy: pause.beforeFileCopy },
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() => pause.reached);
        return Effect.sync(pause.release).pipe(Effect.andThen(Fiber.join(moving)), Effect.asVoid);
      }),
    expected: { state: "moving", progress: { phase: "files", done: 0, total: 1 } },
  },
  {
    name: "done, with the summary",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await addV1Source(fixture.root, "done");
          const bulk = NodePath.join(fixture.root, ".scient/sources/bulk-edits");
          await NodeFSP.mkdir(bulk, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(bulk, "batch_1.json"), "{}\n");
        });
        yield* writeStore(fixture);
      }),
    expected: {
      state: "done",
      lines: [...SUMMARY_LINES, "Undo for bulk edits made before the move was not kept."],
    },
  },
  {
    name: "cleanup pending",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => addV1SourceWithPdf(fixture, "open"));
        yield* writeStore(fixture, { faults: { undeletable: (path) => path.endsWith(".pdf") } });
      }),
    expected: { state: "cleanup-pending", filesLeft: 1, lines: SUMMARY_LINES },
  },
  {
    name: "restoring (a move back that stopped)",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => addV1Source(fixture.root, "restoring"));
        yield* writeStore(fixture);
        const stopped = yield* Effect.promise(() =>
          moveScientProjectBackIntoProject({
            library: fixture.library,
            projectRoot: fixture.root,
            actor: "user",
            faults: { crashAt: "after-restore-backups" },
          }).catch((error: unknown) => error),
        );
        expect(stopped).toBeInstanceOf(ScientLibraryMoveCrash);
      }),
    expected: { state: "restoring", progress: null },
  },
  {
    name: "moved back",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => addV1Source(fixture.root, "back"));
        yield* writeStore(fixture);
        yield* Effect.promise(() =>
          moveProjectBackIntoProject({
            root: fixture.root,
            library: fixture.library,
            actor: "user",
          }),
        );
      }),
    expected: { state: "moved-back", restoredSources: 1, restoredPdfs: 0 },
  },
  {
    name: "failed, with the reason",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => addV1Source(fixture.root, "failed"));
        // A failed move keeps the project on its v1 store.
        const store = yield* writeStore(fixture, { faults: { crashAt: "after-library-copy" } });
        expect(store.kind).toBe("project");
      }),
    expected: { state: "failed", reason: "Simulated crash at after-library-copy." },
  },
];

describe("the move status, one row per state", () => {
  it.effect.each(STATUS_ROWS)("$name", (row) =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      const after = yield* row.arrange(fixture);
      expect(yield* statusOf(fixture)).toEqual(row.expected);
      if (after) yield* after;
    }),
  );

  it.effect("a dismissed summary stays dismissed until a later run", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(async () => {
        await addV1Source(fixture.root, "dismiss");
        await NodeFSP.mkdir(NodePath.join(fixture.root, ".scient/sources/bulk-edits"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(fixture.root, ".scient/sources/bulk-edits/batch_1.json"),
          "{}\n",
        );
      });
      const store = yield* writeStore(fixture);
      if (store.kind !== "library") throw new Error("Expected the library backend.");
      expect(
        yield* Effect.promise(() =>
          organizeLibrarySources(store, { change: { action: "dismiss-move-summary" } }),
        ),
      ).toEqual({ outcome: "dismissed" });
      expect(yield* statusOf(fixture)).toEqual({ state: "done", lines: [] });
      // Kept in this instance's migration folder, never in the project.
      const projectFiles = yield* Effect.promise(() =>
        NodeFSP.readdir(fixture.root, { recursive: true }),
      );
      expect(projectFiles.filter((entry) => entry.endsWith("summary.json"))).toEqual([]);
      // An older Scient writes again: the next run has a summary of its own.
      yield* Effect.promise(async () => {
        await addV1Source(fixture.root, "later");
        await NodeFSP.mkdir(NodePath.join(fixture.root, ".scient/sources/bulk-edits"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(fixture.root, ".scient/sources/bulk-edits/batch_2.json"),
          "{}\n",
        );
      });
      yield* writeStore(fixture);
      expect(yield* statusOf(fixture)).toEqual({
        state: "done",
        lines: [...SUMMARY_LINES, "Undo for bulk edits made before the move was not kept."],
      });
    }),
  );
});

/** Runs `work` while every write of `aliases.json` fails, as when a process stops or a disk fills there. */
async function stoppedAtAliases(work: () => Promise<unknown>): Promise<boolean> {
  const rename = NodeFS.promises.rename;
  NodeFS.promises.rename = async (from, to) => {
    if (String(to).endsWith("aliases.json")) throw new Error("Stopped here.");
    return rename(from, to);
  };
  NodeModule.syncBuiltinESMExports();
  try {
    return await work().then(
      () => false,
      () => true,
    );
  } finally {
    NodeFS.promises.rename = rename;
    NodeModule.syncBuiltinESMExports();
  }
}

describe("a merge or an Undo that stopped halfway", () => {
  const pair = (fixture: Fixture) =>
    Effect.promise(async () => {
      await ensureScientLibrary(fixture.library.root);
      const kept = await addSource(fixture.library, "KEPT");
      const merged = await addSource(fixture.library, "MERGED");
      return [kept.sourceId, merged.sourceId] as const;
    });
  const merge = (fixture: Fixture, [kept, merged]: readonly [string, string]) =>
    mergeScientLibrarySources({
      library: fixture.library,
      sourceIds: [kept, merged],
      survivorId: kept,
    });
  const aliasOf = (fixture: Fixture, sourceId: string) =>
    Effect.promise(async () => (await readScientLibraryAliases(fixture.library)).get(sourceId));

  it.effect("a merge is finished by the next write call", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      const ids = yield* pair(fixture);
      // The merged source reached the Trash; its alias did not.
      expect(yield* Effect.promise(() => stoppedAtAliases(() => merge(fixture, ids)))).toBe(true);
      expect(yield* aliasOf(fixture, ids[1])).toBeUndefined();

      yield* writeStore(fixture);

      expect((yield* aliasOf(fixture, ids[1]))?.survivorId).toBe(ids[0]);
    }),
  );

  // regression: review H1-a-1 finding 1, a settled-once memory skipped this.
  it.effect("an Undo that failed in a running server is finished by its next write call", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      const ids = yield* pair(fixture);
      yield* writeStore(fixture);
      const merged = yield* Effect.promise(() => merge(fixture, ids));
      if (merged.outcome !== "merged") throw new Error("Expected a merge.");
      // The merged source is back among the sources; its alias still points at the kept one.
      const failed = yield* Effect.promise(() =>
        stoppedAtAliases(() =>
          undoScientLibraryMerge({ library: fixture.library, mergeId: merged.merge.mergeId }),
        ),
      );
      expect(failed).toBe(true);
      expect((yield* aliasOf(fixture, ids[1]))?.undoneAt).toBeUndefined();

      yield* writeStore(fixture);

      expect((yield* aliasOf(fixture, ids[1]))?.undoneAt).toBeDefined();
    }),
  );

  it.effect("the background pass finishes it too, for a server with only read-only sessions", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      const ids = yield* pair(fixture);
      expect(yield* Effect.promise(() => stoppedAtAliases(() => merge(fixture, ids)))).toBe(true);

      yield* runLibraryMovePass([fixture.root]).pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          stateDir: fixture.stateDir,
        } as ServerConfig.ServerConfig["Service"]),
        Effect.provideService(ScientSourcesBackend, "library"),
        Effect.provide(gitLayer(fixture)),
      );

      expect((yield* aliasOf(fixture, ids[1]))?.survivorId).toBe(ids[0]);
    }),
  );
});
