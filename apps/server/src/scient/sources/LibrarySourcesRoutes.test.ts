// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { checkScientLibraryBackup } from "@scientfactory/scient-sources/library-backup";
import {
  mergeScientLibrarySources,
  undoScientLibraryMerge,
} from "@scientfactory/scient-sources/library-merge";
import { recordScientLibraryNoticeCheck } from "@scientfactory/scient-sources/library-notice-watch";
import { changeScientLibraryReview } from "@scientfactory/scient-sources/library-reviews";
import { keepScientDisplacedCopies } from "@scientfactory/scient-sources/project-displaced-copies";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  pinScientLibrarySource,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
  renameScientProjectPinKey,
  setScientProjectPinNote,
} from "@scientfactory/scient-sources/project-pins";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceNote,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import {
  ScientSourceDetailResult,
  ScientSourceMetadataUpdateResult,
  ScientSourceNoteUpdateResult,
  ScientSourcesDuplicatesResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { beginBibliographyFileImport } from "./BibliographyFileAdapter.ts";
import { libraryBackupStatus } from "./LibraryBackupRuns.ts";
import { libraryJoinStatus } from "./LibraryJoinRuns.ts";
import {
  cancelLibraryRestore,
  finishLibraryRestoreAtStart,
  libraryRestoreStatus,
  startLibraryRestore,
} from "./LibraryRestoreRuns.ts";
import { libraryImportPinInstance } from "./LibraryImportPins.ts";
import {
  bulkUpdateLibrarySources,
  exportLibrarySources,
  isLibraryOrganizeAction,
  libraryDuplicates,
  libraryImportTarget,
  libraryOverview,
  libraryRecentChanges,
  libraryReview,
  librarySourceDetail,
  organizeLibrarySources,
  removeLibrarySource,
  restoreLibrarySource,
  updateLibraryPersonalNote,
  updateLibraryProjectNote,
  updateLibrarySourceMetadata,
} from "./LibrarySourcesRoutes.ts";
import { setLibraryReadingState } from "./LibraryProjectSources.ts";
import { createScientSourceCollection } from "@scientfactory/scient-sources/collections";
import { advanceSourceImport, beginZoteroImport } from "./ScientSourcesCoordinator.ts";
import {
  ScientSourcesBackend,
  resolveScientLibraryStoreAt,
  type ScientSourcesAccess,
} from "./SourcesBackend.ts";

const fixtures: string[] = [];
const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

afterEach(async () => {
  vi.useRealTimers();
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
const encodeDetail = Schema.encodeSync(ScientSourceDetailResult);
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
    "blocks writes until an interrupted merge can finish, while keeping reads available",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const store = yield* storeFor(fixture, "write");
        const recovery = yield* Effect.promise(async () => {
          const identifier = { scheme: "doi", value: "10.1000/recovery" };
          const first = await libraryRecord(fixture, "first", {
            title: "Interrupted merge",
            identifiers: [identifier],
          });
          const second = await libraryRecord(fixture, "second", { title: "Interrupted merge" });
          const merged = await mergeScientLibrarySources({
            library: fixture.library,
            sourceIds: [first.sourceId, second.sourceId],
            survivorId: first.sourceId,
          });
          if (merged.outcome !== "merged") throw new Error("Expected the source pair to merge.");
          const directory = NodePath.join(fixture.library.root, "merges", "pending");
          await NodeFSP.mkdir(directory, { recursive: true });
          const pending = NodePath.join(directory, `${merged.merge.mergeId}.json`);
          await NodeFSP.writeFile(pending, JSON.stringify({ ...merged.merge, state: "pending" }));
          const aliasesPath = NodePath.join(fixture.library.root, "aliases.json");
          const aliases = await NodeFSP.readFile(aliasesPath);
          await NodeFSP.unlink(aliasesPath);
          await NodeFSP.mkdir(aliasesPath);
          return { pending, aliasesPath, aliases, first };
        });

        const read = yield* storeFor(fixture, "read");
        expect(read.library).toEqual(store.library);
        const failure = yield* Effect.flip(storeFor(fixture, "write"));
        expect(failure).toMatchObject({ _tag: "ScientLibraryRecoveryError" });
        yield* Effect.promise(async () => {
          expect(
            (await readScientSourceRecord(fixture.library, recovery.first.sourceId))?.title,
          ).toBe(recovery.first.title);
          expect(await NodeFSP.readFile(recovery.pending, "utf8")).toContain('"state":"pending"');
          await NodeFSP.rmdir(recovery.aliasesPath);
          await NodeFSP.writeFile(recovery.aliasesPath, recovery.aliases);
        });
        const recovered = yield* storeFor(fixture, "write");
        expect(recovered.library).toEqual(store.library);
        yield* Effect.promise(async () => {
          await expect(NodeFSP.stat(recovery.pending)).rejects.toMatchObject({ code: "ENOENT" });
        });
      }),
  );

  it.effect(
    "answers unchanged while the list would be the same, and in full after any change",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const { a, b } = yield* Effect.promise(() => threeSources(fixture));
        const store = yield* storeFor(fixture, "write");
        const list = (scope: "library" | "project", knownRevision?: string) =>
          Effect.promise(() =>
            libraryOverview(store, {
              scope,
              background: false,
              ...(knownRevision ? { knownRevision } : {}),
            }),
          );
        const first = yield* list("library");
        expect(first.records).toHaveLength(2);
        expect(first.revision).toBeDefined();
        const again = yield* list("library", first.revision);
        expect(again).toMatchObject({ unchanged: true, records: [], revision: first.revision });
        expect(again.scopes).toEqual(first.scopes);
        expect(again).not.toHaveProperty("organization");

        // A star rewrites the record; a new collection changes no record but the list's collections.
        yield* Effect.promise(() =>
          setLibraryReadingState(store, { sourceIds: [b.sourceId], starred: true }),
        );
        const starred = yield* list("library", first.revision);
        expect(starred).not.toHaveProperty("unchanged");
        expect(starred.records.find((row) => row.sourceId === b.sourceId)?.starred).toBe(true);
        yield* Effect.promise(() =>
          createScientSourceCollection({
            root: fixture.library,
            name: "Methods",
            sourceIds: [b.sourceId],
            actor: "user",
          }),
        );
        const filed = yield* list("library", starred.revision);
        expect(filed).not.toHaveProperty("unchanged");
        expect(filed.organization?.collections.map((collection) => collection.name)).toEqual([
          "Methods",
        ]);

        // The project's own key for a record changes its row, though no record file changes.
        const project = yield* list("project");
        expect(yield* list("project", project.revision)).toMatchObject({ unchanged: true });
        yield* Effect.promise(() =>
          renameScientProjectPinKey({
            projectRoot: fixture.root,
            citationKey: "vasopressinHere",
            to: "vasopressinNow",
          }),
        );
        const renamed = yield* list("project", project.revision);
        expect(renamed).not.toHaveProperty("unchanged");
        expect(renamed.records.find((row) => row.sourceId === a.sourceId)?.citationKey).toBe(
          "vasopressinNow",
        );
      }),
  );

  it.effect("sends list diagnostics only for the sources that have one", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const [complete, untitled] = yield* Effect.promise(() =>
        Promise.all([
          libraryRecord(fixture, "complete", {
            title: "A complete record",
            identifiers: [{ scheme: "doi", value: "10.1000/complete" }],
          }),
          libraryRecord(fixture, "untitled", {
            identifiers: [{ scheme: "doi", value: "10.1000/untitled" }],
          }),
        ]),
      );
      const store = yield* storeFor(fixture, "read");
      const overview = yield* Effect.promise(() =>
        libraryOverview(store, { scope: "library", background: false }),
      );
      expect(overview.records.map((record) => record.sourceId).toSorted()).toEqual(
        [complete.sourceId, untitled.sourceId].toSorted(),
      );
      expect(overview.recordDiagnostics).toEqual([
        { sourceId: untitled.sourceId, diagnostics: [expect.objectContaining({ field: "title" })] },
      ]);
    }),
  );

  it.effect("lists what the weekly check found for the sources still held, until Dismiss", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const [held, trashed] = yield* Effect.promise(() =>
        Promise.all([
          libraryRecord(fixture, "held", {
            title: "Still in the Library",
            identifiers: [{ scheme: "doi", value: "10.1000/held" }],
          }),
          libraryRecord(fixture, "trashed", {
            title: "Moved to the Trash since",
            identifiers: [{ scheme: "doi", value: "10.1000/trashed" }],
          }),
        ]),
      );
      const retraction = [{ kind: "retraction" as const, source: "retraction-watch" }];
      yield* Effect.promise(() =>
        recordScientLibraryNoticeCheck({
          library: fixture.library,
          found: {
            notices: new Map([
              ["doi:10.1000/held", retraction],
              ["doi:10.1000/trashed", retraction],
            ]),
            reinstated: new Set(),
          },
          etag: null,
          checkedAt: "2026-11-15T10:00:00.000Z",
        }),
      );
      yield* Effect.promise(() =>
        removeScientSource({
          root: fixture.library,
          sourceId: trashed.sourceId,
          expectedRevision: trashed.revision + 1,
        }),
      );
      const store = yield* storeFor(fixture, "write");
      // Asked from a project that cites neither: the line is about the whole Library.
      const overview = Effect.promise(() =>
        libraryOverview(store, { scope: "project", background: false }),
      );
      expect((yield* overview).noticeChanges).toEqual([
        { sourceId: held.sourceId, kind: "retraction", change: "added" },
      ]);
      expect(
        yield* Effect.promise(() =>
          organizeLibrarySources(store, { change: { action: "dismiss-notice-changes" } }),
        ),
      ).toEqual({ outcome: "dismissed" });
      expect(yield* overview).not.toHaveProperty("noticeChanges");
    }),
  );

  it.effect("lists recent changes: a bulk edit sent in two requests as one, then the removal", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { a, b, c } = yield* Effect.promise(() => threeSources(fixture));
      const store = yield* storeFor(fixture, "write");
      const tag = (sourceIds: ReadonlyArray<string>, partNumber: number) =>
        bulkUpdateLibrarySources(store, {
          change: { sourceIds: [...sourceIds], addTags: ["Screened"] },
          partOf: "edit_one",
          partNumber,
        });
      yield* Effect.promise(async () => {
        // The list is ordered by time: a clock set after the fixture moves a second per change.
        vi.useFakeTimers({ toFake: ["Date"] });
        let clock = Date.UTC(2100, 0, 1);
        const later = () => vi.setSystemTime((clock += 1000));
        later();
        await tag([a.sourceId], 1);
        later();
        await tag([b.sourceId], 2);
        later();
        const removed = await removeLibrarySource(store, {
          sourceId: a.sourceId,
          expectedRevision: a.revision + 1,
        });
        expect(removed.outcome).toBe("removed");

        const listed = await libraryRecentChanges(store, {});
        expect(listed.more).toBe(false);
        expect(listed.changes).toMatchObject([
          { kind: "trash", id: a.sourceId, by: "user" },
          {
            kind: "bulk-edit",
            by: "user",
            sourceCount: 2,
            tagsAdded: ["Screened"],
            parts: [{ sourceCount: 1 }, { sourceCount: 1 }],
            undone: false,
          },
          // The fixture's own removal, the oldest.
          { kind: "trash", id: c.sourceId, title: "Fluid balance" },
        ]);
        expect((await libraryRecentChanges(store, { limit: 1 })).more).toBe(true);
        vi.useRealTimers();
      });
    }),
  );

  it.effect("backs up the Library in the background and reports how it ended", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() => threeSources(fixture));
      const store = yield* storeFor(fixture, "write");
      const destination = NodePath.join(NodePath.dirname(fixture.root), "backups");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(destination);
        expect(libraryBackupStatus(store.library)).toEqual({ state: "none" });
        const backUp = (inFolder: string) =>
          organizeLibrarySources(store, { change: { action: "back-up-library", inFolder } });

        expect(await backUp(destination)).toEqual({ outcome: "backup-started" });
        // One at a time: a second request while it runs starts nothing.
        expect(await backUp(destination)).toEqual({ outcome: "backup-running" });
        const done = await vi.waitFor(() => {
          const status = libraryBackupStatus(store.library);
          if (status.state !== "done") throw new Error(`The backup is ${status.state}.`);
          return status;
        });
        expect(done).toMatchObject({ sources: 2, pdfs: 0 });
        expect(await NodeFSP.readdir(destination)).toEqual([NodePath.basename(done.path)]);
        expect(await checkScientLibraryBackup(done.path)).toMatchObject({ outcome: "complete" });

        // A folder that is not there ends the next one with the reason, and leaves nothing.
        expect(await backUp(NodePath.join(destination, "missing"))).toEqual({
          outcome: "backup-started",
        });
        await vi.waitFor(() =>
          expect(libraryBackupStatus(store.library)).toMatchObject({
            state: "failed",
            reason: "Choose a folder that exists and is not inside the Library.",
          }),
        );
        expect(await NodeFSP.readdir(destination)).toHaveLength(1);
      });
    }),
  );

  it.effect("copies a backup beside the Library and puts it in place at the next start", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() => threeSources(fixture));
      const store = yield* storeFor(fixture, "write");
      const destination = NodePath.join(NodePath.dirname(fixture.root), "backups");
      const libraryRoot = scientLibraryRootFor(fixture.stateDir);
      const backup = yield* Effect.promise(async () => {
        await NodeFSP.mkdir(destination);
        await organizeLibrarySources(store, {
          change: { action: "back-up-library", inFolder: destination },
        });
        const done = await vi.waitFor(() => {
          const status = libraryBackupStatus(store.library);
          if (status.state !== "done") throw new Error(`The backup is ${status.state}.`);
          return status;
        });
        // After the backup the Library changes: one more paper is removed.
        const [live] = await listScientSourceRecords(store.library);
        await removeScientSource({
          root: store.library,
          sourceId: live!.sourceId,
          expectedRevision: live!.revision,
        });
        expect(await listScientSourceRecords(store.library)).toHaveLength(1);
        return done.path;
      });

      yield* Effect.promise(async () => {
        // A folder that is no backup ends with the reason; nothing waits.
        startLibraryRestore(libraryRoot, destination);
        await vi.waitFor(async () =>
          expect(await libraryRestoreStatus(libraryRoot)).toMatchObject({
            state: "failed",
            reason: "This folder is not a finished Scient Library backup.",
          }),
        );

        startLibraryRestore(libraryRoot, backup);
        await vi.waitFor(async () =>
          expect(await libraryRestoreStatus(libraryRoot)).toMatchObject({
            state: "ready",
            sources: 2,
          }),
        );
        // Waiting changes nothing, and Cancel drops the copy.
        expect(await listScientSourceRecords(store.library)).toHaveLength(1);
        await cancelLibraryRestore(libraryRoot);
        expect(await libraryRestoreStatus(libraryRoot)).toEqual({ state: "none" });

        startLibraryRestore(libraryRoot, backup);
        await vi.waitFor(async () =>
          expect(await libraryRestoreStatus(libraryRoot)).toMatchObject({ state: "ready" }),
        );
        // Another folder is asked for and refused: the copy that was ready still waits, and
        // the answer says both.
        startLibraryRestore(libraryRoot, destination);
        await vi.waitFor(async () =>
          expect(await libraryRestoreStatus(libraryRoot)).toMatchObject({
            state: "ready",
            sources: 2,
            refused: { reason: "This folder is not a finished Scient Library backup." },
          }),
        );
      });

      // The next start of the server puts it in place, and keeps the Library that was there.
      yield* finishLibraryRestoreAtStart(fixture.stateDir).pipe(
        Effect.provideService(ScientSourcesBackend, "library"),
      );
      yield* Effect.promise(async () => {
        const status = await libraryRestoreStatus(libraryRoot);
        expect(status).toMatchObject({ state: "restored", sources: 2, kept: { sources: 1 } });
        expect(await listScientSourceRecords(store.library)).toHaveLength(2);
        if (status.state !== "restored" || !status.kept) throw new Error("Nothing was kept.");
        expect(await NodeFSP.readdir(NodePath.join(status.kept.path, "records"))).toHaveLength(1);
      });
    }),
  );

  it.effect("while a restore has not finished, writes nothing to the Library", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      yield* Effect.promise(() => threeSources(fixture));
      const libraryRoot = scientLibraryRootFor(fixture.stateDir);
      // As a start killed right after the swap leaves it: the Library records the restore
      // with no end time, and the intent still waits beside it.
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          NodePath.join(libraryRoot, "restores.json"),
          JSON.stringify({
            formatVersion: 1,
            restores: [
              { restoreId: "restore_1", backupId: "backup_1", backupCreatedAt: "x", at: "x" },
            ],
          }),
        );
        await NodeFSP.writeFile(
          `${libraryRoot}.restore.json`,
          JSON.stringify({ formatVersion: 1, restoreId: "restore_1" }),
        );
      });
      // Reading still works; a change is refused until Scient restarts.
      expect((yield* storeFor(fixture, "read")).kind).toBe("library");
      const refused = yield* storeFor(fixture, "write").pipe(Effect.exit);
      expect(String(refused)).toContain("did not finish. Restart Scient");
      yield* Effect.promise(() => NodeFSP.rm(`${libraryRoot}.restore.json`));
      expect((yield* storeFor(fixture, "write")).kind).toBe("library");
    }),
  );

  it.effect(
    "adds another Library's new sources in the background, lists the join, and undoes it",
    () =>
      Effect.gen(function* () {
        // Another Library with one paper this one lacks, and its backup.
        const theirs = yield* Effect.promise(setup);
        const theirStore = yield* storeFor(theirs, "write");
        const fixture = yield* Effect.promise(setup);
        yield* Effect.promise(() => threeSources(fixture));
        const store = yield* storeFor(fixture, "write");
        const destination = NodePath.join(NodePath.dirname(theirs.root), "backups");
        yield* Effect.promise(async () => {
          const fresh = await libraryRecord(theirs, "only-theirs", {
            title: "A paper only they have",
          });
          // A paper both Libraries have (the same DOI), with a note only in the other one.
          const doi = [{ scheme: "doi", value: "10.1000/shared" }];
          const mine = await libraryRecord(fixture, "shared", {
            title: "A paper both have",
            identifiers: doi,
          });
          const theirShared = await libraryRecord(theirs, "shared", {
            title: "A paper both have",
            identifiers: doi,
          });
          await updateScientSourceNote({
            root: theirs.library,
            sourceId: theirShared.sourceId,
            expectedRevision: theirShared.revision,
            expectedNote: null,
            note: "Written in the other Library.",
            actor: "user",
          });
          await NodeFSP.mkdir(destination);
          await organizeLibrarySources(theirStore, {
            change: { action: "back-up-library", inFolder: destination },
          });
          const backup = await vi.waitFor(() => {
            const status = libraryBackupStatus(theirStore.library);
            if (status.state !== "done") throw new Error(`The backup is ${status.state}.`);
            return status.path;
          });

          // A folder that is no backup ends with the reason and adds nothing.
          const add = (fromFolder: string) =>
            organizeLibrarySources(store, { change: { action: "add-from-library", fromFolder } });
          expect(await add(destination)).toEqual({ outcome: "join-started" });
          await vi.waitFor(() =>
            expect(libraryJoinStatus(store.library)).toMatchObject({
              state: "failed",
              reason: expect.stringContaining("Choose a Scient Library backup folder."),
            }),
          );

          expect(await add(backup)).toEqual({ outcome: "join-started" });
          const done = await vi.waitFor(() => {
            const status = libraryJoinStatus(store.library);
            if (status.state !== "done") throw new Error(`The join is ${status.state}.`);
            return status;
          });
          expect(done).toMatchObject({ added: 1, skipped: 0, different: 1 });

          // The paper both have is listed with both sides; its note is taken by one request.
          const differences = async () =>
            (await libraryRecentChanges(store, { differencesOfJoin: { joinId: done.joinId } }))
              .joinDifferences!;
          const [row] = (await differences()).rows;
          expect(row).toMatchObject({
            relation: "same-paper",
            parts: ["note"],
            here: { sourceId: mine.sourceId, note: "" },
            other: { note: "Written in the other Library." },
          });
          const take = () =>
            organizeLibrarySources(store, {
              change: {
                action: "take-from-library",
                joinId: done.joinId,
                otherSourceId: theirShared.sourceId,
                take: { kind: "note" },
                shown: {
                  here: row!.here!.fingerprint,
                  other: row!.other!.fingerprint,
                  relation: row!.relation,
                  candidates: [],
                },
                operationId: "take_route_1",
              },
            });
          // A session that may only read is not served either Library's personal note.
          const reader = (
            await libraryRecentChanges(store, {
              differencesOfJoin: { joinId: done.joinId },
              personal: false,
            })
          ).joinDifferences!;
          expect(JSON.stringify(reader)).not.toContain("Written in the other Library.");
          expect(reader.rows).toEqual([]);
          expect(await take()).toEqual({ outcome: "taken" });
          expect(await take()).toEqual({ outcome: "take-already" });
          expect((await readScientSourceRecord(store.library, mine.sourceId))?.note).toBe(
            "Written in the other Library.",
          );
          expect((await differences()).rows).toEqual([]);
          expect(await readScientSourceRecord(store.library, fresh.sourceId)).toMatchObject({
            title: "A paper only they have",
          });

          const listed = async () =>
            (await libraryRecentChanges(store, {})).changes.find(
              (change) => change.kind === "join",
            );
          expect(await listed()).toMatchObject({
            id: done.joinId,
            from: "backup",
            state: "done",
            added: 1,
          });
          expect(
            await organizeLibrarySources(store, {
              change: { action: "undo-join", joinId: done.joinId },
            }),
          ).toEqual({ outcome: "join-undone", joinUndone: { trashed: 1, left: 0 } });
          expect(await readScientSourceRecord(store.library, fresh.sourceId)).toBeNull();
          expect(await listed()).toMatchObject({ state: "undone", left: 0 });
          expect(
            await organizeLibrarySources(store, {
              change: { action: "undo-join", joinId: done.joinId },
            }),
          ).toEqual({ outcome: "already-undone" });
        });
      }),
  );

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

  it.effect("checks personal note bases independently of metadata revisions", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const record = yield* Effect.promise(() => libraryRecord(fixture, "checked-note", {}));
      const store = yield* storeFor(fixture, "write");
      yield* Effect.promise(() =>
        updateLibrarySourceMetadata(store, {
          sourceId: record.sourceId,
          expectedRevision: record.revision,
          metadata: { ...record, title: "Corrected title" },
        }),
      );
      const request = {
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        expectedNote: null,
        note: "  Personal observation  ",
      };
      const saved = yield* Effect.promise(() => updateLibraryPersonalNote(store, request));
      expect(saved).toMatchObject({
        outcome: "updated",
        record: { title: "Corrected title", personalNote: "  Personal observation  " },
      });
      expect(
        yield* Effect.promise(() =>
          updateLibraryPersonalNote(store, {
            ...request,
            expectedRevision: saved.record.revision,
            note: "Overwritten",
          }),
        ),
      ).toMatchObject({ outcome: "stale", record: { personalNote: "  Personal observation  " } });
    }),
  );

  it.effect(
    "shows values kept after a merge Undo beside the details', for a key now gone or a pin's snapshot",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const record = yield* Effect.promise(() =>
          libraryRecord(fixture, "kept", { title: "Vasopressin timing", abstract: null }),
        );
        const pinned = yield* Effect.promise(() => pin(fixture, record.sourceId));
        const writer = yield* storeFor(fixture, "write");
        yield* Effect.promise(() =>
          updateLibraryPersonalNote(writer, {
            sourceId: record.sourceId,
            expectedRevision: record.revision,
            expectedNote: null,
            note: "Private reading note",
          }),
        );
        // Each shows only fields its holder keeps (a key has no abstract, a review no pages),
        // whatever the file names.
        const copy = (heldBy: string) => ({
          sourceId: record.sourceId,
          heldBy,
          undoneAt: "2026-11-01T00:00:00.000Z",
          differs: ["abstract", "pages", "note"],
          work: { abstract: "Imported by the review", pages: "1-9", note: null },
        });
        yield* Effect.promise(async () => {
          await keepScientDisplacedCopies(fixture.root, { kind: "project" }, [
            copy(pinned.citationKey),
            copy("RemovedKey2020"),
          ]);
          await keepScientDisplacedCopies(
            fixture.root,
            { kind: "review", reviewId: "review_gone" },
            [copy("review_gone")],
          );
        });
        const store = yield* storeFor(fixture, "read");
        const detail = encodeDetail(
          yield* Effect.promise(() => librarySourceDetail(store, { sourceId: record.sourceId })),
        );
        expect(JSON.stringify(detail)).not.toContain("Private reading note");
        const pages = { field: "pages", earlier: "1-9", current: null };
        expect(detail.keptCopies).toEqual([
          {
            holder: "citation-key",
            heldBy: pinned.citationKey,
            holderPresent: true,
            undoneAt: "2026-11-01T00:00:00.000Z",
            fields: [pages],
          },
          {
            holder: "citation-key",
            heldBy: "RemovedKey2020",
            holderPresent: false,
            undoneAt: "2026-11-01T00:00:00.000Z",
            fields: [pages],
          },
          {
            holder: "review",
            heldBy: "review_gone",
            holderPresent: false,
            undoneAt: "2026-11-01T00:00:00.000Z",
            fields: [{ field: "abstract", earlier: "Imported by the review", current: null }],
          },
        ]);

        // A source in Trash is shown from its pin's snapshot, and compared with what that shows.
        const removed = yield* Effect.promise(async () => {
          const trashed = await libraryRecord(fixture, "trashed", { title: "Fluid balance" });
          const trashedPin = await pin(fixture, trashed.sourceId);
          await removeScientSource({
            root: fixture.library,
            sourceId: trashed.sourceId,
            expectedRevision: trashed.revision,
          });
          await keepScientDisplacedCopies(fixture.root, { kind: "project" }, [
            {
              sourceId: trashed.sourceId,
              heldBy: trashedPin.citationKey,
              undoneAt: "2026-11-02T00:00:00.000Z",
              differs: ["containerTitle"],
              work: { title: "Fluid balance", containerTitle: "Journal before the merge" },
            },
          ]);
          return { sourceId: trashed.sourceId, citationKey: trashedPin.citationKey };
        });
        const fromSnapshot = encodeDetail(
          yield* Effect.promise(() => librarySourceDetail(store, { sourceId: removed.sourceId })),
        );
        expect(fromSnapshot).toMatchObject({
          fromSnapshot: true,
          keptCopies: [
            {
              heldBy: removed.citationKey,
              holderPresent: true,
              fields: [
                {
                  field: "containerTitle",
                  earlier: "Journal before the merge",
                  current: "Scient Journal",
                },
              ],
            },
          ],
        });
      }),
  );

  it.effect(
    "shows kept values for a trashed pin whose alias points to another Library record",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const chained = yield* Effect.promise(async () => {
          const a = await libraryRecord(fixture, "chain-a", {
            title: "Sepsis bundle",
            containerTitle: "Journal A",
          });
          const d = await libraryRecord(fixture, "chain-d", {
            title: "Sepsis bundle sibling",
            containerTitle: "Journal D",
          });
          const b = await libraryRecord(fixture, "chain-b", {
            title: "Sepsis bundle",
            containerTitle: "Journal B",
          });
          const c = await libraryRecord(fixture, "chain-c", {
            title: "Sepsis bundle",
            containerTitle: "Journal C",
          });
          const pinA = await pin(fixture, a.sourceId);
          const pinD = await pin(fixture, d.sourceId);
          // Merge A -> B and sibling D -> B, then B -> C, and refresh so both snapshots carry C's details.
          const firstMerge = await mergeScientLibrarySources({
            library: fixture.library,
            sourceIds: [a.sourceId, b.sourceId],
            survivorId: b.sourceId,
            actor: "user",
          });
          if (firstMerge.outcome !== "merged") throw new Error("Expected A -> B merge.");
          const siblingMerge = await mergeScientLibrarySources({
            library: fixture.library,
            sourceIds: [d.sourceId, b.sourceId],
            survivorId: b.sourceId,
            actor: "user",
          });
          if (siblingMerge.outcome !== "merged") throw new Error("Expected D -> B merge.");
          const secondMerge = await mergeScientLibrarySources({
            library: fixture.library,
            sourceIds: [b.sourceId, c.sourceId],
            survivorId: c.sourceId,
            actor: "user",
          });
          if (secondMerge.outcome !== "merged") throw new Error("Expected B -> C merge.");
          await refreshScientProjectPinSnapshots({
            projectRoot: fixture.root,
            library: fixture.library,
          });
          // Undo B -> C and refresh: displaced values for both pins are saved under B, not A or D.
          const undone = await undoScientLibraryMerge({
            library: fixture.library,
            mergeId: secondMerge.merge.mergeId,
            actor: "user",
          });
          if (undone.outcome !== "undone") throw new Error("Expected B -> C undo.");
          await refreshScientProjectPinSnapshots({
            projectRoot: fixture.root,
            library: fixture.library,
          });
          await removeScientSource({
            root: fixture.library,
            sourceId: undone.loser.sourceId,
            expectedRevision: undone.loser.revision,
          });
          return {
            pinSourceId: a.sourceId,
            citationKey: pinA.citationKey,
            siblingCitationKey: pinD.citationKey,
          };
        });

        const store = yield* storeFor(fixture, "read");
        const detail = encodeDetail(
          yield* Effect.promise(() =>
            librarySourceDetail(store, { sourceId: chained.pinSourceId }),
          ),
        );
        expect(detail).toMatchObject({
          fromSnapshot: true,
          keptCopies: expect.arrayContaining([
            expect.objectContaining({
              holder: "citation-key",
              heldBy: chained.citationKey,
              holderPresent: true,
              fields: expect.arrayContaining([
                { field: "containerTitle", earlier: "Journal C", current: "Journal B" },
              ]),
            }),
            expect.objectContaining({
              holder: "citation-key",
              heldBy: chained.siblingCitationKey,
              holderPresent: true,
              fields: expect.arrayContaining([
                { field: "containerTitle", earlier: "Journal C", current: "Journal B" },
              ]),
            }),
          ]),
        });
        expect((detail as { keptCopies?: unknown[] }).keptCopies).toHaveLength(2);
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

  it.effect("reads and restores each merged key's project note through the panel", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(setup);
      const { first, second, firstKey, secondKey } = yield* Effect.promise(async () => {
        const one = await libraryRecord(fixture, "pair1", { title: "Shock trial" });
        const two = await libraryRecord(fixture, "pair2", { title: "Shock trial" });
        const keys: string[] = [];
        for (const [record, why] of [
          [one, "Why the first copy"],
          [two, "Why the second copy"],
        ] as const) {
          const citationKey = (await pin(fixture, record.sourceId)).citationKey;
          keys.push(citationKey);
          for (const [note, base] of [
            [why, null],
            ["Same text", why],
          ] as const) {
            await setScientProjectPinNote({
              projectRoot: fixture.root,
              citationKey,
              note,
              base,
              actor: "user",
            });
          }
        }
        return { first: one, second: two, firstKey: keys[0]!, secondKey: keys[1]! };
      });
      const store = yield* storeFor(fixture, "write");
      yield* Effect.promise(async () => {
        await organizeLibrarySources(store, {
          change: {
            action: "merge",
            sourceIds: [first.sourceId, second.sourceId],
            survivorId: second.sourceId,
          },
        });
        const notes = (detail: Awaited<ReturnType<typeof librarySourceDetail>>) =>
          "projectNoteHistory" in detail
            ? detail.projectNoteHistory?.map((version) => version.note)
            : undefined;
        const primary = await librarySourceDetail(store, { sourceId: second.sourceId });
        expect(primary).toMatchObject({ citationKey: firstKey, alsoCitedAs: [secondKey] });
        expect(notes(primary)).toEqual(["Why the first copy", "Same text"]);
        const other = await librarySourceDetail(store, {
          sourceId: second.sourceId,
          citationKey: secondKey,
        });
        expect(other).toMatchObject({ citationKey: firstKey, projectNote: "Same text" });
        expect(notes(other)).toEqual(["Why the second copy", "Same text"]);

        // Restoring the version read under the second key changes only that pin's note.
        const restored = await updateLibraryProjectNote(store, {
          sourceId: second.sourceId,
          citationKey: secondKey,
          note: "Why the second copy",
          expectedNote: "Same text",
          noteSession: "restore",
        });
        expect(restored).toMatchObject({
          outcome: "updated",
          record: { projectNote: "Why the second copy" },
        });
        expect(
          (await readScientProjectPins(fixture.root)).map((pin) => [pin.citationKey, pin.note]),
        ).toEqual(
          expect.arrayContaining([
            [firstKey, "Same text"],
            [secondKey, "Why the second copy"],
          ]),
        );
        await expect(
          librarySourceDetail(store, { sourceId: second.sourceId, citationKey: "nobody2026" }),
        ).rejects.toThrow("does not cite this source");
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

        const removed = await removeLibrarySource(store, {
          sourceId: edited.sourceId,
          expectedRevision: edited.revision + 2,
        });
        expect(removed.outcome).toBe("removed");
        await makeStale();
        const restored = await restoreLibrarySource(store, { sourceId: edited.sourceId });
        expect(restored.outcome).toBe("restored");
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

  it.effect(
    "offers repair of a review record no pin names, in its detail and by Keep separate",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(setup);
        const doi = [{ scheme: "doi", value: "10.1000/screened" }];
        const { screened, reviewId, near } = yield* Effect.promise(async () => {
          // The review was built on another computer; this Library holds a near-match by mistake.
          const theirs = scientLibraryLocation(
            scientLibraryRootFor(NodePath.join(fixture.base, "theirs")),
          );
          await ensureScientLibrary(theirs.root);
          const screened = (
            await importScientSource({
              root: theirs,
              operationId: NodeCrypto.randomUUID(),
              candidate: {
                sourceKey: "screened",
                type: "article",
                customType: null,
                title: "Early therapy in sepsis",
                creators: [ada],
                issuedRaw: "2026",
                issuedYear: 2026,
                identifiers: doi,
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
            })
          ).record!;
          const { reviewId } = await changeScientLibraryReview({
            projectRoot: fixture.root,
            library: theirs,
            change: { action: "create-review", title: "Sepsis" },
            actor: "user",
          });
          await changeScientLibraryReview({
            projectRoot: fixture.root,
            library: theirs,
            change: { action: "add-sources", reviewId: reviewId!, sourceIds: [screened.sourceId] },
            actor: "user",
          });
          const near = await libraryRecord(fixture, "near", {
            title: "Soil carbon under drought",
            identifiers: doi,
          });
          return { screened, reviewId: reviewId!, near };
        });
        const store = yield* storeFor(fixture, "write");
        yield* Effect.promise(async () => {
          const detail = () =>
            librarySourceDetail(store, { sourceId: screened.sourceId, reviewId });
          expect(await detail()).toMatchObject({
            label: "From this review's snapshot",
            libraryMatch: {
              reason: "contradicted",
              keptSeparate: false,
              candidates: [{ sourceId: near.sourceId, problem: "titles-differ" }],
            },
          });
          expect(
            await organizeLibrarySources(store, {
              change: { action: "keep-pin-separate", sourceId: screened.sourceId },
            }),
          ).toMatchObject({ outcome: "kept-separate" });
          expect(await detail()).toMatchObject({ libraryMatch: { keptSeparate: true } });
          expect(await readScientProjectPins(fixture.root)).toEqual([]);
        });
      }),
  );

  it("counts both distinct actions as Library-only, which a project server refuses", () => {
    const sourceIds = ["source_a", "source_b"] as const;
    expect(isLibraryOrganizeAction({ action: "mark-distinct", sourceIds })).toBe(true);
    expect(isLibraryOrganizeAction({ action: "clear-distinct", sourceIds })).toBe(true);
  });
});
