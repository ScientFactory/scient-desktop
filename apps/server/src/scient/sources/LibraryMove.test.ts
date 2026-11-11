// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project, library and git folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  readScientLibraryMoveState,
  scientLibraryMoveStatusLines,
} from "@scientfactory/scient-sources/library-move";
import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { runLibraryMovePass } from "./LibraryMovePass.ts";
import { organizeLibrarySources } from "./LibrarySourcesRoutes.ts";
import { ScientSourcesBackend, resolveScientSourcesStoreFor } from "./SourcesBackend.ts";

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

async function addV1Source(root: string, sourceKey: string) {
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

/** A write call on the library backend, with this fixture's state folder and the git driver. */
const writeStore = (fixture: Fixture) =>
  resolveScientSourcesStoreFor({ projectId: "project", root: fixture.root }, "write").pipe(
    Effect.provideService(ServerConfig.ServerConfig, {
      stateDir: fixture.stateDir,
    } as ServerConfig.ServerConfig["Service"]),
    Effect.provideService(ScientSourcesBackend, "library"),
    Effect.provide(gitLayer(fixture)),
  );

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
        ["The Library moved out of this project. Commit the change to stop storing PDFs in git."],
      );
    }),
  );

  it.effect("an untracked project moves silently", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setup());
      yield* Effect.promise(async () => {
        await addV1Source(fixture.root, "untracked");
        await git(fixture.root, "init", "-q");
      });
      yield* writeStore(fixture);
      const journal = yield* Effect.promise(() => journalOf(fixture));
      expect(journal?.state).toBe("done");
      expect(scientLibraryMoveStatusLines(journal)).toEqual([]);
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
