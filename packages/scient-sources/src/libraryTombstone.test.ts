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
  deleteScientSourcesPermanently,
  deleteTrashedScientSource,
  importScientSource,
  listScientSourceRecords,
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

async function add(root: Parameters<typeof importScientSource>[0]["root"], title: string) {
  return (await importScientSource({
    root,
    operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    candidate: candidate(title),
    actor: "user",
    intake: "file",
  }))!.record!;
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
});
