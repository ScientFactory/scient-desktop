// @effect-diagnostics nodeBuiltinImport:off -- Tombstone tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { resolveScientProjectSources } from "./libraryInstanceMap.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { runScientLibraryMove } from "./libraryMove.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import { resolveScientProjectPins } from "./projectPins.ts";
import {
  attachScientSourcePdf,
  deleteScientSourcesPermanently,
  deleteTrashedScientSource,
  importScientSource,
  listScientSourceRecords,
  listScientSourceTrash,
  readScientSourceRecord,
  removeScientSource,
} from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-tombstone-")),
  );
  fixtures.push(base);
  const root = scientLibraryRootFor(NodePath.join(base, "state"));
  await ensureScientLibrary(root);
  const projectRoot = NodePath.join(base, "project");
  await NodeFSP.mkdir(projectRoot);
  await initializeScientProject({ root: projectRoot });
  return { base, root, library: scientLibraryLocation(root), projectRoot };
}

const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

function candidate(title: string): ScientSourceCandidate {
  return {
    sourceKey: title,
    type: "article",
    customType: null,
    title,
    creators: [ada],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [],
    abstract: `Abstract of ${title}.`,
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
}

async function add(
  root: Parameters<typeof importScientSource>[0]["root"],
  title: string,
  fields: Partial<ScientSourceCandidate> = {},
) {
  return (await importScientSource({
    root,
    operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    candidate: { ...candidate(title), ...fields },
    allowPossibleMetadataMatch: true,
    actor: "user",
    intake: "file",
  }))!.record!;
}

async function attach(projectRoot: string, sourceId: string, bytes: string) {
  const pdf = NodePath.join(NodePath.dirname(projectRoot), `${NodeCrypto.randomUUID()}.pdf`);
  await NodeFSP.writeFile(pdf, `%PDF-1.7\n${bytes}\n`, "utf8");
  const record = (await readScientSourceRecord(projectRoot, sourceId))!;
  const attached = await attachScientSourcePdf({
    root: projectRoot,
    sourceId,
    expectedRevision: record.revision,
    pdfPath: pdf,
  });
  return attached.record.attachments.at(-1)!.sha256;
}

async function inLibrary(root: string, sha256: string) {
  const paths = [
    NodePath.join(root, "files/sha256", sha256.slice(0, 2), `${sha256}.pdf`),
    NodePath.join(root, "annotations/v1", `${sha256}.json`),
  ];
  const found = await Promise.all(
    paths.map((path) => NodeFSP.stat(path).then(Boolean, () => false)),
  );
  return found.some(Boolean);
}

async function highlight(projectRoot: string, sha256: string) {
  const directory = NodePath.join(projectRoot, ".scient/annotations/v1");
  await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, `${sha256}.json`),
    JSON.stringify({
      formatVersion: 1,
      material: { sha256, byteLength: 10 },
      paths: [],
      annotations: [{ annotationId: "ann_1", revision: 1, highlighted: true }],
      history: [],
    }),
  );
}

async function deleteForGood(library: ReturnType<typeof scientLibraryLocation>, sourceId: string) {
  const record = (await readScientSourceRecord(library, sourceId))!;
  await removeScientSource({ root: library, sourceId, expectedRevision: record.revision });
  await deleteScientSourcesPermanently({ root: library });
}

const work = (title: string) => ({
  type: "article",
  title,
  creators: [ada],
  issuedYear: 2020,
  identifiers: [],
  containerTitle: null,
});

describe("sources deleted for good", () => {
  it.each(["single", "empty-trash"] as const)(
    "stay deleted when a project still cites them (%s)",
    async (how) => {
      const { root, library, projectRoot } = await fixture();
      const resolve = (projectSourceId: string) =>
        resolveScientProjectSources({
          library,
          projectRoot,
          mode: "write",
          sources: [{ projectSourceId, work: work("Deleted study") }],
          hydrate: { actor: "agent" },
        });
      const [first] = await resolve("source_pinned");
      if (first?.kind !== "resolved") throw new Error("Expected the pin to hydrate.");
      const record = (await readScientSourceRecord(library, first.sourceId))!;
      await removeScientSource({
        root: library,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      });
      if (how === "single") {
        await deleteTrashedScientSource({
          root: library,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
        });
      } else {
        await deleteScientSourcesPermanently({ root: library });
      }
      // A new checkout: no instance map remembers the pin.
      await NodeFSP.rm(NodePath.join(root, "projects"), { recursive: true });

      const removed = {
        kind: "unresolved",
        reason: "removed",
        candidateIds: [record.sourceId],
      };
      expect(await resolve("source_pinned")).toEqual([
        { ...removed, projectSourceId: "source_pinned" },
      ]);
      expect(await resolve("source_pinned")).toEqual([
        { ...removed, projectSourceId: "source_pinned" },
      ]);
      // Another checkout's ID for the same work, matched by its snapshot alone.
      expect(await resolve("source_other_checkout")).toEqual([
        { ...removed, projectSourceId: "source_other_checkout" },
      ]);
      expect(await listScientSourceRecords(library)).toEqual([]);
    },
  );

  it("a merged-away copy deleted for good still resolves to its survivor", async () => {
    const { library, projectRoot } = await fixture();
    const loser = await add(library, "Merged away");
    const survivor = await add(library, "Merged into");
    await mergeScientLibrarySources({
      library,
      sourceIds: [loser.sourceId, survivor.sourceId],
      survivorId: survivor.sourceId,
    });
    await deleteScientSourcesPermanently({ root: library });
    expect(
      await resolveScientProjectSources({
        library,
        projectRoot,
        mode: "write",
        sources: [{ projectSourceId: loser.sourceId, work: work("Merged away") }],
        hydrate: { actor: "agent" },
      }),
    ).toMatchObject([{ kind: "resolved", sourceId: survivor.sourceId }]);
  });

  it("an old copy of a moved project does not bring it back", async () => {
    const { base, library, projectRoot } = await fixture();
    const source = await add(projectRoot, "Deleted study");
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(projectRoot, copy, { recursive: true });
    await runScientLibraryMove({ library, projectRoot, actor: "user" });
    const moved = (await readScientSourceRecord(library, source.sourceId))!;
    await removeScientSource({
      root: library,
      sourceId: moved.sourceId,
      expectedRevision: moved.revision,
    });
    await deleteScientSourcesPermanently({ root: library });

    await runScientLibraryMove({ library, projectRoot: copy, actor: "user" });
    expect(await listScientSourceRecords(library)).toEqual([]);
    const [pinned] = await resolveScientProjectPins({
      projectRoot: copy,
      library,
      mode: "write",
      actor: "agent",
    });
    expect(pinned?.resolution).toMatchObject({ kind: "unresolved", reason: "removed" });
    expect(await listScientSourceRecords(library)).toEqual([]);
  });

  it("another project's copy of the work is not moved back, unlike a contradicting work", async () => {
    const { base, library, projectRoot } = await fixture();
    const doi = [{ scheme: "doi" as const, value: "10.1000/deleted" }];
    const first = await add(projectRoot, "Deleted study", { identifiers: doi });
    const dataset = { sourceKey: "dataset", type: "dataset" } as const;
    const kept = await add(projectRoot, "Deleted study", dataset);
    const other = NodePath.join(base, "other");
    await NodeFSP.mkdir(other);
    await initializeScientProject({ root: other });
    const second = await add(other, "Deleted study", { identifiers: doi });
    const contradicting = await add(other, "Deleted study", dataset);
    expect(second.sourceId).not.toBe(first.sourceId);
    await runScientLibraryMove({ library, projectRoot, actor: "user" });
    await deleteForGood(library, first.sourceId);

    await runScientLibraryMove({ library, projectRoot: other, actor: "user" });
    const live = [kept.sourceId, contradicting.sourceId].toSorted();
    const listed = async () =>
      (await listScientSourceRecords(library)).map((record) => record.sourceId).toSorted();
    expect(await listed()).toEqual(live);
    const pins = await resolveScientProjectPins({
      projectRoot: other,
      library,
      mode: "write",
      actor: "agent",
    });
    const pinned = pins.find(({ pin }) => pin.sourceId === second.sourceId);
    expect(pinned?.pin.work).toMatchObject({ title: "Deleted study", identifiers: doi });
    // The live datasets disagree with it, so the pin stays on its snapshot as contradicted.
    expect(pinned?.resolution).toMatchObject({ kind: "unresolved", reason: "contradicted" });
    expect(await listed()).toEqual(live);
  });

  it("an old copy's trash does not bring back a deleted source or its PDF", async () => {
    const { base, root, library, projectRoot } = await fixture();
    const source = await add(projectRoot, "Trashed study");
    const sha256 = await attach(projectRoot, source.sourceId, "trashed");
    const record = (await readScientSourceRecord(projectRoot, source.sourceId))!;
    await removeScientSource({
      root: projectRoot,
      sourceId: source.sourceId,
      expectedRevision: record.revision,
    });
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(projectRoot, copy, { recursive: true });
    await highlight(copy, sha256);
    await runScientLibraryMove({ library, projectRoot, actor: "user" });
    await deleteScientSourcesPermanently({ root: library });

    await runScientLibraryMove({ library, projectRoot: copy, actor: "user" });
    expect((await listScientSourceTrash(library)).entries).toEqual([]);
    expect(await inLibrary(root, sha256)).toBe(false);
  });

  it("a deleted source's PDF stays out of the library unless a kept source shares it", async () => {
    const { base, root, library, projectRoot } = await fixture();
    const source = await add(projectRoot, "Deleted study");
    const own = await attach(projectRoot, source.sourceId, "only the deleted study");
    const shared = await attach(projectRoot, source.sourceId, "shared");
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(projectRoot, copy, { recursive: true });
    await highlight(copy, own);
    const kept = await add(copy, "Kept study");
    expect(await attach(copy, kept.sourceId, "shared")).toBe(shared);
    await runScientLibraryMove({ library, projectRoot, actor: "user" });
    await deleteForGood(library, source.sourceId);
    expect(await inLibrary(root, shared)).toBe(false);

    await runScientLibraryMove({ library, projectRoot: copy, actor: "user" });
    expect((await listScientSourceRecords(library)).map((record) => record.sourceId)).toEqual([
      kept.sourceId,
    ]);
    expect(await inLibrary(root, own)).toBe(false);
    expect(await inLibrary(root, shared)).toBe(true);
  });
});
