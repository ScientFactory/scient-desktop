// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { changeScientLibraryReview } from "@scientfactory/scient-sources/library-reviews";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  pinScientLibrarySource,
  readScientProjectPins,
  renameScientProjectPinKey,
  setScientProjectPinNote,
} from "@scientfactory/scient-sources/project-pins";
import {
  importScientSource,
  listScientSourceRecords,
  removeScientSource,
  updateScientSourceNote,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../../config.ts";
import { beginBibliographyFileImport } from "./BibliographyFileAdapter.ts";
import { libraryImportPinInstance } from "./LibraryImportPins.ts";
import {
  exportLibrarySources,
  libraryImportTarget,
  libraryOverview,
  libraryReview,
  librarySourceDetail,
  organizeLibrarySources,
  updateLibraryPersonalNote,
  updateLibraryProjectNote,
  updateLibrarySourceMetadata,
} from "./LibrarySourcesRoutes.ts";
import { setLibraryReadingState } from "./LibraryProjectSources.ts";
import { advanceSourceImport, beginZoteroImport } from "./ScientSourcesCoordinator.ts";
import {
  ScientSourcesBackend,
  resolveScientLibraryStoreAt,
  type ScientSourcesAccess,
} from "./SourcesBackend.ts";

const fixtures: string[] = [];
const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(base: string, name: string) {
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  return root;
}

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-routes-")),
  );
  fixtures.push(base);
  const stateDir = NodePath.join(base, "state");
  const libraryRoot = scientLibraryRootFor(stateDir);
  return {
    base,
    root: await project(base, "project"),
    stateDir,
    libraryRoot,
    library: scientLibraryLocation(libraryRoot),
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** The store a route resolves for this project on the library backend. */
const storeFor = (fixture: Fixture, access: ScientSourcesAccess, root = fixture.root) =>
  resolveScientLibraryStoreAt(root, access).pipe(
    Effect.filterOrElse(
      (store) => store !== null,
      () => Effect.die(new Error("Expected the library backend.")),
    ),
    Effect.provideService(ServerConfig, { stateDir: fixture.stateDir } as ServerConfig["Service"]),
    Effect.provideService(ScientSourcesBackend, "library"),
  );

async function libraryRecord(
  fixture: Fixture,
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate>,
) {
  await ensureScientLibrary(fixture.libraryRoot);
  const imported = await importScientSource({
    root: fixture.library,
    operationId: NodeCrypto.randomUUID(),
    candidate: {
      sourceKey,
      type: "article",
      customType: null,
      title: null,
      creators: [ada],
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
      ...overrides,
    },
  });
  if (!imported.record) throw new Error(`Expected ${sourceKey} to import.`);
  return imported.record;
}

async function pin(fixture: Fixture, sourceId: string, root = fixture.root) {
  const pinned = await pinScientLibrarySource({
    projectRoot: root,
    library: fixture.library,
    sourceId,
    actor: "user",
  });
  if (pinned.outcome === "not-found") throw new Error("Expected the pin.");
  return pinned.pin;
}

async function folderBytes(root: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  const files = await Promise.all(
    entries
      .filter((item) => item.isFile())
      .map(async (item) => {
        const path = NodePath.join(item.parentPath, item.name);
        return [NodePath.relative(root, path), await NodeFSP.readFile(path, "base64")] as const;
      }),
  );
  return files.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

const entry = (key: string, title: string, doi: string) =>
  `@article{${key},\n  title = {${title}},\n  author = {Lovelace, Ada},\n  year = {2026},\n  journal = {Scient Journal},\n  doi = {${doi}}\n}\n`;

/**
 * A: pinned here under a project key that differs from its preferred key, with a project note.
 * B: in the library, not pinned here. C: pinned here, then removed from the library.
 */
async function threeSources(fixture: Fixture) {
  const a = await libraryRecord(fixture, "a", {
    title: "Vasopressin timing",
    citationKey: "lovelace2026a",
  });
  const b = await libraryRecord(fixture, "b", { title: "Lactate clearance" });
  const c = await libraryRecord(fixture, "c", { title: "Fluid balance" });
  await pin(fixture, a.sourceId);
  await renameScientProjectPinKey({
    projectRoot: fixture.root,
    citationKey: "lovelace2026a",
    to: "vasopressinHere",
  });
  await setScientProjectPinNote({
    projectRoot: fixture.root,
    citationKey: "vasopressinHere",
    note: "Why this project cites it.",
  });
  await pin(fixture, c.sourceId);
  await removeScientSource({
    root: fixture.library,
    sourceId: c.sourceId,
    expectedRevision: c.revision,
  });
  return { a, b, c };
}

describe("Library routes on the library backend", () => {
  it.effect(
    "lists this project's pins under project keys or the whole library, with both totals",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const { a, b, c } = yield* Effect.promise(() => threeSources(fixture));
        const store = yield* storeFor(fixture, "read");
        yield* Effect.promise(async () => {
          const here = await libraryOverview(store, { scope: "project", background: false });
          expect(here.scopes).toEqual({ listed: "project", project: 2, library: 2 });
          expect(here.records).toEqual([
            expect.objectContaining({
              sourceId: c.sourceId,
              title: "Fluid balance",
              pinned: true,
              fromSnapshot: true,
            }),
            expect.objectContaining({
              sourceId: a.sourceId,
              citationKey: "vasopressinHere",
              pinned: true,
              projectNote: "Why this project cites it.",
            }),
          ]);
          expect(here.records[1]).not.toHaveProperty("fromSnapshot");

          const everything = await libraryOverview(store, { scope: "library", background: false });
          expect(everything.scopes).toEqual({ listed: "library", project: 2, library: 2 });
          expect(
            everything.records.map(({ sourceId, citationKey, pinned }) => ({
              sourceId,
              citationKey,
              pinned,
            })),
          ).toEqual(
            expect.arrayContaining([
              { sourceId: a.sourceId, citationKey: "vasopressinHere", pinned: true },
              { sourceId: b.sourceId, citationKey: b.citationKey, pinned: false },
            ]),
          );

          // A library record, and a pin this library lacks by the project source ID it stores.
          expect(await librarySourceDetail(store, { sourceId: a.sourceId })).toMatchObject({
            sourceId: a.sourceId,
            citationKey: "vasopressinHere",
            note: "Why this project cites it.",
            pinned: true,
          });
          expect(await librarySourceDetail(store, { sourceId: c.sourceId })).toMatchObject({
            sourceId: c.sourceId,
            title: "Fluid balance",
            pinned: true,
            fromSnapshot: true,
          });
        });
      }),
  );

  it.effect(
    "pins what an import from This project brings in, and nothing from the Library view",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const store = yield* storeFor(fixture, "write");
        yield* Effect.promise(async () => {
          const importFile = async (pin: boolean | undefined, name: string, text: string) => {
            const { operation } = await beginBibliographyFileImport({
              ...libraryImportTarget(store, pin),
              projectRoot: store.root,
              operationId: `file_${name}`,
              fileName: `${name}.bib`,
              text,
              actor: "user",
            });
            let current = operation!;
            while (current.state === "running") {
              current = await advanceSourceImport({
                root: store.library,
                operationId: current.operationId,
              });
            }
            return current;
          };

          await importFile(undefined, "here", entry("here2026", "Pinned here", "10.1000/here"));
          expect((await readScientProjectPins(fixture.root)).map((pin) => pin.citationKey)).toEqual(
            ["here2026"],
          );

          const before = await folderBytes(fixture.root);
          const done = await importFile(
            false,
            "library",
            entry("away2026", "Library only", "10.1000/away"),
          );
          expect(done.state).toBe("completed");
          expect(await folderBytes(fixture.root)).toEqual(before);
          expect(
            (await listScientSourceRecords(fixture.library)).map((record) => record.title),
          ).toEqual(expect.arrayContaining(["Pinned here", "Library only"]));
        });
      }),
  );

  it.effect(
    "refuses a second import while one runs, from any project, and shows the running one",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const other = yield* Effect.promise(() => project(fixture.base, "other"));
        const here = yield* storeFor(fixture, "write");
        const fromOther = yield* storeFor(fixture, "write", other);
        const otherRead = yield* storeFor(fixture, "read", other);
        yield* Effect.promise(async () => {
          const first = await beginZoteroImport({
            ...libraryImportTarget(here, undefined),
            operationId: "zotero_first",
            itemKeys: ["ABCD2345"],
            possibleMetadataMatchOverrides: [],
          });

          await expect(
            beginZoteroImport({
              ...libraryImportTarget(fromOther, undefined),
              operationId: "zotero_second",
              itemKeys: ["EFGH2345"],
              possibleMetadataMatchOverrides: [],
            }),
          ).rejects.toThrow("Another source import is already running in the Library.");
          const overview = await libraryOverview(otherRead, {
            scope: "project",
            background: false,
          });
          expect(overview.activeOperation?.operationId).toBe(first.operationId);
        });
      }),
  );

  it.effect("says how many other projects pin a source an edit changed", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { record } = yield* Effect.promise(async () => {
        const shared = await libraryRecord(fixture, "shared", { title: "Shared work" });
        const other = await project(fixture.base, "other");
        await pin(fixture, shared.sourceId);
        await pin(fixture, shared.sourceId, other);
        await libraryImportPinInstance(fixture.library, other);
        return { record: shared };
      });
      const store = yield* storeFor(fixture, "write");
      yield* Effect.promise(async () => {
        const result = await updateLibrarySourceMetadata(store, {
          sourceId: record.sourceId,
          expectedRevision: record.revision,
          metadata: {
            type: "article",
            title: "Shared work, corrected",
            creators: [ada],
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
          },
        });

        expect(result).toMatchObject({ outcome: "updated", alsoPinnedIn: 1 });
      });
    }),
  );

  it.effect(
    "serves a review screen from the snapshot on a computer with no library, writing nothing",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const { record, reviewId, before } = yield* Effect.promise(async () => {
          const record = await libraryRecord(fixture, "screened", {
            title: "Septic shock outcomes",
            abstract: "Mortality at 28 days.",
          });
          const { reviewId } = await changeScientLibraryReview({
            projectRoot: fixture.root,
            library: fixture.library,
            change: { action: "create-review", title: "Sepsis review" },
            actor: "user",
          });
          await changeScientLibraryReview({
            projectRoot: fixture.root,
            library: fixture.library,
            change: {
              action: "log-search",
              reviewId: reviewId!,
              database: "PubMed",
              query: "sepsis",
              searchedOn: "2026-11-11",
              sourceIds: [record.sourceId],
            },
            actor: "user",
          });
          await NodeFSP.rm(fixture.libraryRoot, { recursive: true });
          const before = await Promise.all([
            folderBytes(fixture.root),
            folderBytes(fixture.stateDir),
          ]);
          return { record, reviewId, before };
        });
        const store = yield* storeFor(fixture, "read");
        yield* Effect.promise(async () => {
          const review = await libraryReview(store, { reviewId: reviewId! });
          const detail = await librarySourceDetail(store, {
            sourceId: record.sourceId,
            reviewId: reviewId!,
          });

          expect(store.exists).toBe(false);
          expect(review.records).toEqual([
            expect.objectContaining({
              sourceId: record.sourceId,
              title: "Septic shock outcomes",
              label: "From this review's snapshot",
            }),
          ]);
          expect(detail).toMatchObject({
            abstract: "Mortality at 28 days.",
            label: "From this review's snapshot",
          });
          expect(
            await Promise.all([folderBytes(fixture.root), folderBytes(fixture.stateDir)]),
          ).toEqual(before);
        });
      }),
  );

  it.effect("keeps a library record's personal note out of every route payload", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { a, noted, reviewId } = yield* Effect.promise(async () => {
        const { a } = await threeSources(fixture);
        const noted = await updateScientSourceNote({
          root: fixture.library,
          sourceId: a.sourceId,
          expectedRevision: a.revision,
          note: "PERSONAL-NOTE-SECRET",
          actor: "user",
        });
        const { reviewId } = await changeScientLibraryReview({
          projectRoot: fixture.root,
          library: fixture.library,
          change: { action: "create-review", title: "Review" },
          actor: "user",
        });
        await changeScientLibraryReview({
          projectRoot: fixture.root,
          library: fixture.library,
          change: {
            action: "log-search",
            reviewId: reviewId!,
            database: "PubMed",
            query: "vasopressin",
            searchedOn: "2026-11-11",
            sourceIds: [a.sourceId],
          },
          actor: "user",
        });
        return { a, noted, reviewId };
      });
      const read = yield* storeFor(fixture, "read");
      const write = yield* storeFor(fixture, "write");
      yield* Effect.promise(async () => {
        const payloads = [
          await libraryOverview(read, { scope: "project", background: false }),
          await libraryOverview(read, { scope: "library", background: false }),
          await librarySourceDetail(read, { sourceId: a.sourceId }),
          await librarySourceDetail(read, { sourceId: a.sourceId, reviewId: reviewId! }),
          await libraryReview(read, { reviewId: reviewId! }),
          await exportLibrarySources(read, { format: "csl-json", includeNotes: true }),
          await exportLibrarySources(read, {
            format: "bibtex",
            sourceIds: [a.sourceId],
            includeNotes: true,
          }),
          await updateLibraryProjectNote(write, { sourceId: a.sourceId, note: "Project reason." }),
          await updateLibrarySourceMetadata(write, {
            sourceId: a.sourceId,
            expectedRevision: noted.record.revision,
            metadata: {
              type: "article",
              title: "Vasopressin timing, corrected",
              creators: [ada],
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
            },
          }),
          await libraryOverview(read, {
            scope: "library",
            background: false,
            readingStatus: "unread",
          }),
          await setLibraryReadingState(write, { sourceIds: [a.sourceId], starred: true }),
        ];

        for (const payload of payloads) {
          expect(JSON.stringify(payload)).not.toContain("PERSONAL-NOTE-SECRET");
        }
        expect(JSON.stringify(payloads[5])).toContain("Why this project cites it.");
        // Only a session holding the Library write grant asks for it, and only in the detail.
        expect(
          await librarySourceDetail(read, { sourceId: a.sourceId, personal: true }),
        ).toMatchObject({ personalNote: "PERSONAL-NOTE-SECRET", note: "Project reason." });
      });
    }),
  );

  it.effect("adds and removes many sources in one request, answering each as alone", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { a, b, c } = yield* Effect.promise(() => threeSources(fixture));
      const write = yield* storeFor(fixture, "write");
      yield* Effect.promise(async () => {
        const snapshotKey = (await readScientProjectPins(fixture.root)).find(
          (entry) => entry.sourceId === c.sourceId,
        )!.citationKey;
        const result = await organizeLibrarySources(write, {
          change: {
            action: "change-pins",
            changes: [
              { action: "pin", sourceId: b.sourceId },
              { action: "pin", sourceId: a.sourceId },
              { action: "pin", sourceId: "source_missing" },
              { action: "unpin", citationKey: snapshotKey },
              { action: "unpin", citationKey: "nobody2026" },
            ],
          },
        });
        expect(result).toEqual({
          outcome: "updated",
          pinChanges: [
            { outcome: "pinned", pin: { citationKey: b.citationKey, sourceId: b.sourceId } },
            {
              outcome: "existing",
              pin: {
                citationKey: "vasopressinHere",
                sourceId: a.sourceId,
                note: "Why this project cites it.",
              },
            },
            { outcome: "not-found" },
            { outcome: "unpinned", pin: { citationKey: snapshotKey, sourceId: c.sourceId } },
            { outcome: "not-pinned" },
          ],
        });
        const listed = await libraryOverview(write, { scope: "project", background: false });
        expect(listed.records.map((record) => record.sourceId).toSorted()).toEqual(
          [a.sourceId, b.sourceId].toSorted(),
        );
        const bibliography = await NodeFSP.readFile(
          NodePath.join(fixture.root, "references.bib"),
          "utf8",
        );
        expect(bibliography).toContain(`{${b.citationKey},`);
        expect(bibliography).not.toContain(`{${snapshotKey},`);
      });
    }),
  );

  it.effect("sets reading state on one source or many and filters the list by it", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { a, b } = yield* Effect.promise(() => threeSources(fixture));
      const write = yield* storeFor(fixture, "write");
      yield* Effect.promise(async () => {
        const fresh = await libraryOverview(write, { scope: "library", background: false });
        expect(fresh.records.map(({ readingStatus, starred }) => [readingStatus, starred])).toEqual(
          [
            ["unread", false],
            ["unread", false],
          ],
        );

        expect(
          await setLibraryReadingState(write, { sourceIds: [a.sourceId], readingStatus: "read" }),
        ).toEqual({
          sources: [
            { sourceId: a.sourceId, outcome: "updated", readingStatus: "read", starred: false },
          ],
        });
        const many = await setLibraryReadingState(write, {
          sourceIds: [a.sourceId, b.sourceId, "source_unknown"],
          starred: true,
        });
        expect(many.sources.map(({ outcome }) => outcome)).toEqual([
          "updated",
          "updated",
          "not-found",
        ]);

        const read = await libraryOverview(write, {
          scope: "library",
          background: false,
          readingStatus: "read",
        });
        expect(read.records.map((record) => record.sourceId)).toEqual([a.sourceId]);
        expect(read.scopes.library).toBe(2);
        const starred = await libraryOverview(write, {
          scope: "project",
          background: false,
          starred: true,
        });
        // The removed source's pin is a snapshot: it has no reading state to match.
        expect(starred.records.map((record) => record.sourceId)).toEqual([a.sourceId]);
        expect(await librarySourceDetail(write, { sourceId: a.sourceId })).toMatchObject({
          revision: a.revision,
          readingStatus: "read",
          starred: true,
          projectNote: "Why this project cites it.",
        });

        const noted = await updateLibraryPersonalNote(write, {
          sourceId: a.sourceId,
          expectedRevision: a.revision,
          note: "My own reading.",
        });
        expect(noted).toMatchObject({
          outcome: "updated",
          record: {
            note: "Why this project cites it.",
            projectNote: "Why this project cites it.",
            personalNote: "My own reading.",
            readingStatus: "read",
          },
        });
      });
    }),
  );
});
