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
import {
  ScientSourceMetadataUpdateResult,
  ScientSourceNoteUpdateResult,
  ScientSourcesDuplicatesResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { beginBibliographyFileImport } from "./BibliographyFileAdapter.ts";
import { libraryImportPinInstance } from "./LibraryImportPins.ts";
import {
  exportLibrarySources,
  isLibraryOrganizeAction,
  libraryDuplicates,
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

// What a client receives: the HTTP contract keeps only the fields it names.
const encodeEditAnswer = Schema.encodeSync(ScientSourceMetadataUpdateResult);
const encodeNoteAnswer = Schema.encodeSync(ScientSourceNoteUpdateResult);
const encodeDuplicates = Schema.encodeSync(ScientSourcesDuplicatesResult);

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
    allowPossibleMetadataMatch: true,
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
    actor: "user",
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

  it.effect("answers two stale panels with the note saved first and its history", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const record = yield* Effect.promise(async () => {
        const one = await libraryRecord(fixture, "one", { title: "Vasopressin timing" });
        await pin(fixture, one.sourceId);
        return one;
      });
      const store = yield* storeFor(fixture, "write");
      const save = (note: string, session: string) =>
        Effect.promise(() =>
          updateLibraryProjectNote(store, {
            sourceId: record.sourceId,
            note,
            expectedNote: null,
            noteSession: session,
          }),
        );
      expect(yield* save("From the first window", "a")).toMatchObject({ outcome: "updated" });
      const second = yield* save("From the second window", "b");
      expect(second).toMatchObject({
        outcome: "stale",
        record: { note: "From the first window" },
      });
      expect(encodeNoteAnswer(second).record).toMatchObject({ note: "From the first window" });
      const detail = yield* Effect.promise(() =>
        librarySourceDetail(store, { sourceId: record.sourceId }),
      );
      expect(detail).not.toHaveProperty("projectNoteHistory");
      yield* Effect.promise(() =>
        updateLibraryProjectNote(store, {
          sourceId: record.sourceId,
          note: "From the second window",
          expectedNote: "From the first window",
          noteSession: "b",
        }),
      );
      expect(
        yield* Effect.promise(() => librarySourceDetail(store, { sourceId: record.sourceId })),
      ).toMatchObject({
        projectNoteHistory: [{ note: "From the first window" }, { note: "From the second window" }],
      });
    }),
  );

  it.effect("catches up a stale pin snapshot at every change", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const [stale, edited] = yield* Effect.promise(async () => {
        const one = await libraryRecord(fixture, "one", { title: "Vasopressin timing" });
        const two = await libraryRecord(fixture, "two", { title: "Lactate clearance" });
        await pin(fixture, one.sourceId);
        await pin(fixture, two.sourceId);
        return [one, two] as const;
      });
      const store = yield* storeFor(fixture, "write");
      const pinsFile = NodePath.join(fixture.root, ".scient", "library", "pins.json");
      // As after a refresh that failed, or one lost with the previous server.
      const makeStale = async () =>
        NodeFSP.writeFile(
          pinsFile,
          (await NodeFSP.readFile(pinsFile, "utf8")).replace("Vasopressin timing", "Old title"),
        );
      const titleOf = async (sourceId: string) =>
        (await readScientProjectPins(fixture.root)).find((entry) => entry.sourceId === sourceId)
          ?.work.title;
      const retitle = async (revision: number, title: string) => {
        const result = await updateLibrarySourceMetadata(store, {
          sourceId: edited.sourceId,
          expectedRevision: revision,
          metadata: {
            type: "article",
            title,
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
        expect(result.outcome).toBe("updated");
      };

      yield* Effect.promise(async () => {
        await makeStale();
        await retitle(edited.revision, "Lactate clearance, corrected");
        expect(await titleOf(stale.sourceId)).toBe("Vasopressin timing");
        expect(await titleOf(edited.sourceId)).toBe("Lactate clearance, corrected");

        // Every change refreshes every pin, so it is caught up again the next time too.
        await makeStale();
        await retitle(edited.revision + 1, "Lactate clearance, again");
        expect(await titleOf(edited.sourceId)).toBe("Lactate clearance, again");
        expect(await titleOf(stale.sourceId)).toBe("Vasopressin timing");
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
          await updateLibraryProjectNote(write, {
            sourceId: a.sourceId,
            note: "Project reason.",
            expectedNote: "Why this project cites it.",
          }),
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

  it.effect(
    "applies a note in its place in the request, not to a source that takes the key later",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const a = yield* Effect.promise(() =>
          libraryRecord(fixture, "a", { title: "Vasopressin timing" }),
        );
        const b = yield* Effect.promise(() =>
          libraryRecord(fixture, "b", { title: "Lactate clearance" }),
        );
        const write = yield* storeFor(fixture, "write");
        yield* Effect.promise(async () => {
          const key = b.citationKey!;
          const first = await pin(fixture, a.sourceId);
          await renameScientProjectPinKey({
            projectRoot: fixture.root,
            citationKey: first.citationKey,
            to: key,
          });
          const noted = { citationKey: key, sourceId: a.sourceId, note: "About the first paper." };
          const result = await organizeLibrarySources(write, {
            change: {
              action: "change-pins",
              changes: [
                { action: "pin", sourceId: a.sourceId, note: noted.note },
                { action: "unpin", citationKey: key },
                { action: "pin", sourceId: b.sourceId },
              ],
            },
          });
          expect(result).toEqual({
            outcome: "updated",
            pinChanges: [
              { outcome: "existing", pin: noted },
              { outcome: "unpinned", pin: noted },
              { outcome: "pinned", pin: { citationKey: key, sourceId: b.sourceId } },
            ],
          });
          expect(
            (await readScientProjectPins(fixture.root)).map((entry) => [
              entry.citationKey,
              entry.sourceId,
              entry.note,
            ]),
          ).toEqual([[key, b.sourceId, undefined]]);
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

  it.effect(
    "lists possible duplicates without merging, marks a pair not duplicates and undoes it",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const other = yield* Effect.promise(() => project(fixture.base, "Grant"));
        const [first, second] = yield* Effect.promise(async () => {
          const one = await libraryRecord(fixture, "pair1", {
            title: "Shock trial",
            publisher: "North",
            volume: "12",
            identifiers: [{ scheme: "pmid", value: "4412" }],
          });
          const two = await libraryRecord(fixture, "pair2", {
            title: "Shock trial",
            publisher: "South",
          });
          await pin(fixture, one.sourceId);
          await pin(fixture, two.sourceId, other);
          await libraryImportPinInstance(fixture.library, other);
          return [one, two] as const;
        });
        const store = yield* storeFor(fixture, "write");
        const records = () => listScientSourceRecords(fixture.library);

        const listed = yield* Effect.promise(() => libraryDuplicates(store));
        expect(listed.pairsTotal).toBe(1);
        expect(
          listed.pairs[0]!.sources.map((side) => [side.sourceId, side.pinned, side.otherProjects]),
        ).toEqual([
          [first.sourceId, true, []],
          [second.sourceId, false, ["Grant"]],
        ]);
        const titled = yield* Effect.promise(() =>
          libraryDuplicates(store, [{ workspaceRoot: other, title: "Grant proposal" }]),
        );
        expect(titled.pairs[0]!.sources[1].otherProjects).toEqual(["Grant proposal"]);
        expect(listed.pairs[0]!.keptByDefault).toBe(first.sourceId);
        expect((yield* Effect.promise(records)).length).toBe(2);

        const pair = [first.sourceId, second.sourceId] as const;
        const unknown = yield* Effect.promise(() =>
          organizeLibrarySources(store, {
            change: { action: "mark-distinct", sourceIds: [first.sourceId, "source_typo"] },
          }),
        );
        expect(unknown.outcome).toBe("not-found");
        expect((yield* Effect.promise(() => libraryDuplicates(store))).pairsTotal).toBe(1);
        const marked = yield* Effect.promise(() =>
          organizeLibrarySources(store, { change: { action: "mark-distinct", sourceIds: pair } }),
        );
        expect(marked.outcome).toBe("marked");
        expect((yield* Effect.promise(() => libraryDuplicates(store))).pairs).toEqual([]);
        const cleared = yield* Effect.promise(() =>
          organizeLibrarySources(store, { change: { action: "clear-distinct", sourceIds: pair } }),
        );
        expect(cleared.outcome).toBe("cleared");
        expect((yield* Effect.promise(() => libraryDuplicates(store))).pairsTotal).toBe(1);

        const merged = yield* Effect.promise(() =>
          organizeLibrarySources(store, {
            change: { action: "merge", sourceIds: [...pair], survivorId: second.sourceId },
          }),
        );
        expect(merged.outcome).toBe("merged");
        const afterMerge = yield* Effect.promise(() => libraryDuplicates(store));
        expect(afterMerge.pairs).toEqual([]);
        expect(afterMerge.merges).toMatchObject([
          {
            requested: true,
            keptSourceId: second.sourceId,
            kept: { sourceId: second.sourceId },
            mergedSourceId: first.sourceId,
            mergedTitle: "Shock trial",
            merged: { sourceId: first.sourceId, title: "Shock trial" },
            keptDifferent: ["publisher"],
          },
        ]);
        // The kept one's own value, and the other's, also where the kept one had none.
        // Identifiers are named without values: the merge file records only what it added.
        expect(encodeDuplicates(afterMerge).merges[0]!.differences).toEqual([
          { field: "publisher", kept: "South", other: "North" },
          { field: "volume", kept: null, other: "12" },
          { field: "identifiers" },
        ]);
        yield* Effect.promise(() =>
          organizeLibrarySources(store, {
            change: { action: "undo-merge", mergeId: afterMerge.merges[0]!.mergeId },
          }),
        );
        const afterUndo = yield* Effect.promise(() => libraryDuplicates(store));
        expect(afterUndo.merges).toEqual([]);
        expect(afterUndo.pairsTotal).toBe(1);
        expect((yield* Effect.promise(records)).length).toBe(2);
      }),
  );

  it.effect(
    "lists a source once after merging two sources this project both pins, keeping both keys",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const { first, second, firstPin, secondPin } = yield* Effect.promise(async () => {
          const one = await libraryRecord(fixture, "pair1", { title: "Shock trial" });
          const two = await libraryRecord(fixture, "pair2", {
            title: "Shock trial",
            publisher: "South",
          });
          return {
            first: one,
            second: two,
            firstPin: await pin(fixture, one.sourceId),
            secondPin: await pin(fixture, two.sourceId),
          };
        });
        const store = yield* storeFor(fixture, "write");
        yield* Effect.promise(async () => {
          const merged = await organizeLibrarySources(store, {
            change: {
              action: "merge",
              sourceIds: [first.sourceId, second.sourceId],
              survivorId: second.sourceId,
            },
          });
          expect(merged.outcome).toBe("merged");

          const here = await libraryOverview(store, { scope: "project", background: false });
          expect(here.scopes.project).toBe(1);
          // The key pinned first, whichever side the merge kept.
          expect(
            here.records.map((row) => [row.sourceId, row.citationKey, row.alsoCitedAs]),
          ).toEqual([[second.sourceId, firstPin.citationKey, [secondPin.citationKey]]]);
          const everything = await libraryOverview(store, { scope: "library", background: false });
          expect(everything.records).toMatchObject([
            { citationKey: firstPin.citationKey, alsoCitedAs: [secondPin.citationKey] },
          ]);
          expect(await librarySourceDetail(store, { sourceId: first.sourceId })).toMatchObject({
            citationKey: firstPin.citationKey,
            alsoCitedAs: [secondPin.citationKey],
          });
          expect((await exportLibrarySources(store, { format: "bibtex" })).sourceCount).toBe(1);
          // Documents may cite either key, so the bibliography keeps both.
          const bibliography = await NodeFSP.readFile(
            NodePath.join(fixture.root, "references.bib"),
            "utf8",
          );
          expect(bibliography).toContain(`{${firstPin.citationKey},`);
          expect(bibliography).toContain(`{${secondPin.citationKey},`);

          // An edit's answer, as a client receives it, still names both keys, so the panel's
          // Remove from this project unpins both.
          const kept = await librarySourceDetail(store, { sourceId: second.sourceId });
          const edited = encodeEditAnswer(
            await updateLibrarySourceMetadata(store, {
              sourceId: kept.sourceId,
              expectedRevision: kept.revision,
              metadata: {
                type: kept.type,
                title: "Shock trial, corrected",
                creators: kept.creators,
                issuedRaw: kept.issuedRaw,
                issuedYear: kept.issuedYear,
                identifiers: kept.identifiers,
                abstract: kept.abstract,
                containerTitle: kept.containerTitle,
                publisher: kept.publisher,
                volume: kept.volume,
                issue: kept.issue,
                pages: kept.pages,
                language: kept.language,
                url: kept.url,
                tags: kept.tags,
              },
            }),
          );
          const noted = encodeNoteAnswer(
            await updateLibraryProjectNote(store, { sourceId: kept.sourceId, note: "Primary" }),
          );
          for (const answer of [edited, noted]) {
            expect(answer.record).toMatchObject({
              citationKey: firstPin.citationKey,
              alsoCitedAs: [secondPin.citationKey],
              pinned: true,
            });
          }
        });
      }),
  );

  it("counts both distinct actions as Library-only, which a project server refuses", () => {
    const sourceIds = ["source_a", "source_b"] as const;
    expect(isLibraryOrganizeAction({ action: "mark-distinct", sourceIds })).toBe(true);
    expect(isLibraryOrganizeAction({ action: "clear-distinct", sourceIds })).toBe(true);
  });
});
