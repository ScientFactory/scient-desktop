// @effect-diagnostics nodeBuiltinImport:off -- This test verifies the Node filesystem adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { editableMetadataFromRecord } from "./editable.ts";
import { editorialStatusFromNotices } from "./editorialStatus.ts";
import * as Lock from "./libraryLock.ts";
import {
  dismissScientLibraryNoticeChanges,
  listScientLibraryNoticeChanges,
  readScientLibraryNoticeWatch,
  recordScientLibraryNoticeCheck,
  retractionWatchReader,
  withScientLibraryWatchNotices,
} from "./libraryNoticeWatch.ts";
import { ensureScientLibrary, scientLibraryLocation } from "./libraryRoot.ts";
import type {
  ScientSourceCandidate,
  ScientSourceEditorialNotice,
  ScientSourceIdentifier,
  ScientSourceRecord,
} from "./model.ts";
import * as Store from "./store.ts";
import {
  importScientSource,
  listScientSourceRevisions,
  readScientSourceRecord,
  recordScientSourceCheck,
  updateScientSourceMetadata,
} from "./store.ts";
import { sourceCandidate } from "./testing/sourceFixtures.ts";

// Six rows of https://gitlab.com/crossref/retraction-watch-data as published on 2026-11-13.
const slice = await NodeFSP.readFile(
  new URL("./testing/retractionWatchSlice.csv", import.meta.url),
  "utf8",
);
const RETRACTED = { scheme: "doi", value: "10.1002/jcb.21852" };
const RETRACTED_KEY = "doi:10.1002/jcb.21852";
const REINSTATED = { scheme: "doi", value: "10.1016/j.heliyon.2023.e18637" };
const WATCH_RETRACTION: ScientSourceEditorialNotice = {
  kind: "retraction",
  doi: "10.1002/jcb.25020",
  date: "2015-01-29",
  source: "retraction-watch",
};

function fileNotices(wanted: ReadonlyArray<string>, text = slice) {
  const reader = retractionWatchReader(new Set(wanted));
  // In two parts, split inside a row, as a download arrives.
  reader.push(text.slice(0, 1000));
  reader.push(text.slice(1000));
  return reader.end();
}

vi.mock("./store.ts", { spy: true });
vi.mock("./libraryLock.ts", { spy: true });
const actual = {
  ...(await vi.importActual<typeof Store>("./store.ts")),
  ...(await vi.importActual<typeof Lock>("./libraryLock.ts")),
};

const fixtures: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-notice-watch-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "scient", "library");
  await ensureScientLibrary(root);
  const library = scientLibraryLocation(root);
  const add = async (
    title: string,
    identifiers: ReadonlyArray<ScientSourceIdentifier>,
    notices?: ReadonlyArray<ScientSourceEditorialNotice>,
  ) => {
    const candidate: ScientSourceCandidate = sourceCandidate({
      sourceKey: title,
      title,
      issuedRaw: "2008",
      issuedYear: 2008,
      identifiers,
    });
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate,
      ...(notices
        ? {
            editorialStatus: {
              state: notices.some((notice) => notice.kind === "retraction") ? "retracted" : "none",
              notices,
              checkedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : {}),
    });
    if (!imported.record) throw new Error("Expected an imported record.");
    return imported.record.sourceId;
  };
  const check = (wanted: ReadonlyArray<string>, checkedAt: string) =>
    recordScientLibraryNoticeCheck({
      library,
      found: fileNotices(wanted),
      etag: null,
      checkedAt,
    });
  const record = async (sourceId: string) => {
    const found = await readScientSourceRecord(library, sourceId);
    if (!found) throw new Error("Expected the source.");
    return found;
  };
  return { library, add, check, record };
}

describe("reading the Retraction Watch file", () => {
  it("keeps the notices of the papers asked for, by DOI or PMID", () => {
    const found = fileNotices([
      RETRACTED_KEY,
      "pmid:26221215",
      "doi:10.21275/mr241114172224",
      "doi:10.1016/j.heliyon.2023.e18637",
      "doi:10.1000/not-in-the-file",
    ]);
    expect(found.reinstated).toEqual(new Set(["doi:10.1016/j.heliyon.2023.e18637"]));
    expect(Object.fromEntries(found.notices)).toEqual({
      [RETRACTED_KEY]: [WATCH_RETRACTION],
      "pmid:26221215": [
        {
          kind: "retraction",
          doi: "10.62347/riur2504",
          date: "2025-03-01",
          source: "retraction-watch",
        },
      ],
      // The file gives this notice no DOI.
      "doi:10.21275/mr241114172224": [
        { kind: "retraction", date: "2026-07-09", source: "retraction-watch" },
      ],
      // Reinstated: its only row is the reinstatement.
      "doi:10.1016/j.heliyon.2023.e18637": [],
      "doi:10.1000/not-in-the-file": [],
    });
  });

  it.each([
    // Cut after the columns that are read: only the row's width shows it is not whole.
    ["a download cut near the end of a row", slice.slice(0, -4)],
    ["a download cut inside a quoted field", slice.slice(0, slice.lastIndexOf('"') - 20)],
    ["a file with other columns", slice.replace("OriginalPaperDOI", "PaperDOI")],
    ["an empty answer", ""],
  ])("refuses %s", (_name, text) => {
    expect(() => fileNotices([RETRACTED_KEY], text)).toThrow();
  });
});

describe("the weekly notice check", () => {
  it("puts a new retraction on the source as a revision and lists it once", async () => {
    const { library, add, check, record } = await setup();
    const sourceId = await add("Retracted after it was added", [RETRACTED], []);

    expect(await check([RETRACTED_KEY], "2026-11-15T10:00:00.000Z")).toEqual({ changedSources: 1 });
    expect(await record(sourceId)).toMatchObject({
      revision: 2,
      editorialStatus: {
        state: "retracted",
        notices: [WATCH_RETRACTION],
        checkedAt: "2026-11-15T10:00:00.000Z",
      },
    });
    expect((await listScientSourceRevisions(library, sourceId))?.[0]).toMatchObject({
      revision: 2,
      changes: ["editorialStatus"],
    });
    const listed = [{ sourceId, kind: "retraction", change: "added" }];
    expect(await listScientLibraryNoticeChanges(library)).toEqual(listed);

    // The next week the file says the same: nothing is written and nothing is listed twice.
    expect(await check([RETRACTED_KEY], "2026-11-22T10:00:00.000Z")).toEqual({ changedSources: 0 });
    expect((await record(sourceId)).revision).toBe(2);
    expect(await listScientLibraryNoticeChanges(library)).toEqual(listed);
  });

  it("leaves a source alone that already says so, has no DOI or PMID, or is not in the file", async () => {
    const { library, add, check, record } = await setup();
    const publishers: ScientSourceEditorialNotice = {
      kind: "retraction",
      doi: "10.1002/jcb.21852",
      date: "2015-02-03",
      source: "publisher",
    };
    const known = await add("The publisher said it first", [RETRACTED], [publishers]);
    const book = await add("A book", [{ scheme: "isbn", value: "9780306406157" }]);
    const fine = await add("Never checked", [{ scheme: "doi", value: "10.1000/fine" }]);
    // Its row is no longer in the file, and the file does not say it was reinstated.
    const gone = await add(
      "Retracted, row gone",
      [{ scheme: "doi", value: "10.1000/gone" }],
      [WATCH_RETRACTION],
    );

    expect(
      await check(
        [RETRACTED_KEY, "doi:10.1000/fine", "doi:10.1000/gone"],
        "2026-11-15T10:00:00.000Z",
      ),
    ).toEqual({ changedSources: 0 });
    expect((await record(known)).editorialStatus?.notices).toEqual([publishers]);
    expect((await record(gone)).editorialStatus?.notices).toEqual([WATCH_RETRACTION]);
    expect(await record(book)).not.toHaveProperty("editorialStatus");
    expect(await record(fine)).not.toHaveProperty("editorialStatus");
    expect(await listScientLibraryNoticeChanges(library)).toEqual([]);
  });

  it("takes off Retraction Watch's retraction of a reinstated paper, keeps the publisher's notices, and says so", async () => {
    const { library, add, check, record } = await setup();
    const correction: ScientSourceEditorialNotice = {
      kind: "correction",
      doi: "10.1016/j.heliyon.2024.e00001",
      source: "publisher",
    };
    const sourceId = await add(
      "Reinstated",
      [REINSTATED],
      [{ kind: "retraction", date: "2024-06-01", source: "retraction-watch" }, correction],
    );

    await check(["doi:10.1016/j.heliyon.2023.e18637"], "2026-11-15T10:00:00.000Z");
    expect((await record(sourceId)).editorialStatus).toMatchObject({
      state: "corrected",
      notices: [correction],
    });
    expect(await listScientLibraryNoticeChanges(library)).toEqual([
      { sourceId, kind: "retraction", change: "withdrawn" },
    ]);
  });

  it("reads the whole file at the next check when a source did not take its notice", async () => {
    const { library, add, check, record } = await setup();
    const sourceId = await add("Edited while the file was read", [RETRACTED], []);
    // Someone edits the source between the check's read of it and its write.
    vi.spyOn(Store, "recordScientSourceCheck").mockImplementationOnce(async () => ({
      outcome: "stale",
      record: await record(sourceId),
    }));

    expect(await check([RETRACTED_KEY], "2026-11-15T10:00:00.000Z")).toEqual({ changedSources: 0 });
    expect(await readScientLibraryNoticeWatch(library)).not.toHaveProperty("covered");
    expect(await check([RETRACTED_KEY], "2026-11-22T10:00:00.000Z")).toEqual({ changedSources: 1 });
    expect(await readScientLibraryNoticeWatch(library)).toHaveProperty("covered");
  });

  it("puts a notice on a source together with who keeps it, so a registry check meanwhile keeps it", async () => {
    const { library, add, check, record } = await setup();
    const sourceId = await add("Retracted after it was added", [RETRACTED], []);
    const written = Promise.withResolvers<void>();
    const refreshing = Promise.withResolvers<void>();
    let refreshStarted = false;
    vi.spyOn(Lock, "withScientLibraryLock").mockImplementation((root, run, options) => {
      if (refreshStarted) refreshing.resolve();
      return actual.withScientLibraryLock(root, run, options);
    });
    // The check waits once its notice is on the source, until the refresh reads or waits.
    vi.spyOn(Store, "recordScientSourceCheck").mockImplementationOnce(async (input) => {
      const result = await actual.recordScientSourceCheck(input);
      written.resolve();
      await refreshing.promise;
      return result;
    });

    const checked = check([RETRACTED_KEY], "2026-11-15T10:00:00.000Z");
    await written.promise;
    refreshStarted = true;
    const seen = await record(sourceId);
    // A registry that reports no notice for the paper.
    const refreshed = withScientLibraryWatchNotices(library, seen, async (kept) => {
      refreshing.resolve();
      return recordScientSourceCheck({
        root: library,
        sourceId,
        expectedRevision: seen.revision,
        editorialStatus: editorialStatusFromNotices(kept, "2026-11-16T10:00:00.000Z"),
      });
    });
    await Promise.all([checked, refreshed]);

    expect((await record(sourceId)).editorialStatus?.state).toBe("retracted");
  });

  it("does not read a paper it never asked about as withdrawn", async () => {
    const { add, check, record } = await setup();
    // Added while the file was being read: its identifier was not among those asked for.
    const sourceId = await add("Added during the download", [RETRACTED], [WATCH_RETRACTION]);

    expect(await check([], "2026-11-15T10:00:00.000Z")).toEqual({ changedSources: 0 });
    expect((await record(sourceId)).editorialStatus?.state).toBe("retracted");
  });

  it("drops watch ownership once a source's identifier is corrected to another paper", async () => {
    const { library, add, check, record } = await setup();
    const sourceId = await add("Misidentified paper", [RETRACTED], []);
    await check([RETRACTED_KEY], "2026-11-15T10:00:00.000Z");
    const flagged = await record(sourceId);
    expect(flagged.editorialStatus?.state).toBe("retracted");

    // Correcting the DOI clears editorialStatus; a later registry check must not reattach the old retraction.
    const edited = await updateScientSourceMetadata({
      root: library,
      sourceId,
      expectedRevision: flagged.revision,
      metadata: {
        ...editableMetadataFromRecord(flagged),
        identifiers: [{ scheme: "doi", value: "10.1000/clean-paper" }],
      },
      actor: "user",
    });
    expect(edited.record.editorialStatus).toBeUndefined();

    let keptByWatch: ReadonlyArray<ScientSourceEditorialNotice> = [];
    await withScientLibraryWatchNotices(library, edited.record, async (kept) => {
      keptByWatch = kept;
    });
    expect(keptByWatch).toEqual([]);

    // The next full read clears stale ownership for the old identifier too.
    await check(["doi:10.1000/clean-paper"], "2026-11-22T10:00:00.000Z");
    expect((await readScientLibraryNoticeWatch(library))?.changes).toEqual([]);
  });

  it("drops only the notice tied to a removed identifier when another identifier on the source still matches the same kind", async () => {
    const { library, add, record } = await setup();
    const badDoi = { scheme: "doi", value: "10.1000/wrong-doi" } as const;
    const keptPmid = { scheme: "pmid", value: "99887766" } as const;
    const sourceId = await add("Paper with two identifiers", [badDoi, keptPmid], []);

    const doiNotice: ScientSourceEditorialNotice = {
      kind: "retraction",
      date: "2020-01-01",
      doi: "10.1000/retraction-doi-row",
      source: "retraction-watch",
    };
    const pmidNotice: ScientSourceEditorialNotice = {
      kind: "retraction",
      date: "2021-02-02",
      doi: "10.1000/retraction-pmid-row",
      source: "retraction-watch",
    };
    await recordScientLibraryNoticeCheck({
      library,
      etag: '"both"',
      checkedAt: "2026-11-15T10:00:00.000Z",
      found: {
        notices: new Map([
          ["doi:10.1000/wrong-doi", [doiNotice]],
          ["pmid:99887766", [pmidNotice]],
        ]),
        reinstated: new Set(),
      },
    });
    const flagged = await record(sourceId);
    expect(flagged.editorialStatus?.notices.map((n) => n.doi)).toEqual([
      "10.1000/retraction-pmid-row",
      "10.1000/retraction-doi-row",
    ]);

    // Correct the DOI while keeping the PMID.
    const edited = await updateScientSourceMetadata({
      root: library,
      sourceId,
      expectedRevision: flagged.revision,
      metadata: {
        ...editableMetadataFromRecord(flagged),
        identifiers: [{ scheme: "doi", value: "10.1000/clean-doi" }, keptPmid],
      },
      actor: "user",
    });

    // Even if the record still held both old watch notices, reuse reconciles down to the PMID match only.
    const withStaleHeld: ScientSourceRecord = {
      ...edited.record,
      editorialStatus: flagged.editorialStatus!,
    };
    let keptAfterEdit: ReadonlyArray<ScientSourceEditorialNotice> = [];
    await withScientLibraryWatchNotices(library, edited.record, async (kept) => {
      keptAfterEdit = kept;
    });
    expect(keptAfterEdit.map((n) => n.doi)).toEqual(["10.1000/retraction-pmid-row"]);

    let keptFromStaleHeld: ReadonlyArray<ScientSourceEditorialNotice> = [];
    await withScientLibraryWatchNotices(library, withStaleHeld, async (kept) => {
      keptFromStaleHeld = kept;
    });
    expect(keptFromStaleHeld.map((n) => n.doi)).toEqual(["10.1000/retraction-pmid-row"]);

    // Re-attach the stale combined notices (as merge Undo preserves editorialStatus when dropping a DOI)
    // so the next full pass must actively prune the stale DOI retraction from the record.
    const restoredStale = await Store.recordScientSourceCheck({
      root: library,
      sourceId,
      expectedRevision: edited.record.revision,
      editorialStatus: flagged.editorialStatus!,
      actor: "user",
    });
    expect(restoredStale.outcome).toBe("updated");
    expect((await record(sourceId)).editorialStatus?.notices.map((n) => n.doi)).toEqual([
      "10.1000/retraction-pmid-row",
      "10.1000/retraction-doi-row",
    ]);

    // Next full pass reconciles both the record and stored matched notices to the surviving PMID row only.
    await recordScientLibraryNoticeCheck({
      library,
      etag: '"after-correction"',
      checkedAt: "2026-11-22T10:00:00.000Z",
      found: {
        notices: new Map([
          ["doi:10.1000/clean-doi", []],
          ["pmid:99887766", [pmidNotice]],
        ]),
        reinstated: new Set(),
      },
    });
    expect((await record(sourceId)).editorialStatus?.notices.map((n) => n.doi)).toEqual([
      "10.1000/retraction-pmid-row",
    ]);
    expect((await readScientLibraryNoticeWatch(library))?.changes).toEqual([
      expect.objectContaining({
        sourceId,
        kind: "retraction",
        change: "added",
        matched: [{ notice: pmidNotice, identifiers: ["pmid:99887766"] }],
      }),
    ]);
  });

  it("keeps prior per-notice ownership when a later full feed omits one of two still-owned retractions", async () => {
    const { library, add, record } = await setup();
    const doi = { scheme: "doi", value: "10.1000/still-retracted-doi" } as const;
    const pmid = { scheme: "pmid", value: "55443322" } as const;
    const sourceId = await add("Paper with two retractions", [doi, pmid], []);

    const doiNotice: ScientSourceEditorialNotice = {
      kind: "retraction",
      date: "2020-01-01",
      doi: "10.1000/retraction-one",
      source: "retraction-watch",
    };
    const pmidNotice: ScientSourceEditorialNotice = {
      kind: "retraction",
      date: "2021-02-02",
      doi: "10.1000/retraction-two",
      source: "retraction-watch",
    };
    await recordScientLibraryNoticeCheck({
      library,
      etag: '"both-present"',
      checkedAt: "2026-11-15T10:00:00.000Z",
      found: {
        notices: new Map([
          ["doi:10.1000/still-retracted-doi", [doiNotice]],
          ["pmid:55443322", [pmidNotice]],
        ]),
        reinstated: new Set(),
      },
    });

    // Next full pass omits the DOI row without any reinstatement while both identifiers stay on the source.
    await recordScientLibraryNoticeCheck({
      library,
      etag: '"partial-feed"',
      checkedAt: "2026-11-22T10:00:00.000Z",
      found: {
        notices: new Map([
          ["doi:10.1000/still-retracted-doi", []],
          ["pmid:55443322", [pmidNotice]],
        ]),
        reinstated: new Set(),
      },
    });

    const current = await record(sourceId);
    let keptOnRefresh: ReadonlyArray<ScientSourceEditorialNotice> = [];
    await withScientLibraryWatchNotices(library, current, async (kept) => {
      keptOnRefresh = kept;
    });
    expect(keptOnRefresh.map((n) => n.doi).toSorted()).toEqual([
      "10.1000/retraction-one",
      "10.1000/retraction-two",
    ]);
  });

  it("preserves legacy v2 confirmed watch ownership on registry refresh before v3 backfill runs", async () => {
    const { library, add, record } = await setup();
    const doi = { scheme: "doi", value: "10.1000/v2-confirmed" } as const;
    const sourceId = await add(
      "Legacy v2 paper",
      [doi],
      [{ kind: "retraction", date: "2018-05-01", source: "publisher" }],
    );
    const rwNotice: ScientSourceEditorialNotice = {
      kind: "retraction",
      date: "2018-05-01",
      doi: "10.1000/v2-retraction",
      source: "retraction-watch",
    };
    await NodeFSP.writeFile(
      NodePath.join(library.root, "notice-watch.json"),
      JSON.stringify({
        formatVersion: 1,
        checkedAt: "2026-11-20T10:00:00.000Z",
        etag: '"v2"',
        changes: [
          {
            sourceId,
            kind: "retraction",
            change: "added",
            at: "2026-11-20T10:00:00.000Z",
            dismissed: true,
            notices: [rwNotice],
            identifiers: ["doi:10.1000/v2-confirmed"],
          },
        ],
      }),
    );

    // Registry refresh before any v3 full pass still keeps the confirmed Retraction Watch notice.
    const current = await record(sourceId);
    let keptBeforeBackfill: ReadonlyArray<ScientSourceEditorialNotice> = [];
    await withScientLibraryWatchNotices(library, current, async (kept) => {
      keptBeforeBackfill = kept;
    });
    expect(keptBeforeBackfill).toEqual([rwNotice]);

    // If the DOI was corrected before backfill, the v2 notice is not reattached.
    const corrected: ScientSourceRecord = {
      ...current,
      identifiers: [{ scheme: "doi", value: "10.1000/v2-clean" }],
    };
    let keptAfterCorrection: ReadonlyArray<ScientSourceEditorialNotice> = [];
    await withScientLibraryWatchNotices(library, corrected, async (kept) => {
      keptAfterCorrection = kept;
    });
    expect(keptAfterCorrection).toEqual([]);

    // Once v3 backfill runs, legacy notices/identifiers keys are replaced with matched.
    await recordScientLibraryNoticeCheck({
      library,
      etag: '"v3"',
      checkedAt: "2026-11-27T10:00:00.000Z",
      found: {
        notices: new Map([["doi:10.1000/v2-confirmed", [rwNotice]]]),
        reinstated: new Set(),
      },
    });
    const upgraded = (await readScientLibraryNoticeWatch(library))?.changes[0];
    expect(upgraded?.matched).toEqual([
      { notice: rwNotice, identifiers: ["doi:10.1000/v2-confirmed"] },
    ]);
    expect(upgraded?.notices).toBeUndefined();
    expect(upgraded?.identifiers).toBeUndefined();
    expect(upgraded?.dismissed).toBe(true);
  });

  it("re-reads a source under the lock when a registry check clears a publisher retraction before the lock", async () => {
    const { library, add, check, record } = await setup();
    const sourceId = await add(
      "Publisher retraction cleared mid-check",
      [RETRACTED],
      [{ kind: "retraction", date: "2015-02-03", source: "publisher" }],
    );
    const initial = await record(sourceId);
    const locked = Promise.withResolvers<void>();
    const weeklyWaitingForLock = Promise.withResolvers<void>();
    const lockSpy = vi.mocked(Lock.withScientLibraryLock);
    const callsBefore = lockSpy.mock.calls.length;
    lockSpy.mockImplementation(((root: string, fn: () => Promise<unknown>) => {
      if (lockSpy.mock.calls.length > callsBefore + 1) {
        weeklyWaitingForLock.resolve();
      }
      return actual.withScientLibraryLock(root, fn);
    }) as typeof Lock.withScientLibraryLock);

    const holder = Lock.withScientLibraryLock(library.root, async () => {
      locked.resolve();
      // Wait until the weekly check has actually reached lock acquisition before clearing the notice.
      await weeklyWaitingForLock.promise;
      await actual.recordScientSourceCheck({
        root: library,
        sourceId,
        expectedRevision: initial.revision,
        editorialStatus: { state: "none", notices: [], checkedAt: "2026-11-15T09:59:00.000Z" },
      });
    });
    await locked.promise;

    const checked = check([RETRACTED_KEY], "2026-11-15T10:00:00.000Z");
    await Promise.all([holder, checked]);

    expect((await record(sourceId)).editorialStatus?.state).toBe("retracted");
  });

  it("does not list a dismissed notice again when a refresh took it off and the check puts it back", async () => {
    const { library, add, check, record } = await setup();
    const sourceId = await add("Retracted after it was added", [RETRACTED], []);
    await check([RETRACTED_KEY], "2026-11-15T10:00:00.000Z");
    expect(await dismissScientLibraryNoticeChanges(library)).toBe("dismissed");
    expect(await listScientLibraryNoticeChanges(library)).toEqual([]);

    // A refresh whose registry does not repeat the notice.
    await recordScientSourceCheck({
      root: library,
      sourceId,
      expectedRevision: 2,
      editorialStatus: { state: "none", notices: [], checkedAt: "2026-11-16T10:00:00.000Z" },
    });
    expect(await check([RETRACTED_KEY], "2026-11-22T10:00:00.000Z")).toEqual({ changedSources: 1 });
    expect((await record(sourceId)).editorialStatus?.state).toBe("retracted");
    expect(await listScientLibraryNoticeChanges(library)).toEqual([]);
  });
});
