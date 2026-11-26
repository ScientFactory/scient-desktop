// @effect-diagnostics nodeBuiltinImport:off -- Copies real project folders between computers' Libraries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { editableMetadataFromRecord } from "@scientfactory/scient-sources";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  pinScientLibrarySource,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
} from "@scientfactory/scient-sources/project-pins";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
  updateScientSourceMetadata,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { syncPinnedBibliography } from "./ManagedBibliography.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const person = (familyName: string, creatorType = "author") => ({
  creatorType,
  givenName: "Ada",
  familyName,
  literalName: null,
});

const blank: Omit<ScientSourceCandidate, "sourceKey" | "type" | "title"> = {
  customType: null,
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: [],
  abstract: "Not cited.",
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

/** A journal article with pages, a book chapter with its editor, and a website. */
const works: ReadonlyArray<ScientSourceCandidate> = [
  {
    ...blank,
    sourceKey: "article",
    type: "article",
    title: "Early vasopressin in septic shock",
    creators: [person("Lovelace")],
    issuedRaw: "2021-03-04",
    issuedYear: 2021,
    identifiers: [{ scheme: "doi", value: "10.1000/article" }],
    containerTitle: "Critical Care",
    publisher: "Springer",
    volume: "25",
    issue: "3",
    pages: "101-109",
    language: "en",
    tags: ["sepsis"],
  },
  {
    ...blank,
    sourceKey: "chapter",
    type: "book-chapter",
    title: "Fluid balance",
    creators: [person("Babbage"), person("Somerville", "editor")],
    issuedRaw: "2019",
    issuedYear: 2019,
    identifiers: [{ scheme: "isbn", value: "9780000000001" }],
    containerTitle: "Handbook of Intensive Care",
    publisher: "Oxford University Press",
    pages: "45-67",
  },
  {
    ...blank,
    sourceKey: "website",
    type: "web",
    title: "Surviving Sepsis guidance",
    creators: [person("Nightingale")],
    issuedRaw: "2024-01-02",
    issuedYear: 2024,
    containerTitle: "Sepsis Campaign",
    url: "https://example.org/guidance",
    language: "en",
  },
];

async function computer(base: string, name: string) {
  const libraryRoot = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(libraryRoot);
  return scientLibraryLocation(libraryRoot);
}

async function add(library: Awaited<ReturnType<typeof computer>>, work: ScientSourceCandidate) {
  const imported = await importScientSource({
    root: library,
    operationId: NodeCrypto.randomUUID(),
    candidate: work,
    allowPossibleMetadataMatch: true,
  });
  return imported.record!;
}

const managedFiles = async (root: string) => ({
  bib: await NodeFSP.readFile(NodePath.join(root, "references.bib"), "utf8"),
  json: await NodeFSP.readFile(NodePath.join(root, "references.json"), "utf8"),
});

describe("pinned citations travel with the project", () => {
  it("renders the same entries with the original, an empty and an incomplete Library", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pinned-citations-")),
    );
    fixtures.push(base);
    const original = await computer(base, "author");
    const projectRoot = NodePath.join(base, "project");
    await NodeFSP.mkdir(projectRoot);
    await initializeScientProject({ root: projectRoot });
    for (const work of works) {
      const record = await add(original, work);
      await pinScientLibrarySource({
        projectRoot,
        library: original,
        sourceId: record.sourceId,
        actor: "user",
      });
    }
    const sync = (root: string, library: typeof original | null, access: "read" | "write") =>
      syncPinnedBibliography({ root, library, access, actor: "user" });
    await sync(projectRoot, original, "write");
    const written = await managedFiles(projectRoot);
    expect(written.bib).toContain("pages = {101--109}");
    expect(written.bib).toContain("url = {https://example.org/guidance}");

    // A collaborator's copy: no Library at all, then an empty one that hydrates the pins.
    const copy = async (name: string) => {
      const root = NodePath.join(base, name);
      await NodeFSP.cp(projectRoot, root, { recursive: true });
      return root;
    };
    const noLibrary = await copy("no-library");
    await NodeFSP.rm(NodePath.join(noLibrary, "references.bib"));
    await NodeFSP.rm(NodePath.join(noLibrary, "references.json"));
    await sync(noLibrary, null, "read");
    expect(await managedFiles(noLibrary)).toEqual(written);

    const empty = await copy("empty-library");
    await sync(empty, await computer(base, "collaborator"), "write");
    expect(await managedFiles(empty)).toEqual(written);

    // A Library that has the same works with fewer details.
    const sparse = await computer(base, "sparse");
    const sparseRecords = [];
    for (const work of works) {
      sparseRecords.push(
        await add(sparse, {
          ...work,
          sourceKey: `${work.sourceKey}-sparse`,
          issuedRaw: String(work.issuedYear),
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          language: null,
          url: null,
          tags: [],
        }),
      );
    }
    const incomplete = await copy("incomplete-library");
    await sync(incomplete, sparse, "write");
    expect(await managedFiles(incomplete)).toEqual(written);
    await refreshScientProjectPinSnapshots({ projectRoot: incomplete, library: sparse });
    expect((await readScientProjectPins(incomplete)).map((pin) => pin.work.pages)).toEqual(
      (await readScientProjectPins(projectRoot)).map((pin) => pin.work.pages),
    );

    // A deliberate, credited deletion there is a correction, not a loss.
    const article = (await readScientSourceRecord(sparse, sparseRecords[0]!.sourceId))!;
    const withPages = await updateScientSourceMetadata({
      root: sparse,
      sourceId: article.sourceId,
      expectedRevision: article.revision,
      metadata: { ...editableMetadataFromRecord(article), pages: "1-9" },
    });
    await updateScientSourceMetadata({
      root: sparse,
      sourceId: article.sourceId,
      expectedRevision: withPages.record.revision,
      metadata: { ...editableMetadataFromRecord(withPages.record), pages: null },
    });
    await refreshScientProjectPinSnapshots({ projectRoot: incomplete, library: sparse });
    await sync(incomplete, sparse, "write");
    const corrected = await managedFiles(incomplete);
    expect(corrected.bib).not.toContain("pages = {101--109}");
    expect(corrected.bib).toContain("pages = {45--67}");
  });

  it("keeps the managed entries an older snapshot cannot rebuild, and says so", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pinned-citations-")),
    );
    fixtures.push(base);
    const original = await computer(base, "author");
    const projectRoot = NodePath.join(base, "project");
    await NodeFSP.mkdir(projectRoot);
    await initializeScientProject({ root: projectRoot });
    for (const work of works) {
      const record = await add(original, work);
      await pinScientLibrarySource({
        projectRoot,
        library: original,
        sourceId: record.sourceId,
        actor: "user",
      });
    }
    await syncPinnedBibliography({
      root: projectRoot,
      library: original,
      access: "write",
      actor: "user",
    });
    const written = await managedFiles(projectRoot);

    // pins.json as an earlier Scient wrote it: the first six snapshot fields only.
    const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    for (const pin of file.pins) {
      const { type, title, creators, issuedYear, identifiers, containerTitle } = pin.work;
      pin.work = { type, title, creators, issuedYear, identifiers, containerTitle };
    }
    await NodeFSP.writeFile(pinsPath, `${JSON.stringify(file, null, 2)}\n`);

    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.cp(projectRoot, elsewhere, { recursive: true });
    const collaborator = await computer(base, "collaborator");
    const status = await syncPinnedBibliography({
      root: elsewhere,
      library: collaborator,
      access: "write",
      actor: "user",
    });
    expect(await managedFiles(elsewhere)).toEqual(written);
    expect(status.keptEntries).toHaveLength(3);
    // The hydrated records know no more than the old snapshot, so it stays unknown, not empty.
    await refreshScientProjectPinSnapshots({ projectRoot: elsewhere, library: collaborator });
    expect((await readScientProjectPins(elsewhere)).map((pin) => "pages" in pin.work)).toEqual([
      false,
      false,
      false,
    ]);

    // An edit of anything but a citation input leaves the missing ones unknown: still kept.
    const [hydrated] = await listScientSourceRecords(collaborator);
    await updateScientSourceMetadata({
      root: collaborator,
      sourceId: hydrated!.sourceId,
      expectedRevision: hydrated!.revision,
      metadata: { ...editableMetadataFromRecord(hydrated!), abstract: "Read later." },
    });
    await refreshScientProjectPinSnapshots({ projectRoot: elsewhere, library: collaborator });
    const afterEdit = await syncPinnedBibliography({
      root: elsewhere,
      library: collaborator,
      access: "write",
      actor: "user",
    });
    expect(await managedFiles(elsewhere)).toEqual(written);
    expect(afterEdit.keptEntries).toHaveLength(3);

    // Correcting only the title never drops the pages and full date only the kept entry knows.
    const current = (await listScientSourceRecords(collaborator)).find(
      (record) => record.sourceId === hydrated!.sourceId,
    )!;
    await updateScientSourceMetadata({
      root: collaborator,
      sourceId: current.sourceId,
      expectedRevision: current.revision,
      metadata: { ...editableMetadataFromRecord(current), title: "A corrected title" },
    });
    await refreshScientProjectPinSnapshots({ projectRoot: elsewhere, library: collaborator });
    const afterCorrection = await syncPinnedBibliography({
      root: elsewhere,
      library: collaborator,
      access: "write",
      actor: "user",
    });
    expect(await managedFiles(elsewhere)).toEqual(written);
    expect(afterCorrection.keptEntries).toHaveLength(3);
  });

  it.each(["current", "legacy"] as const)(
    "keeps richer managed entries after editing type on an empty %s hydration",
    async (version) => {
      const base = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pinned-knowledge-")),
      );
      fixtures.push(base);
      const original = await computer(base, "author");
      const projectRoot = NodePath.join(base, "project");
      await NodeFSP.mkdir(projectRoot);
      await initializeScientProject({ root: projectRoot });
      const report = await add(original, {
        ...works[0]!,
        sourceKey: "report",
        type: "report",
        more: { number: "TR-42", edition: "2" },
      });
      await pinScientLibrarySource({
        projectRoot,
        library: original,
        sourceId: report.sourceId,
        actor: "user",
      });
      await syncPinnedBibliography({
        root: projectRoot,
        library: original,
        access: "write",
        actor: "user",
      });
      const written = await managedFiles(projectRoot);
      expect(written.bib).toContain("number = {TR-42}");
      expect(written.bib).toContain("edition = {2}");
      const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
      const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
      file.pins[0].work = {
        type: "other",
        title: null,
        creators: [],
        issuedYear: null,
        identifiers: [],
        containerTitle: null,
      };
      await NodeFSP.writeFile(pinsPath, JSON.stringify(file));
      const elsewhere = NodePath.join(base, "elsewhere");
      await NodeFSP.cp(projectRoot, elsewhere, { recursive: true });
      const collaborator = await computer(base, "collaborator");
      await syncPinnedBibliography({
        root: elsewhere,
        library: collaborator,
        access: "write",
        actor: "user",
      });
      await refreshScientProjectPinSnapshots({ projectRoot: elsewhere, library: collaborator });
      let [hydrated] = await listScientSourceRecords(collaborator);
      if (!hydrated) throw new Error("The empty legacy source was not hydrated.");
      if (version === "legacy") {
        const recordPath = NodePath.join(collaborator.root, "records", `${hydrated.sourceId}.json`);
        const legacy = JSON.parse(await NodeFSP.readFile(recordPath, "utf8"));
        delete legacy.hydratedCitationFields;
        await NodeFSP.writeFile(recordPath, JSON.stringify(legacy));
        hydrated = (await readScientSourceRecord(collaborator, hydrated.sourceId))!;
      }
      const changed = await updateScientSourceMetadata({
        root: collaborator,
        sourceId: hydrated.sourceId,
        expectedRevision: hydrated.revision,
        metadata: { ...editableMetadataFromRecord(hydrated), type: "book" },
      });
      expect(changed.outcome).toBe("updated");
      await refreshScientProjectPinSnapshots({ projectRoot: elsewhere, library: collaborator });
      expect((await readScientProjectPins(elsewhere))[0]?.work).not.toHaveProperty("more");
      expect((await readScientProjectPins(elsewhere))[0]?.work.type).toBe("book");
      const status = await syncPinnedBibliography({
        root: elsewhere,
        library: collaborator,
        access: "write",
        actor: "user",
      });
      expect(status.keptEntries).toHaveLength(1);
      expect(await managedFiles(elsewhere)).toEqual(written);
    },
  );

  it("keeps entries listing every author while only a cut copy of the list is here", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pinned-citations-")),
    );
    fixtures.push(base);
    const original = await computer(base, "author");
    const projectRoot = NodePath.join(base, "project");
    await NodeFSP.mkdir(projectRoot);
    await initializeScientProject({ root: projectRoot });
    const record = await add(original, {
      ...works[0]!,
      creators: Array.from({ length: 7_992 }, (_, index) => person(`Member${index + 1}`)),
    });
    await pinScientLibrarySource({
      projectRoot,
      library: original,
      sourceId: record.sourceId,
      actor: "user",
    });
    await refreshScientProjectPinSnapshots({ projectRoot, library: original });
    expect((await readScientProjectPins(projectRoot))[0]?.work.creators).toHaveLength(256);
    await syncPinnedBibliography({
      root: projectRoot,
      library: original,
      access: "write",
      actor: "user",
    });
    const written = await managedFiles(projectRoot);
    expect(written.bib).toContain("Member7992");

    const offline = await syncPinnedBibliography({
      root: projectRoot,
      library: null,
      access: "read",
      actor: "user",
    });
    expect(await managedFiles(projectRoot)).toEqual(written);
    expect(offline.keptEntries).toHaveLength(1);

    const collaborator = await computer(base, "collaborator");
    await syncPinnedBibliography({
      root: projectRoot,
      library: collaborator,
      access: "write",
      actor: "user",
    });
    expect(await managedFiles(projectRoot)).toEqual(written);
  });
});
