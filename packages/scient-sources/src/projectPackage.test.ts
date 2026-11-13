// @effect-diagnostics nodeBuiltinImport:off -- Package tests move real folders between projects and Libraries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { organizeScientSources, readScientSourcesOrganization } from "./collections.ts";
import {
  listScientReviewConflicts,
  resolveScientReviewConflict,
} from "./libraryReviewConflicts.ts";
import { scientLibraryDistinctPairsPath } from "./libraryExclusions.ts";
import {
  keepScientProjectSourceSeparate,
  resolveScientProjectSources,
} from "./libraryInstanceMap.ts";
import { writeLibraryAliasesAt } from "./libraryAliases.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  changeScientLibraryReview,
  readScientLibraryReviewRecord,
  scientReviewSnapshotLimits,
} from "./libraryReviews.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  exportScientProjectPackage,
  listScientProjectPackageImports,
  importScientProjectPackage,
  ScientProjectPackageManifest,
  scientProjectPackageInternals,
  undoScientProjectPackageImport,
} from "./projectPackage.ts";
import {
  pinScientLibrarySource,
  readScientProjectPinNoteHistory,
  readScientProjectPins,
  setScientProjectPinNote,
} from "./projectPins.ts";
import {
  attachScientSourcePdf,
  deleteScientSourcesPermanently,
  importScientSource,
  listScientSourceRecords,
  listScientSourceTrash,
  readScientSourceRecord,
  readScientSourceTombstones,
  recordScientSourceCheck,
  removeScientSource,
  updateScientSourceMetadata,
} from "./store.ts";
import { editableMetadataFromRecord } from "./editable.ts";

vi.mock("node:fs/promises", { spy: true });

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function computer(base: string, name: string) {
  const root = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(root);
  return scientLibraryLocation(root);
}

async function project(base: string, name: string): Promise<string> {
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  return NodeFSP.realpath(root);
}

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-package-")),
  );
  fixtures.push(base);
  return { base, mine: await computer(base, "mine"), source: await project(base, "source") };
}

const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

function candidate(key: string, overrides: Partial<ScientSourceCandidate> = {}) {
  return {
    sourceKey: key,
    type: "article",
    customType: null,
    title: `Study ${key}`,
    creators: [ada],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [],
    abstract: null,
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
  } satisfies ScientSourceCandidate;
}

async function add(
  library: ScientLibraryLocation,
  key: string,
  overrides: Partial<ScientSourceCandidate> = {},
) {
  const imported = await importScientSource({
    root: library,
    operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    candidate: candidate(key, overrides),
    allowPossibleMetadataMatch: true,
  });
  return imported.record!;
}

async function pinned(library: ScientLibraryLocation, root: string, sourceId: string) {
  const result = await pinScientLibrarySource({
    projectRoot: root,
    library,
    sourceId,
    actor: "user",
  });
  if (result.outcome === "not-found") throw new Error("Expected a pin.");
  return result.pin;
}

async function withPdf(library: ScientLibraryLocation, base: string, sourceId: string) {
  const pdf = NodePath.join(base, `${sourceId}.pdf`);
  await NodeFSP.writeFile(pdf, `%PDF-1.7\n${sourceId}\n`);
  const record = (await listScientSourceRecords(library)).find(
    (entry) => entry.sourceId === sourceId,
  )!;
  return attachScientSourcePdf({
    root: library,
    sourceId,
    expectedRevision: record.revision,
    pdfPath: pdf,
  });
}

const exportTo = (root: string, library: ScientLibraryLocation, folder: string) =>
  exportScientProjectPackage({ projectRoot: root, library, relativePath: folder });

const importInto = (root: string, library: ScientLibraryLocation, folder: string) =>
  importScientProjectPackage({ projectRoot: root, library, folder, actor: "user" });

describe("importing a project package", () => {
  it("lists only this project's durable imports and keeps the full Undo report reachable", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "history");
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const theirs = await computer(base, "theirs");
    const received = await project(base, "received");
    const { projectId } = await readScientProjectIdentity(received);
    expect(await listScientProjectPackageImports({ library: theirs, projectId })).toEqual({
      imports: [],
      diagnostics: [],
    });
    const imported = await importInto(received, theirs, handoff);
    if (imported.outcome !== "imported") throw new Error("Expected import");
    await importInto(await project(base, "unrelated"), theirs, handoff);
    await withPdf(mine, base, paper.sourceId);
    const current = NodePath.join(base, "current-handoff");
    await exportTo(source, mine, current);
    const joined = await importInto(received, theirs, current);
    if (joined.outcome !== "imported") throw new Error("Expected joined import");
    const [pin] = await readScientProjectPins(received);
    await setScientProjectPinNote({
      projectRoot: received,
      citationKey: pin!.citationKey,
      note: "Written after import",
      base: null,
      actor: "user",
    });
    const before = (
      await listScientProjectPackageImports({ library: theirs, projectId })
    ).imports.find((entry) => entry.importId === imported.importId);
    expect(before).toMatchObject({
      importId: imported.importId,
      canUndo: true,
      added: { sources: 1, pins: 1 },
      failed: [],
    });
    const undone = await undoScientProjectPackageImport({
      projectRoot: received,
      projectId,
      library: theirs,
      importId: imported.importId,
      actor: "user",
    });
    if (undone.outcome !== "undone") throw new Error("Expected Undo");
    const joinedUndo = await undoScientProjectPackageImport({
      projectRoot: received,
      projectId,
      library: theirs,
      importId: joined.importId,
      actor: "user",
    });
    if (joinedUndo.outcome !== "undone") throw new Error("Expected joined Undo");
    expect(joinedUndo.left).toEqual([expect.stringMatching(/^PDF /u)]);
    const { imports: receipts } = await listScientProjectPackageImports({
      library: theirs,
      projectId,
    });
    expect(receipts).toHaveLength(2);
    const first = receipts.find((entry) => entry.importId === imported.importId);
    const second = receipts.find((entry) => entry.importId === joined.importId);
    expect(first).toMatchObject({
      canUndo: false,
      kept: undone.kept,
      left: undone.left,
      retainedSourceIds: undone.retainedSourceIds,
    });
    expect(first?.undoneAt).toBeTruthy();
    expect(first?.kept).toContain(`pin ${pin!.citationKey}`);
    expect(second).toMatchObject({ canUndo: false, left: joinedUndo.left });
  });

  it.each(["receipt", "paper"] as const)(
    "keeps healthy import history usable with a broken %s",
    async (broken) => {
      const { base, mine, source } = await setup();
      const paper = await add(mine, "history-corruption");
      await pinned(mine, source, paper.sourceId);
      const handoff = NodePath.join(base, "handoff");
      await exportTo(source, mine, handoff);
      const received = await project(base, "received");
      const theirs = await computer(base, "theirs");
      const imported = await importInto(received, theirs, handoff);
      if (imported.outcome !== "imported") throw new Error("Expected import");
      const joined = await importInto(received, theirs, handoff);
      if (joined.outcome !== "imported") throw new Error("Expected second import");
      const { projectId } = await readScientProjectIdentity(received);
      const importedPaper = (await listScientSourceRecords(theirs))[0]!;
      const badPath =
        broken === "receipt"
          ? NodePath.join(
              theirs.root,
              "package-imports",
              "import_00000000000000000000000000000000.json",
            )
          : NodePath.join(theirs.root, "records", `${importedPaper.sourceId}.json`);
      const bytes = broken === "paper" ? await NodeFSP.readFile(badPath) : null;
      await NodeFSP.writeFile(badPath, "{broken");
      const listed = await listScientProjectPackageImports({ library: theirs, projectId });
      expect(listed.imports).toHaveLength(2);
      expect(listed.imports.find((entry) => entry.importId === imported.importId)).toMatchObject({
        canUndo: true,
        added: { pins: 1 },
      });
      expect(listed.diagnostics).toEqual([
        expect.stringContaining(
          broken === "receipt"
            ? "import_00000000000000000000000000000000.json"
            : importedPaper.sourceId,
        ),
      ]);
      if (broken === "paper") {
        expect(
          listed.imports.find((entry) => entry.importId === imported.importId)?.retainedSourceIds,
        ).toEqual([]);
        await NodeFSP.writeFile(badPath, bytes!);
      } else {
        // Listing is tolerant; Undo must still stop when another receipt cannot be checked.
        await expect(
          undoScientProjectPackageImport({
            projectRoot: received,
            projectId,
            library: theirs,
            importId: imported.importId,
            actor: "user",
          }),
        ).rejects.toThrow();
        await NodeFSP.unlink(badPath);
      }
      expect(
        await undoScientProjectPackageImport({
          projectRoot: received,
          projectId,
          library: theirs,
          importId: joined.importId,
          actor: "user",
        }),
      ).toMatchObject({ outcome: "undone" });
      expect(
        await undoScientProjectPackageImport({
          projectRoot: received,
          projectId,
          library: theirs,
          importId: imported.importId,
          actor: "user",
        }),
      ).toMatchObject({ outcome: "undone" });
      expect(await readScientProjectPins(received)).toEqual([]);
    },
  );

  it.each(["proposal", "doi-fallback"] as const)(
    "honors project Keep separate after facts agree through the %s path",
    async (path) => {
      const { base, mine, source } = await setup();
      const identifiers = [{ scheme: "doi", value: "10.1000/kept-separate" }];
      const paper = await add(mine, "paper", { title: "Shared paper", identifiers });
      await withPdf(mine, base, paper.sourceId);
      await pinned(mine, source, paper.sourceId);
      const handoff = NodePath.join(base, "handoff");
      await exportTo(source, mine, handoff);
      const theirs = await computer(base, "theirs");
      const received = await project(base, "received");
      const target = await add(theirs, "target", { title: "Other title", identifiers });
      const rejectedId = "src_rejected_alias";
      await keepScientProjectSourceSeparate({
        library: theirs,
        projectRoot: received,
        projectSourceId: paper.sourceId,
        sourceIds: [rejectedId],
        separate: true,
        actor: "user",
      });
      const alias = (sourceId: string) => ({
        sourceId,
        survivorId: target.sourceId,
        mergeId: "merge_test",
        mergedAt: "2026-11-13T00:00:00.000Z",
      });
      await withScientLibraryLock(theirs.root, () =>
        writeLibraryAliasesAt(
          theirs.root,
          new Map([
            [rejectedId, alias(rejectedId)],
            ...(path === "proposal" ? [[paper.sourceId, alias(paper.sourceId)] as const] : []),
          ]),
        ),
      );
      await updateScientSourceMetadata({
        root: theirs,
        sourceId: target.sourceId,
        expectedRevision: target.revision,
        metadata: { ...editableMetadataFromRecord(target), title: paper.title },
      });
      expect(await importInto(received, theirs, handoff)).toMatchObject({
        sources: { added: 1, matched: 0 },
        pdfs: { added: 1 },
        failed: [],
      });
      expect((await readScientSourceRecord(theirs, target.sourceId))?.attachments).toEqual([]);
      const [resolution] = await resolveScientProjectSources({
        library: theirs,
        projectRoot: received,
        mode: "read",
        sources: [{ projectSourceId: paper.sourceId, work: paper }],
      });
      if (resolution?.kind !== "resolved") throw new Error("Expected the imported paper.");
      expect(resolution.sourceId).not.toBe(target.sourceId);
    },
  );

  it.each(["deleted", "reimported"] as const)(
    "resolves a sparse package source as %s in a fresh checkout",
    async (state) => {
      const { base, mine, source } = await setup();
      const sparse = {
        title: "Sparse paper",
        creators: [],
        issuedRaw: null,
        issuedYear: null,
        containerTitle: null,
      };
      const paper = await add(mine, "sparse", sparse);
      await pinned(mine, source, paper.sourceId);
      const handoff = NodePath.join(base, "handoff");
      await exportTo(source, mine, handoff);
      const theirs = await computer(base, "theirs");
      const received = await project(base, "received");
      const collision =
        state === "reimported"
          ? await add(theirs, `project-package:${paper.sourceId}`, { title: "Different work" })
          : null;
      expect(await importInto(received, theirs, handoff)).toMatchObject({ sources: { added: 1 } });
      const imported = (await listScientSourceRecords(theirs)).find(
        (record) => record.sourceId !== collision?.sourceId,
      )!;
      await removeScientSource({
        root: theirs,
        sourceId: imported.sourceId,
        expectedRevision: imported.revision,
      });
      await deleteScientSourcesPermanently({ root: theirs });
      let liveId: string | undefined;
      if (state === "reimported") {
        expect(await importInto(received, theirs, handoff)).toMatchObject({
          sources: { added: 1 },
        });
        liveId = (await listScientSourceRecords(theirs)).find(
          (record) => record.sourceId !== collision?.sourceId,
        )!.sourceId;
      }
      const before = (await listScientSourceRecords(theirs))
        .map((record) => record.sourceId)
        .toSorted();
      const fresh = NodePath.join(base, "fresh");
      await NodeFSP.cp(source, fresh, { recursive: true });
      const [resolution] = await resolveScientProjectSources({
        library: theirs,
        projectRoot: fresh,
        mode: "write",
        hydrate: { actor: "user" },
        sources: [{ projectSourceId: paper.sourceId, work: paper }],
      });
      expect(resolution).toMatchObject(
        state === "deleted"
          ? { kind: "unresolved", reason: "removed", candidateIds: [imported.sourceId] }
          : { kind: "resolved", sourceId: liveId },
      );
      expect(
        (await listScientSourceRecords(theirs)).map((record) => record.sourceId).toSorted(),
      ).toEqual(before);
      expect((await readScientSourceTombstones(theirs))[0]?.record).toMatchObject({
        hydratedFromProjectSourceId: paper.sourceId,
      });
    },
  );

  it("refuses a staged PDF replaced before its attachment reference is committed", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "replaced-stage");
    const pdf = await withPdf(mine, base, paper.sourceId);
    const attachment = pdf.record.attachments[0]!;
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const theirs = await computer(base, "theirs");
    const result = await importScientProjectPackage({
      projectRoot: await project(base, "received"),
      library: theirs,
      folder: handoff,
      actor: "user",
      afterTargetCheck: async () => {
        const blob = NodePath.join(theirs.root, ...attachment.relativePath.split("/"));
        const replacement = `${blob}.replacement`;
        await NodeFSP.writeFile(replacement, Buffer.alloc(attachment.byteLength));
        await NodeFSP.rename(replacement, blob);
      },
    });
    expect(result).toMatchObject({
      pdfs: { added: 0 },
      failed: [
        expect.objectContaining({
          part: "pdf",
          message: "The staged source PDF changed before it could be attached.",
        }),
      ],
    });
    expect((await listScientSourceRecords(theirs))[0]!.attachments).toHaveLength(0);
  });

  it("lets an unrelated Library writer finish while a PDF staging copy is blocked", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "blocked-copy");
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const theirs = await computer(base, "theirs");
    const unrelated = await add(theirs, "unrelated");
    const received = await project(base, "received");
    const copying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { open } = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    using _blocked = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(NodePath.join(theirs.root, "staging")) && args[1] === "wx") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          copying.resolve();
          await release.promise;
          return write(...writeArgs);
        };
      }
      return handle;
    });
    const importing = importInto(received, theirs, handoff);
    try {
      await copying.promise;
      await withScientLibraryLock(
        theirs.root,
        async () => {
          expect(
            await updateScientSourceMetadata({
              root: theirs,
              sourceId: unrelated.sourceId,
              expectedRevision: unrelated.revision,
              metadata: {
                ...editableMetadataFromRecord(unrelated),
                title: "Edited during staging",
              },
            }),
          ).toMatchObject({ outcome: "updated" });
        },
        { timeoutMs: 0 },
      );
    } finally {
      release.resolve();
      expect(await importing).toMatchObject({ pdfs: { added: 1 }, failed: [] });
    }
  });

  it("never opens an unlisted PDF through a linked parent outside the package", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "unlisted");
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const manifest: ScientProjectPackageManifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(handoff, "manifest.json"), "utf8"),
    );
    const pdf = manifest.files.find((file) => file.path.startsWith("pdfs/"))!;
    await NodeFSP.writeFile(
      NodePath.join(handoff, "manifest.json"),
      JSON.stringify({ ...manifest, files: manifest.files.filter((file) => file !== pdf) }),
    );
    const outside = NodePath.join(base, "outside");
    await NodeFSP.rename(NodePath.join(handoff, "pdfs"), outside);
    await NodeFSP.symlink(outside, NodePath.join(handoff, "pdfs"), "junction");
    const theirs = await computer(base, "theirs");
    expect(await importInto(await project(base, "received"), theirs, handoff)).toMatchObject({
      outcome: "imported",
      pdfs: { added: 0 },
      unavailable: [
        expect.objectContaining({ kind: "pdf", sha256: NodePath.basename(pdf.path, ".pdf") }),
      ],
    });
    expect((await listScientSourceRecords(theirs))[0]!.attachments).toHaveLength(0);
    expect(
      await NodeFSP.stat(NodePath.join(theirs.root, "files", "sha256")).catch(() => null),
    ).toBeNull();
  });

  it("checks a target found by its ID or an earlier mapping before joining it", async () => {
    const { base, mine, source } = await setup();
    const doi = { scheme: "doi", value: "10.1000/paper" };
    const paper = await add(mine, "paper", { title: "Shared paper", identifiers: [doi] });
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const correct = async (library: ScientLibraryLocation, sourceId: string, title: string) => {
      const record = (await listScientSourceRecords(library)).find(
        (entry) => entry.sourceId === sourceId,
      )!;
      await updateScientSourceMetadata({
        root: library,
        sourceId,
        expectedRevision: record.revision,
        metadata: {
          ...editableMetadataFromRecord(record),
          title,
          identifiers: [{ scheme: "doi", value: `10.1000/${sourceId}` }],
        },
      });
    };

    // A copy of this Library where the same ID now names another work.
    const copied = scientLibraryLocation(NodePath.join(base, "copied"));
    await NodeFSP.cp(mine.root, copied.root, { recursive: true });
    await correct(copied, paper.sourceId, "A different work");
    expect(await importInto(await project(base, "one"), copied, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
      pdfs: { added: 1 },
    });
    expect(
      (await listScientSourceRecords(copied)).find((entry) => entry.sourceId === paper.sourceId)
        ?.attachments,
    ).toHaveLength(1);

    // A target this project mapped on an earlier import, corrected since to another work.
    const theirs = await computer(base, "theirs");
    const received = await project(base, "received");
    await importInto(received, theirs, handoff);
    const [mapped] = await listScientSourceRecords(theirs);
    await correct(theirs, mapped!.sourceId, "Another work entirely");
    expect(await importInto(received, theirs, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
    });
    expect(await listScientSourceRecords(theirs)).toHaveLength(2);
  });

  it("never joins a paper kept apart from it, nor one corrected before anything is written", async () => {
    const { base, mine, source } = await setup();
    const doi = { scheme: "doi", value: "10.1000/paper" };
    const paper = await add(mine, "paper", { title: "Shared paper", identifiers: [doi] });
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    // Title, type and DOI agree, but this Library marked the two Not duplicates.
    const theirs = await computer(base, "theirs");
    const apart = await add(theirs, "apart", { title: "Shared paper", identifiers: [doi] });
    await NodeFSP.writeFile(
      scientLibraryDistinctPairsPath(theirs.root),
      JSON.stringify({
        formatVersion: 1,
        pairs: [
          {
            sourceIds: [paper.sourceId, apart.sourceId],
            reason: "marked-distinct",
            markedAt: "2026-11-01T00:00:00.000Z",
            markedBy: "user",
          },
        ],
      }),
    );
    expect(await importInto(await project(base, "received"), theirs, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
      pdfs: { added: 1 },
    });
    expect((await readScientSourceRecord(theirs, apart.sourceId))?.attachments).toEqual([]);

    // A paper that agrees when checked is corrected to another work before anything is written.
    const later = await computer(base, "later");
    const target = await add(later, "target", { title: "Shared paper", identifiers: [doi] });
    const corrected = await project(base, "corrected");
    expect(
      await importScientProjectPackage({
        projectRoot: corrected,
        library: later,
        folder: handoff,
        actor: "user",
        afterTargetCheck: async (sourceId) => {
          const record = (await readScientSourceRecord(later, sourceId))!;
          await updateScientSourceMetadata({
            root: later,
            sourceId,
            expectedRevision: record.revision,
            metadata: {
              ...editableMetadataFromRecord(record),
              title: "Another work",
              identifiers: [{ scheme: "doi", value: "10.1000/another" }],
            },
          });
        },
      }),
    ).toMatchObject({
      sources: { added: 0, matched: 0 },
      pdfs: { added: 0 },
      failed: [{ part: "source", item: paper.sourceId }],
    });
    expect((await readScientSourceRecord(later, target.sourceId))?.attachments).toEqual([]);
    const [resolution] = await resolveScientProjectSources({
      library: later,
      projectRoot: corrected,
      mode: "read",
      sources: [{ projectSourceId: paper.sourceId, work: null }],
    });
    expect(resolution?.kind).toBe("unresolved");
  });

  it("never takes title likeness for identity, so a PDF lands on its own work", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper", { title: "Shared title" });
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    // Another computer holds a different work with the same title, lead author and year.
    const theirs = await computer(base, "theirs");
    const lookalike = await add(theirs, "lookalike", { title: "Shared title" });
    const received = await project(base, "received");
    expect(await importInto(received, theirs, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
      pdfs: { added: 1 },
    });
    const records = await listScientSourceRecords(theirs);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.sourceId === lookalike.sourceId)?.attachments).toEqual(
      [],
    );
  });

  it("joins another copy's note history and pins written meanwhile, under one lock", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper");
    const key = (await pinned(mine, source, paper.sourceId)).citationKey;
    const note = (text: string, base: string | null, root = source) =>
      setScientProjectPinNote({
        projectRoot: root,
        citationKey: key,
        note: text,
        base,
        actor: "agent",
      });
    await note("A", null);
    // A collaborator's copy branches here, then each side goes on.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(source, copy, { recursive: true });
    await note("B", "A");
    await note("C", "B");
    await note("D", "A", copy);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    expect(await importInto(copy, mine, handoff)).toMatchObject({
      pins: { notesKept: 1, historyAdded: 2 },
    });
    const history = await readScientProjectPinNoteHistory({ projectRoot: copy, citationKey: key });
    expect(history?.map((version) => version.note)).toEqual(["A", "B", "C", "D"]);
    expect(history?.at(-1)).toMatchObject({ note: "D", by: "agent" });

    // A project with no pins yet: another window writes the first one just before the import
    // gets the project's pins lock. Both pins stay.
    const fresh = await project(base, "fresh");
    const imported = await importScientProjectPackage({
      projectRoot: fresh,
      library: mine,
      folder: handoff,
      actor: "user",
      afterPinsLock: async () => {
        const file = JSON.parse(
          await NodeFSP.readFile(NodePath.join(source, ".scient/library/pins.json"), "utf8"),
        );
        file.pins = [{ ...file.pins[0], sourceId: "src_meanwhile", citationKey: "meanwhile" }];
        await NodeFSP.writeFile(
          NodePath.join(fresh, ".scient/library/pins.json"),
          `${JSON.stringify(file, null, 2)}\n`,
        );
      },
    });
    expect(imported).toMatchObject({ pins: { added: 1, addedKeys: [key] } });
    expect((await readScientProjectPins(fresh)).map((pin) => pin.citationKey).toSorted()).toEqual(
      [key, "meanwhile"].toSorted(),
    );
  });

  it("keeps both of two highlight branches that changed apart", () => {
    const { joinAnnotationFiles } = scientProjectPackageInternals;
    const mark = (revision: number, note: string) => ({
      annotationId: "ann_1",
      revision,
      anchor: { page: 1 },
      highlighted: true,
      note,
      updatedAt: `2026-11-0${revision}T00:00:00.000Z`,
      updatedBy: "user",
      deletedAt: null,
    });
    const entry = (revision: number, note: string) => {
      const { anchor: _anchor, deletedAt: _deleted, ...rest } = mark(revision, note);
      return rest;
    };
    const file = (current: ReturnType<typeof mark>, history: ReadonlyArray<object>) => ({
      formatVersion: 1,
      material: { sha256: "0".repeat(64), byteLength: 1 },
      paths: [],
      annotations: [current],
      history,
    });
    const notesOf = (joined: { file: Record<string, unknown> }) => ({
      current: (joined.file["annotations"] as Array<{ note: string; revision: number }>)[0],
      history: (joined.file["history"] as Array<{ note: string }>).map((version) => version.note),
    });

    // Both reached revision 2 from "a", with different notes.
    const equal = scientProjectPackageInternals.joinAnnotationFiles(
      file(mark(2, "here"), [entry(1, "a")]),
      file(mark(2, "there"), [entry(1, "a")]),
      "2026-11-13T00:00:00.000Z",
    );
    expect(equal.conflicts).toBe(1);
    expect(notesOf(equal)).toMatchObject({ current: { note: "here", revision: 3 } });
    expect(notesOf(equal).history).toEqual(expect.arrayContaining(["a", "there"]));
    // Marked as brought, so the reader offers it.
    expect(
      (equal.file["history"] as Array<{ note: string; importedAt?: string }>).find(
        (version) => version.note === "there",
      )?.importedAt,
    ).toBe("2026-11-13T00:00:00.000Z");

    // The other went further, but not from this Library's note.
    const higher = joinAnnotationFiles(
      file(mark(2, "here"), [entry(1, "a")]),
      file(mark(3, "there"), [entry(1, "a"), entry(2, "b")]),
      "2026-11-13T00:00:00.000Z",
    );
    expect(notesOf(higher)).toMatchObject({ current: { note: "here", revision: 4 } });
    expect(notesOf(higher).history).toEqual(expect.arrayContaining(["a", "b", "there"]));

    // The other went on from this Library's note: it simply wins.
    const ahead = joinAnnotationFiles(
      file(mark(2, "here"), [entry(1, "a")]),
      file(mark(3, "there"), [entry(1, "a"), entry(2, "here")]),
      "2026-11-13T00:00:00.000Z",
    );
    expect(ahead.conflicts).toBe(0);
    expect(notesOf(ahead).current).toMatchObject({ note: "there", revision: 3 });
  });

  it("carries a retraction notice and a structured abstract as brought, not checked here", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper", {
      identifiers: [{ scheme: "doi", value: "10.1000/retracted" }],
      abstractSections: [
        { title: "Background", paragraphs: ["Why."] },
        { title: "Results", paragraphs: ["What."] },
      ],
    });
    await recordScientSourceCheck({
      root: mine,
      sourceId: paper.sourceId,
      expectedRevision: paper.revision,
      verification: { state: "verified", checkedAt: "2026-11-01T00:00:00.000Z" },
      editorialStatus: {
        state: "retracted",
        notices: [{ kind: "retraction", doi: "10.1000/notice" }],
        checkedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const theirs = await computer(base, "theirs");
    await importInto(await project(base, "received"), theirs, handoff);
    const [record] = await listScientSourceRecords(theirs);
    expect(record?.editorialStatus).toMatchObject({
      state: "retracted",
      checkedAt: "2026-11-01T00:00:00.000Z",
      carriedAt: expect.any(String),
    });
    expect(record?.verification).toMatchObject({
      state: "verified",
      carriedAt: expect.any(String),
    });
    expect(record?.abstractSections?.map((section) => section.title)).toEqual([
      "Background",
      "Results",
    ]);
  });

  it("brings a retraction and an abstract to a paper this computer checked as clear", async () => {
    const { base, mine, source } = await setup();
    const doi = { scheme: "doi", value: "10.1000/retracted" };
    const paper = await add(mine, "paper", { identifiers: [doi], abstract: "Why it matters." });
    await recordScientSourceCheck({
      root: mine,
      sourceId: paper.sourceId,
      expectedRevision: paper.revision,
      verification: { state: "verified", checkedAt: "2026-11-05T00:00:00.000Z" },
      editorialStatus: {
        state: "retracted",
        notices: [{ kind: "retraction", doi: "10.1000/notice" }],
        checkedAt: "2026-11-05T00:00:00.000Z",
      },
    });
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    const theirs = await computer(base, "theirs");
    const local = await add(theirs, "local", { title: paper.title, identifiers: [doi] });
    await recordScientSourceCheck({
      root: theirs,
      sourceId: local.sourceId,
      expectedRevision: local.revision,
      verification: { state: "verified", checkedAt: "2026-11-01T00:00:00.000Z" },
      editorialStatus: { state: "none", notices: [], checkedAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(await importInto(await project(base, "received"), theirs, handoff)).toMatchObject({
      sources: { added: 0, matched: 1 },
    });
    const [record] = await listScientSourceRecords(theirs);
    expect(record?.editorialStatus).toMatchObject({
      state: "retracted",
      notices: [{ kind: "retraction", doi: "10.1000/notice" }],
      carriedAt: expect.any(String),
    });
    // This computer's own check stays its own.
    expect(record?.verification).toEqual({
      state: "verified",
      checkedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(record?.abstract).toBe("Why it matters.");

    // Checked clear there, never checked here: that clear check comes along.
    const clearDoi = { scheme: "doi", value: "10.1000/clear" };
    const clear = await add(mine, "clear", { identifiers: [clearDoi] });
    await recordScientSourceCheck({
      root: mine,
      sourceId: clear.sourceId,
      expectedRevision: clear.revision,
      verification: { state: "verified", checkedAt: "2026-11-05T00:00:00.000Z" },
      editorialStatus: { state: "none", notices: [], checkedAt: "2026-11-05T00:00:00.000Z" },
    });
    const clearProject = await project(base, "clear-project");
    await pinned(mine, clearProject, clear.sourceId);
    const clearHandoff = NodePath.join(base, "clear-handoff");
    await exportTo(clearProject, mine, clearHandoff);
    const unchecked = await add(theirs, "unchecked", {
      title: clear.title,
      identifiers: [clearDoi],
    });
    expect(
      await importInto(await project(base, "received-clear"), theirs, clearHandoff),
    ).toMatchObject({ sources: { added: 0, matched: 1 }, failed: [] });
    expect(
      (await readScientSourceRecord(theirs, unchecked.sourceId))?.editorialStatus,
    ).toMatchObject({ state: "none", carriedAt: expect.any(String) });
  });

  it("keeps collection ancestry, so two Methods folders stay apart", async () => {
    const { base, mine, source } = await setup();
    const trial = await add(mine, "trial");
    const overview = await add(mine, "overview");
    for (const record of [trial, overview]) await pinned(mine, source, record.sourceId);
    const make = async (name: string, parentCollectionId?: string, sourceIds: string[] = []) =>
      (
        await organizeScientSources({
          root: mine,
          change: {
            action: "create-collection",
            name,
            sourceIds,
            ...(parentCollectionId ? { parentCollectionId } : {}),
          },
          actor: "user",
        })
      ).collection!.collectionId;
    await make("Methods", await make("Trials"), [trial.sourceId]);
    await make("Methods", await make("Reviews"), [overview.sourceId]);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    const theirs = await computer(base, "theirs");
    await importInto(await project(base, "received"), theirs, handoff);
    const { collections } = await readScientSourcesOrganization(theirs);
    const titleOf = new Map(
      (await listScientSourceRecords(theirs)).map((record) => [record.sourceId, record.title]),
    );
    const path = (collectionId: string | undefined): string => {
      const collection = collections.find((entry) => entry.collectionId === collectionId)!;
      return collection.parentCollectionId
        ? `${path(collection.parentCollectionId)}/${collection.name}`
        : collection.name;
    };
    expect(
      collections
        .filter((collection) => collection.sourceIds.length > 0)
        .map((collection) => [
          path(collection.collectionId),
          collection.sourceIds.map((id) => titleOf.get(id)),
        ])
        .toSorted(),
    ).toEqual([
      ["Reviews/Methods", ["Study overview"]],
      ["Trials/Methods", ["Study trial"]],
    ]);
  });

  it("reconciles snapshots apart from decisions, and reports a review it could not copy", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper");
    await pinned(mine, source, paper.sourceId);
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: { action: "create-review", title: "Screening" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: {
        action: "log-search",
        reviewId: reviewId!,
        database: "PubMed",
        query: "q",
        searchedOn: "2026-11-01",
        sourceIds: [paper.sourceId],
      },
      actor: "user",
    });
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const reviews = (root: string) => NodePath.join(root, ".scient/library/reviews");
    const snapshot = (root: string) => NodePath.join(reviews(root), `${reviewId}.works.json`);

    // The same decisions, but this copy lost its snapshot: it is added back.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(source, copy, { recursive: true });
    await NodeFSP.rm(snapshot(copy));
    expect(await importInto(copy, mine, handoff)).toMatchObject({
      reviews: { added: 0, conflicts: 0, snapshotsAdded: 1 },
    });
    expect(await NodeFSP.readFile(snapshot(copy), "utf8")).toBe(
      await NodeFSP.readFile(snapshot(source), "utf8"),
    );
    // The same decisions with another snapshot: the package's is kept as another version.
    await NodeFSP.writeFile(snapshot(copy), `${await NodeFSP.readFile(snapshot(copy), "utf8")} `);
    expect(await importInto(copy, mine, handoff)).toMatchObject({ reviews: { conflicts: 1 } });

    // A review that cannot be written is reported, never counted, and not half published.
    const blocked = await project(base, "blocked");
    await NodeFSP.mkdir(snapshot(blocked), { recursive: true });
    const result = await importInto(blocked, mine, handoff);
    expect(result).toMatchObject({
      reviews: { added: 0 },
      failed: [{ part: "review", item: reviewId }],
    });
    expect(await NodeFSP.readdir(reviews(blocked))).toEqual([`${reviewId}.works.json`]);
  });

  it("keeps a sharded snapshot's version sharded and readable, and choosing it loses no record", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper", { title: "Snapshot-only study" });
    await pinned(mine, source, paper.sourceId);
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: { action: "create-review", title: "Screening" },
      actor: "user",
    });
    // Another copy of the project, from before the search was logged.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(source, copy, { recursive: true });
    // Every snapshot from here on is past the size where one file becomes shards.
    const threshold = scientReviewSnapshotLimits.shardThresholdBytes;
    scientReviewSnapshotLimits.shardThresholdBytes = 64;
    try {
      await changeScientLibraryReview({
        projectRoot: source,
        library: mine,
        change: {
          action: "log-search",
          reviewId: reviewId!,
          database: "PubMed",
          query: "q",
          searchedOn: "2026-11-01",
          sourceIds: [paper.sourceId],
        },
        actor: "user",
      });
      const handoff = NodePath.join(base, "handoff");
      await exportTo(source, mine, handoff);

      const theirs = await computer(base, "theirs");
      expect(await importInto(copy, theirs, handoff)).toMatchObject({ reviews: { conflicts: 1 } });
      const kept = NodePath.join(copy, ".scient/library/conflicts/reviews", reviewId!);
      expect((await NodeFSP.readdir(kept)).filter((name) => name.includes(".works"))).toEqual([
        expect.stringMatching(/^[0-9a-f]{12}\.works$/u),
      ]);
      // The source is not in this Library: only the kept snapshot knows it.
      for (const record of await listScientSourceRecords(theirs)) {
        await removeScientSource({
          root: theirs,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
        });
      }
      const [conflict] = await listScientReviewConflicts({
        projectRoot: copy,
        reviewId: reviewId!,
      });
      expect(
        await resolveScientReviewConflict({
          projectRoot: copy,
          library: theirs,
          reviewId: reviewId!,
          conflictId: conflict!.conflictId,
          pick: "use-other",
          actor: "user",
        }),
      ).toMatchObject({ outcome: "resolved" });
      const reviews = await NodeFSP.readdir(NodePath.join(copy, ".scient/library/reviews"));
      expect(reviews.filter((name) => name.startsWith(`${reviewId}.works`))).toEqual([
        `${reviewId}.works`,
      ]);
      expect(
        await readScientLibraryReviewRecord({
          projectRoot: copy,
          library: theirs,
          mode: "read",
          reviewId: reviewId!,
          sourceId: paper.sourceId,
        }),
      ).toMatchObject({ from: "snapshot", record: { title: "Snapshot-only study" } });
    } finally {
      scientReviewSnapshotLimits.shardThresholdBytes = threshold;
    }
  });

  it("Undo keeps imported papers and PDFs used by another project", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper");
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    await organizeScientSources({
      root: mine,
      change: { action: "create-collection", name: "Methods", sourceIds: [paper.sourceId] },
      actor: "user",
    });
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    expect(await NodeFSP.readFile(NodePath.join(handoff, "README.md"), "utf8")).toContain(
      '"import-package"',
    );

    const theirs = await computer(base, "theirs");
    const received = await project(base, "received");
    const kept = await add(theirs, "kept");
    const imported = await importInto(received, theirs, handoff);
    if (imported.outcome !== "imported") throw new Error("Expected an import.");
    const { projectId } = JSON.parse(
      await NodeFSP.readFile(NodePath.join(received, ".scient/project.json"), "utf8"),
    );
    const undo = () =>
      undoScientProjectPackageImport({
        projectRoot: received,
        projectId,
        library: theirs,
        importId: imported.importId,
        actor: "user",
      });
    const importedPaper = (await listScientSourceRecords(theirs)).find(
      (record) => record.sourceId !== kept.sourceId,
    )!;
    const projectB = await project(base, "project-b");
    await pinned(theirs, projectB, importedPaper.sourceId);
    expect(await undo()).toMatchObject({
      outcome: "undone",
      retainedSourceIds: [importedPaper.sourceId],
    });
    expect(await readScientProjectPins(received)).toEqual([]);
    const [pinB] = await readScientProjectPins(projectB);
    const [inB] = await resolveScientProjectSources({
      projectRoot: projectB,
      library: theirs,
      mode: "read",
      sources: [{ projectSourceId: pinB!.sourceId, work: pinB!.work }],
    });
    expect(inB?.kind).toBe("resolved");
    expect(inB?.kind === "resolved" && inB.sourceId).toBe(importedPaper.sourceId);
    const live = await readScientSourceRecord(theirs, importedPaper.sourceId);
    expect(live?.attachments).toHaveLength(1);
    expect(
      await NodeFSP.readFile(
        NodePath.join(theirs.root, live!.attachments[0]!.relativePath),
        "utf8",
      ),
    ).toContain("%PDF");
    expect(await listScientSourceRecords(theirs)).toHaveLength(2);
    expect((await listScientSourceTrash(theirs)).entries).toHaveLength(0);
    expect((await readScientSourcesOrganization(theirs)).collections).toEqual([]);
    expect(await undo()).toEqual({ outcome: "already-undone" });
  });

  it("Undo removes only what the import created, as its own writes left it", async () => {
    const { base, mine, source } = await setup();
    const edited = await add(mine, "edited");
    const noted = await add(mine, "noted");
    const doi = { scheme: "doi", value: "10.1000/shared" };
    const shared = await add(mine, "shared", { identifiers: [doi] });
    await withPdf(mine, base, shared.sourceId);
    const second = NodePath.join(base, "second.pdf");
    await NodeFSP.writeFile(second, "%PDF-1.7\nsecond\n");
    await attachScientSourcePdf({
      root: mine,
      sourceId: shared.sourceId,
      expectedRevision: shared.revision + 1,
      pdfPath: second,
    });
    for (const record of [edited, noted, shared]) await pinned(mine, source, record.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const projectIdOf = async (root: string) =>
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, ".scient/project.json"), "utf8"))
        .projectId as string;
    const undoOf = async (
      root: string,
      library: ScientLibraryLocation,
      imported: Awaited<ReturnType<typeof importInto>>,
    ) => {
      if (imported.outcome !== "imported") throw new Error("Expected an import.");
      return undoScientProjectPackageImport({
        projectRoot: root,
        projectId: await projectIdOf(root),
        library,
        importId: imported.importId,
        actor: "user",
      });
    };

    // A paper here gets both PDFs; a created paper is edited before the receipt is written, and a
    // created pin's note changes after.
    const theirs = await computer(base, "theirs");
    const local = await add(theirs, "local", { title: shared.title, identifiers: [doi] });
    const received = await project(base, "received");
    const imported = await importScientProjectPackage({
      projectRoot: received,
      library: theirs,
      folder: handoff,
      actor: "user",
      afterPinsLock: async () => {
        const record = (await listScientSourceRecords(theirs)).find(
          (entry) => entry.title === edited.title,
        )!;
        await updateScientSourceMetadata({
          root: theirs,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
          metadata: { ...editableMetadataFromRecord(record), pages: "1-9" },
        });
      },
    });
    expect(imported).toMatchObject({ sources: { added: 2, matched: 1 }, pdfs: { added: 2 } });
    const editedHere = (await listScientSourceRecords(theirs)).find(
      (record) => record.title === edited.title,
    )!;
    const notedHere = (await listScientSourceRecords(theirs)).find(
      (record) => record.title === noted.title,
    )!;
    const notedPin = (await readScientProjectPins(received)).find(
      (pin) => pin.work.title === noted.title,
    )!;
    await setScientProjectPinNote({
      projectRoot: received,
      citationKey: notedPin.citationKey,
      note: "Mine now",
      actor: "user",
    });
    const result = await undoOf(received, theirs, imported);
    if (result.outcome !== "undone") throw new Error("Expected Undo.");
    expect(result.kept.toSorted()).toEqual([`pin ${notedPin.citationKey}`]);
    expect(result.left.filter((entry) => entry.startsWith("PDF "))).toHaveLength(2);
    const after = await listScientSourceRecords(theirs);
    expect(after.map((record) => record.sourceId).toSorted()).toEqual(
      [editedHere.sourceId, notedHere.sourceId, local.sourceId].toSorted(),
    );
    expect(after.find((record) => record.sourceId === local.sourceId)?.attachments).toHaveLength(2);
    expect(await readScientProjectPins(received)).toMatchObject([
      { citationKey: notedPin.citationKey, note: "Mine now" },
    ]);

    // Another project's later import reuses what this one created: Undo keeps those papers.
    const other = await computer(base, "other");
    const first = await project(base, "first");
    const firstImport = await importInto(first, other, handoff);
    expect(await importInto(await project(base, "second"), other, handoff)).toMatchObject({
      sources: { added: 0, matched: 3 },
    });
    const undone = await undoOf(first, other, firstImport);
    expect(undone.outcome === "undone" && undone.retainedSourceIds).toHaveLength(3);
    expect(await listScientSourceRecords(other)).toHaveLength(3);
    expect(await readScientProjectPins(first)).toEqual([]);
  });
});
