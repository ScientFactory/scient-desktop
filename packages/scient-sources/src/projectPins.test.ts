// @effect-diagnostics nodeBuiltinImport:off -- Pin tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { editableMetadataFromRecord } from "./editable.ts";
import { resolveScientProjectSources } from "./libraryInstanceMap.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import type { ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import {
  changeScientProjectPins,
  listScientProjectPinnedWorks,
  pinScientLibrarySource,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
  renameScientProjectPinKey,
  resolveScientProjectPins,
  setScientProjectPinNote,
  unpinScientLibrarySource,
} from "./projectPins.ts";
import {
  importScientSource,
  listScientSourceRecords,
  listScientSourceTrash,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceMetadata,
} from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pins-")),
  );
  fixtures.push(root);
  return root;
}

async function newLibrary(base: string, name: string) {
  const root = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(root);
  return { root, library: scientLibraryLocation(root) };
}

async function newProject(base: string, name = "project"): Promise<string> {
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  return root;
}

const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

function candidate(
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate> = {},
): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title: `Study ${sourceKey}`,
    creators: [ada],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [],
    abstract: "Not copied into pins.",
    containerTitle: "Journal",
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
  };
}

async function addRecord(
  library: ReturnType<typeof scientLibraryLocation>,
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate> = {},
): Promise<ScientSourceRecord> {
  const imported = await importScientSource({
    root: library,
    operationId: NodeCrypto.randomUUID(),
    candidate: candidate(sourceKey, overrides),
    allowPossibleMetadataMatch: true,
  });
  if (!imported.record) throw new Error(`Expected ${sourceKey} to import.`);
  return imported.record;
}

async function renameKey(
  library: ReturnType<typeof scientLibraryLocation>,
  record: ScientSourceRecord,
  citationKey: string,
) {
  const current = await readScientSourceRecord(library, record.sourceId);
  if (!current) throw new Error("Expected the record.");
  const result = await updateScientSourceMetadata({
    root: library,
    sourceId: current.sourceId,
    expectedRevision: current.revision,
    metadata: { ...editableMetadataFromRecord(current), citationKey },
  });
  expect(result.outcome).toBe("updated");
}

async function tree(root: string): Promise<ReadonlyArray<string>> {
  return (await NodeFSP.readdir(root, { recursive: true })).toSorted();
}

describe("project pins", () => {
  it("copies the preferred key once, with a suffix on a clash in the project", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, "A", { citationKey: "smith2020deep" });
    const second = await addRecord(library, "B", { citationKey: "other2021" });

    const pinned = await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: first.sourceId,
      actor: "agent",
      note: "Why I cite this here.",
    });
    expect(pinned).toMatchObject({
      outcome: "pinned",
      pin: { citationKey: "smith2020deep", note: "Why I cite this here." },
    });
    expect(pinned.outcome === "pinned" && pinned.pin.work).toEqual({
      type: "article",
      title: "Study A",
      creators: [ada],
      issuedYear: 2020,
      identifiers: [],
      containerTitle: "Journal",
    });

    await renameKey(library, first, "lovelace2020");
    await renameKey(library, second, "Smith2020Deep");
    const clashing = await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: second.sourceId,
      actor: "user",
    });
    expect(clashing).toMatchObject({ outcome: "pinned", pin: { citationKey: "Smith2020Deepa" } });
    expect(
      await pinScientLibrarySource({
        projectRoot,
        library,
        sourceId: first.sourceId,
        actor: "user",
      }),
    ).toMatchObject({ outcome: "existing", pin: { citationKey: "smith2020deep" } });

    const refreshed = await refreshScientProjectPinSnapshots({ projectRoot, library });
    expect(refreshed.changed).toBe(false);
    expect(refreshed.pins.map((pin) => pin.citationKey)).toEqual([
      "smith2020deep",
      "Smith2020Deepa",
    ]);
    expect((await readScientSourceRecord(library, first.sourceId))?.note ?? null).toBeNull();

    expect(
      await setScientProjectPinNote({
        projectRoot,
        citationKey: "SMITH2020DEEP",
        note: null,
        base: "Why I cite this here.",
        actor: "user",
      }),
    ).toMatchObject({ outcome: "updated", pin: { citationKey: "smith2020deep" } });
    expect((await readScientProjectPins(projectRoot))[0]).not.toHaveProperty("note");
    expect(
      await unpinScientLibrarySource({ projectRoot, citationKey: "smith2020deepa", actor: "user" }),
    ).toMatchObject({ outcome: "unpinned" });
    expect((await readScientProjectPins(projectRoot)).map((pin) => pin.citationKey)).toEqual([
      "smith2020deep",
    ]);
  });

  it("pins and unpins many at once with the outcomes and pins.json one at a time gives", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const [first, second, kept, gone] = [
      await addRecord(library, "A"),
      await addRecord(library, "B"),
      await addRecord(library, "C"),
      await addRecord(library, "D"),
    ];
    const one = await newProject(base, "one-by-one");
    const many = await newProject(base, "at-once");
    for (const projectRoot of [one, many]) {
      for (const record of [kept, gone]) {
        await pinScientLibrarySource({
          projectRoot,
          library,
          sourceId: record.sourceId,
          actor: "user",
        });
      }
    }
    const goneKey = (await readScientProjectPins(one)).find(
      (pin) => pin.sourceId === gone.sourceId,
    )!.citationKey;
    // The pin of a source removed from the Library is now a snapshot row.
    await removeScientSource({
      root: library,
      sourceId: gone.sourceId,
      expectedRevision: gone.revision,
    });
    const changes = [
      { action: "pin", sourceId: first.sourceId },
      { action: "pin", sourceId: second.sourceId },
      { action: "pin", sourceId: kept.sourceId },
      { action: "pin", sourceId: "src_missing" },
      { action: "pin", sourceId: "../outside" },
      { action: "unpin", citationKey: goneKey },
      { action: "unpin", citationKey: "nobody2020" },
      { action: "pin", sourceId: first.sourceId },
    ] as const;

    const loop = [];
    for (const change of changes) {
      loop.push(
        await (
          change.action === "pin"
            ? pinScientLibrarySource({
                projectRoot: one,
                library,
                sourceId: change.sourceId,
                actor: "user",
              })
            : unpinScientLibrarySource({
                projectRoot: one,
                citationKey: change.citationKey,
                actor: "user",
              })
        ).catch(() => ({ outcome: "refused" as const })),
      );
    }
    const batch = await changeScientProjectPins({
      projectRoot: many,
      library,
      changes,
      actor: "user",
    });

    const summary = (
      results: ReadonlyArray<{
        readonly outcome: string;
        readonly pin?: { readonly citationKey: string };
      }>,
    ) => results.map((result) => [result.outcome, result.pin?.citationKey]);
    expect(summary(batch)).toEqual(summary(loop));
    expect(summary(batch).map(([outcome]) => outcome)).toEqual([
      "pinned",
      "pinned",
      "existing",
      "not-found",
      "refused",
      "unpinned",
      "not-pinned",
      "existing",
    ]);
    const pinsOf = async (projectRoot: string) =>
      (await readScientProjectPins(projectRoot)).map(({ pinnedAt: _at, ...pin }) => pin);
    expect(await pinsOf(many)).toEqual(await pinsOf(one));
  });

  it("rewrites pins.json byte for byte and keeps fields from a newer Scient", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const record = await addRecord(library, "A", {
      identifiers: [{ scheme: "doi", value: "10.1000/a" }],
    });
    await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    file.pins[0].work.edition = "2nd";
    file.pins[0].shelf = "methods";
    file.teamLibraryId = "team_1";
    const withNewerFields = `${JSON.stringify(file, null, 2)}\n`;
    await NodeFSP.writeFile(pinsPath, withNewerFields);

    expect((await refreshScientProjectPinSnapshots({ projectRoot, library })).changed).toBe(false);
    await setScientProjectPinNote({
      projectRoot,
      citationKey: "lovelace2020study",
      note: "Kept.",
      actor: "user",
    });
    expect(JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"))).toMatchObject({
      teamLibraryId: "team_1",
      pins: [{ note: "Kept.", shelf: "methods", work: { edition: "2nd" } }],
    });
    await setScientProjectPinNote({
      projectRoot,
      citationKey: "lovelace2020study",
      note: null,
      base: "Kept.",
      actor: "user",
    });
    expect(await NodeFSP.readFile(pinsPath, "utf8")).toBe(withNewerFields);

    await renameKey(library, record, "lovelace2020renamed");
    const current = await readScientSourceRecord(library, record.sourceId);
    if (!current) throw new Error("Expected the record.");
    await updateScientSourceMetadata({
      root: library,
      sourceId: current.sourceId,
      expectedRevision: current.revision,
      metadata: { ...editableMetadataFromRecord(current), title: "Study A, revised" },
    });
    const refreshed = await refreshScientProjectPinSnapshots({ projectRoot, library });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.pins[0]).toMatchObject({
      citationKey: "lovelace2020study",
      work: { title: "Study A, revised" },
    });
  });

  it("resolves project source IDs in the design's order", async () => {
    const base = await fixture();
    const { library, root } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const byDoi = await addRecord(library, "DOI", {
      identifiers: [{ scheme: "doi", value: "10.1000/doi" }],
    });
    const byMetadata = await addRecord(library, "META", { title: "Metadata only" });
    const twinOne = await addRecord(library, "TWIN1", { title: "Twin study" });
    const twinTwo = await addRecord(library, "TWIN2", { title: "Twin study" });
    const loser = await addRecord(library, "LOSER", { title: "Merged away" });
    const survivor = await addRecord(library, "SURVIVOR", { title: "Merged into" });
    expect(
      await mergeScientLibrarySources({
        library,
        sourceIds: [loser.sourceId, survivor.sourceId],
        survivorId: survivor.sourceId,
      }),
    ).toMatchObject({ outcome: "merged" });
    const work = (title: string, identifiers: ScientSourceRecord["identifiers"] = []) => ({
      type: "article",
      title,
      creators: [ada],
      issuedYear: 2020,
      identifiers,
      containerTitle: null,
    });

    const sources = [
      { projectSourceId: loser.sourceId, work: null },
      {
        projectSourceId: "source_elsewhere_doi",
        work: work("Another title", [{ scheme: "doi", value: "https://doi.org/10.1000/DOI" }]),
      },
      { projectSourceId: "source_elsewhere_meta", work: work("Metadata only") },
      { projectSourceId: "source_elsewhere_twin", work: work("Twin study") },
    ];
    expect(
      await resolveScientProjectSources({ library, projectRoot, mode: "write", sources }),
    ).toEqual([
      {
        kind: "resolved",
        projectSourceId: loser.sourceId,
        sourceId: survivor.sourceId,
        by: "same-id",
      },
      {
        kind: "resolved",
        projectSourceId: "source_elsewhere_doi",
        sourceId: byDoi.sourceId,
        by: "identifier",
      },
      {
        kind: "resolved",
        projectSourceId: "source_elsewhere_meta",
        sourceId: byMetadata.sourceId,
        by: "metadata",
      },
      {
        kind: "unresolved",
        projectSourceId: "source_elsewhere_twin",
        reason: "ambiguous",
        candidateIds: expect.arrayContaining([twinOne.sourceId, twinTwo.sourceId]),
      },
    ]);
    expect(await NodeFSP.readdir(NodePath.join(root, "projects"))).toHaveLength(1);

    const fromMap = await resolveScientProjectSources({
      library,
      projectRoot,
      mode: "read",
      sources: sources.slice(1, 3).map(({ projectSourceId }) => ({ projectSourceId, work: null })),
    });
    expect(fromMap.map((resolution) => resolution.kind === "resolved" && resolution.by)).toEqual([
      "instance-map",
      "instance-map",
    ]);
  });

  it("hydrates unmatched pins only in write mode, once", async () => {
    const base = await fixture();
    const author = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(author.library, "A", {
      identifiers: [{ scheme: "doi", value: "10.1000/a" }],
    });
    await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const collaborator = await newLibrary(base, "collaborator");
    const before = await tree(collaborator.root);

    const read = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "read",
      actor: "agent",
    });
    expect(read.map(({ resolution }) => resolution)).toEqual([
      {
        kind: "unresolved",
        projectSourceId: record.sourceId,
        reason: "no-match",
        candidateIds: [],
      },
    ]);
    const offline = await listScientProjectPinnedWorks({ projectRoot, library: null });
    expect(offline).toMatchObject([
      { citationKey: "lovelace2020study", from: "snapshot", record: { title: "Study A" } },
    ]);
    expect(
      await listScientProjectPinnedWorks({ projectRoot, library: collaborator.library }),
    ).toEqual(offline);
    expect(await tree(collaborator.root)).toEqual(before);

    const written = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    expect(written[0]?.resolution).toMatchObject({ kind: "resolved", by: "hydrated" });
    const hydrated = await listScientSourceRecords(collaborator.library);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      citationKey: "lovelace2020study",
      title: "Study A",
      abstract: null,
      attachments: [],
      identifiers: [{ scheme: "doi", value: "10.1000/a" }],
      origin: { actor: "agent", intake: "file" },
      readingStatus: "unread",
    });

    const again = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    expect(again[0]?.resolution).toEqual({
      kind: "resolved",
      projectSourceId: record.sourceId,
      sourceId: hydrated[0]?.sourceId,
      by: "instance-map",
    });
    expect(await listScientSourceRecords(collaborator.library)).toHaveLength(1);
    expect(
      await listScientProjectPinnedWorks({ projectRoot, library: collaborator.library }),
    ).toMatchObject([{ from: "library", record: { sourceId: hydrated[0]?.sourceId } }]);
  });

  it("never re-creates a removed work, even when the instance map is lost", async () => {
    const base = await fixture();
    const { root, library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const work = {
      type: "article",
      title: "Removed study",
      creators: [ada],
      issuedYear: 2020,
      identifiers: [],
      containerTitle: null,
    };
    const resolve = () =>
      resolveScientProjectSources({
        library,
        projectRoot,
        mode: "write",
        sources: [{ projectSourceId: "source_elsewhere", work }],
        hydrate: { actor: "agent" },
      });
    const [first] = await resolve();
    if (first?.kind !== "resolved") throw new Error("Expected the pin to hydrate.");
    const hydrated = await readScientSourceRecord(library, first.sourceId);
    if (!hydrated) throw new Error("Expected the hydrated record.");
    // The user edits it, so only its ID still ties it to the pin.
    await updateScientSourceMetadata({
      root: library,
      sourceId: hydrated.sourceId,
      expectedRevision: hydrated.revision,
      metadata: {
        ...editableMetadataFromRecord(hydrated),
        title: "Renamed",
        issuedRaw: "1999",
        issuedYear: 1999,
      },
    });
    const removed = await removeScientSource({
      root: library,
      sourceId: hydrated.sourceId,
      expectedRevision: hydrated.revision + 1,
    });
    expect(removed.outcome).toBe("removed");
    await NodeFSP.rm(NodePath.join(root, "projects"), { recursive: true });

    expect(await resolve()).toEqual([
      {
        kind: "unresolved",
        projectSourceId: "source_elsewhere",
        reason: "removed",
        candidateIds: [],
      },
    ]);
    expect(await listScientSourceRecords(library)).toHaveLength(0);
    expect((await listScientSourceTrash(library)).entries).toHaveLength(1);
  });

  it("hydrates one record for two project sources of the same work", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const work = {
      type: "article",
      title: "Twice pinned",
      creators: [ada],
      issuedYear: 2020,
      identifiers: [],
      containerTitle: null,
    };
    const resolutions = await resolveScientProjectSources({
      library,
      projectRoot,
      mode: "write",
      sources: [
        { projectSourceId: "source_one", work },
        { projectSourceId: "source_two", work },
      ],
      hydrate: { actor: "agent" },
    });
    const records = await listScientSourceRecords(library);
    expect(records).toHaveLength(1);
    expect(resolutions).toMatchObject([
      { kind: "resolved", sourceId: records[0]?.sourceId, by: "hydrated" },
      { kind: "resolved", sourceId: records[0]?.sourceId, by: "metadata" },
    ]);
  });

  it("renames a pin's project key, refusing one another pin uses", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, "A", { citationKey: "smith2020" });
    const second = await addRecord(library, "B", { citationKey: "jones2021" });
    for (const record of [first, second]) {
      await pinScientLibrarySource({
        projectRoot,
        library,
        sourceId: record.sourceId,
        actor: "agent",
      });
    }

    expect(
      await renameScientProjectPinKey({ projectRoot, citationKey: "smith2020", to: "Jones2021" }),
    ).toEqual({ outcome: "taken" });
    expect(
      await renameScientProjectPinKey({
        projectRoot,
        citationKey: "SMITH2020",
        to: "lovelace2020",
      }),
    ).toMatchObject({ outcome: "renamed", pin: { sourceId: first.sourceId } });
    expect((await readScientProjectPins(projectRoot)).map((pin) => pin.citationKey)).toEqual([
      "jones2021",
      "lovelace2020",
    ]);
    expect((await readScientSourceRecord(library, first.sourceId))?.citationKey).toBe("smith2020");
  });
});
