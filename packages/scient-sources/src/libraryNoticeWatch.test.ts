// @effect-diagnostics nodeBuiltinImport:off -- This test verifies the Node filesystem adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  dismissScientLibraryNoticeChanges,
  listScientLibraryNoticeChanges,
  recordScientLibraryNoticeCheck,
  retractionWatchReader,
} from "./libraryNoticeWatch.ts";
import { ensureScientLibrary, scientLibraryLocation } from "./libraryRoot.ts";
import type {
  ScientSourceCandidate,
  ScientSourceEditorialNotice,
  ScientSourceIdentifier,
} from "./model.ts";
import {
  importScientSource,
  listScientSourceRevisions,
  readScientSourceRecord,
  recordScientSourceCheck,
} from "./store.ts";

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

const fixtures: string[] = [];

afterEach(async () => {
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
    const candidate: ScientSourceCandidate = {
      sourceKey: title,
      type: "article",
      customType: null,
      title,
      creators: [],
      issuedRaw: "2008",
      issuedYear: 2008,
      identifiers,
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
    };
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

  it("does not read a paper it never asked about as withdrawn", async () => {
    const { add, check, record } = await setup();
    // Added while the file was being read: its identifier was not among those asked for.
    const sourceId = await add("Added during the download", [RETRACTED], [WATCH_RETRACTION]);

    expect(await check([], "2026-11-15T10:00:00.000Z")).toEqual({ changedSources: 0 });
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
