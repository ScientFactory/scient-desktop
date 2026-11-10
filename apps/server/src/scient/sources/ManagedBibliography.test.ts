// @effect-diagnostics nodeBuiltinImport:off -- Managed bibliography tests exercise real project files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  importScientSource,
  readScientSourceRecord,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { syncManagedBibliography } from "./ManagedBibliography.ts";
import { syncManagedBibliographyWithImports } from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bibliography-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

function candidate(sourceKey: string, title: string): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "1843",
    issuedYear: 1843,
    identifiers: [],
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
}

async function add(root: string, sourceKey: string, title: string) {
  await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: candidate(sourceKey, title),
  });
}

const read = (root: string, name: string) => NodeFSP.readFile(NodePath.join(root, name), "utf8");

describe("managed bibliography", () => {
  it("writes nothing for a project without a Library", async () => {
    const root = await project();
    const status = await syncManagedBibliography(root);
    expect(status.files.map((file) => file.state)).toEqual(["absent", "absent"]);
    await expect(NodeFSP.access(NodePath.join(root, "references.bib"))).rejects.toThrow();
  });

  it("writes both files from the Library and keeps them current", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");

    expect((await syncManagedBibliography(root)).files.map((file) => file.state)).toEqual([
      "current",
      "current",
    ]);
    expect(await read(root, "references.bib")).toContain("@article{lovelace1843notes,");
    expect(JSON.parse(await read(root, "references.json"))).toMatchObject([
      { id: "lovelace1843notes", type: "article-journal" },
    ]);

    await add(root, "B", "Sketch of the engine");
    const status = await syncManagedBibliography(root);
    expect(status.citedSourceCount).toBe(2);
    expect(await read(root, "references.bib")).toContain("@article{lovelace1843sketch,");
  });

  it("keeps a hand edit, reports it, and replaces it only when asked", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");
    await syncManagedBibliography(root);
    const bibPath = NodePath.join(root, "references.bib");
    const edited = `${await read(root, "references.bib")}\n@misc{mine2020,\n  title = {Mine},\n}\n`;
    await NodeFSP.writeFile(bibPath, edited);
    await add(root, "B", "Sketch of the engine");

    const status = await syncManagedBibliography(root);
    expect(status.files[0]).toEqual({
      name: "references.bib",
      state: "edited",
      changes: { added: ["mine2020"], changed: [], removed: [] },
    });
    expect(status.files[1]?.state).toBe("current");
    expect(await read(root, "references.bib")).toBe(edited);

    await syncManagedBibliography(root, { replaceEdited: ["references.bib"] });
    const replaced = await read(root, "references.bib");
    expect(replaced).not.toContain("mine2020");
    expect(replaced).toContain("lovelace1843sketch");
  });

  it("imports entries added by hand and keeps a file with changed entries", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");
    await syncManagedBibliography(root);
    const bibPath = NodePath.join(root, "references.bib");
    const written = await read(root, "references.bib");
    await NodeFSP.writeFile(
      bibPath,
      `${written}\n@book{babbage1864passages,\n  author = {Babbage, Charles},\n  title = {Passages from the Life of a Philosopher},\n  year = {1864},\n}\n`,
    );

    const imported = await syncManagedBibliographyWithImports({
      root,
      importEdited: ["references.bib"],
      actor: "user",
    });
    expect(imported.imported).toBe(1);
    expect(imported.files[0]?.state).toBe("current");
    expect(await read(root, "references.bib")).toContain("@book{babbage1864passages,");

    const changed = (await read(root, "references.bib")).replace(
      "Passages from the Life of a Philosopher",
      "Passages",
    );
    await NodeFSP.writeFile(bibPath, changed);
    const kept = await syncManagedBibliographyWithImports({
      root,
      importEdited: ["references.bib"],
      actor: "user",
    });
    expect(kept.files[0]).toMatchObject({
      state: "edited",
      changes: { changed: ["babbage1864passages"] },
    });
    expect(await read(root, "references.bib")).toBe(changed);
  });

  it("never writes over a file Scient did not write", async () => {
    const root = await project();
    await NodeFSP.writeFile(NodePath.join(root, "references.bib"), "@misc{own,\n}\n");
    await add(root, "A", "Notes on the analytical engine");

    const status = await syncManagedBibliography(root, { replaceEdited: ["references.bib"] });
    expect(status.files[0]?.state).toBe("unmanaged");
    expect(await read(root, "references.bib")).toBe("@misc{own,\n}\n");
  });

  it("gives sources written before citation keys existed a key, oldest first", async () => {
    const root = await project();
    const identity = await readScientProjectIdentity(root);
    const recordsDirectory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
    await NodeFSP.mkdir(recordsDirectory, { recursive: true });
    for (const [sourceId, importedAt] of [
      ["source_new", "2026-02-01T00:00:00.000Z"],
      ["source_old", "2026-01-01T00:00:00.000Z"],
    ] as const) {
      const {
        sourceKey: _key,
        pdfAvailable: _a,
        pdfFileName: _b,
        pdfAttachmentCount: _c,
        ...rest
      } = candidate(sourceId, "Notes");
      await NodeFSP.writeFile(
        NodePath.join(recordsDirectory, `${sourceId}.json`),
        JSON.stringify({
          formatVersion: 1,
          sourceId,
          projectId: identity.projectId,
          revision: 1,
          ...rest,
          attachments: [],
          importedAt,
        }),
      );
    }

    await syncManagedBibliography(root);

    const old = await readScientSourceRecord(root, "source_old");
    const newer = await readScientSourceRecord(root, "source_new");
    expect(old).toMatchObject({ citationKey: "lovelace1843notes", revision: 2 });
    expect(newer).toMatchObject({ citationKey: "lovelace1843notesa", revision: 2 });
  });
});
