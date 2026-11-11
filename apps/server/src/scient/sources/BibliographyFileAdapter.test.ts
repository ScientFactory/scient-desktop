// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceStagedFileImport,
  SCIENT_SOURCES_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  beginBibliographyFileImport,
  bibliographyFileErrorMessage,
  exportBibliography,
  readBibliographyFile,
  resolveProjectBibliographyFile,
  writeProjectBibliographyFile,
} from "./BibliographyFileAdapter.ts";
import { cancelSourceImport, importBibliographyFile } from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

async function project(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bibliography-")),
  );
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const BIB = String.raw`
@article{garcia_deep_2021,
  title = {Deep learning for {MRI} reconstruction},
  author = {Garc{\'i}a, Mar{\'i}a and O'Neil, Se{\'a}n},
  journal = {Nature Communications},
  year = {2021},
  doi = {10.1038/s41467-021-00002-y},
  annote = {Compare with chapter 3},
  file = {garcia.pdf},
}
@book{knuth1997, title = {The art of computer programming}, author = {Knuth, Donald E.}, year = 1997, publisher = {Addison-Wesley}}
@misc{nokey_entry, title = {A note without identifiers}, author = {Doe, Jane}, year = 2020}
@article{broken, title = {Unclosed, year = 2001
`;

const stagingDirectory = (root: string) =>
  NodePath.join(root, SCIENT_SOURCES_DIRECTORY, "staging", "files");

describe("reference file import", () => {
  it("imports entries through the durable pipeline with keys, notes, provenance and verification", async () => {
    const root = await project();
    const { operation, report } = await importBibliographyFile({
      root,
      operationId: "file_import_one",
      fileName: "library.bib",
      text: BIB,
      actor: "user",
    });

    expect(operation).toMatchObject({ adapter: "file", intake: "file", state: "completed" });
    expect(operation?.items.map((item) => item.state)).toEqual([
      "imported",
      "imported",
      "imported",
    ]);
    expect(report).toMatchObject({
      format: "bibtex",
      entryCount: 4,
      importCount: 3,
      alreadyInLibrary: 0,
      unreadableCount: 1,
      notKept: [{ field: "file", entryCount: 1, citationKeys: ["garcia_deep_2021"] }],
    });
    const records = await listScientSourceRecords(root);
    const article = records.find((record) => record.citationKey === "garcia_deep_2021");
    expect(article).toMatchObject({
      title: "Deep learning for MRI reconstruction",
      note: "Compare with chapter 3",
      origin: { actor: "user", intake: "file", operationId: "file_import_one" },
      verification: {
        state: "unchecked",
        identifier: { scheme: "doi", value: "10.1038/s41467-021-00002-y" },
      },
    });
    expect(article?.creators[0]).toMatchObject({ givenName: "María", familyName: "García" });
    expect(article?.fieldProvenance).toContainEqual({
      field: "title",
      origin: "file",
      sourceField: "bibtex:title",
    });
    expect(records.find((record) => record.citationKey === "nokey_entry")?.verification).toEqual({
      state: "unverified",
    });
    await expect(NodeFSP.readdir(stagingDirectory(root))).resolves.toEqual([]);

    const again = await importBibliographyFile({
      root,
      operationId: "file_import_two",
      fileName: "library.bib",
      text: BIB,
      actor: "user",
    });
    expect(again.operation).toBeNull();
    expect(again.report).toMatchObject({ importCount: 0, alreadyInLibrary: 3 });
    expect(await listScientSourceRecords(root)).toHaveLength(3);
  });

  it("continues a large file with sparse entries by their identity, without duplicates", async () => {
    const root = await project();
    const text = Array.from(
      { length: 501 },
      (_, index) => `@misc{k${index}, title = {Entry ${index}}}`,
    ).join("\n");
    const input = { root, fileName: "large.bib", text, actor: "user" as const };
    const first = await importBibliographyFile({ ...input, operationId: "file_import_large_1" });
    expect(first.report).toMatchObject({ importCount: 500, remaining: 1 });

    const second = await beginBibliographyFileImport({
      ...input,
      operationId: "file_import_large_2",
    });
    expect(second.report).toMatchObject({ importCount: 1, alreadyInLibrary: 500, remaining: 0 });
    const staged = await readScientSourceStagedFileImport(root, "file_import_large_2");
    expect(staged?.candidates.map((candidate) => candidate.citationKey)).toEqual(["k500"]);
    const continued = await importBibliographyFile({
      ...input,
      operationId: "file_import_large_2",
    });
    expect(continued.operation?.items.map((item) => item.state)).toEqual(["imported"]);

    const [candidate] = staged?.candidates ?? [];
    if (!candidate) throw new Error("Missing staged entry");
    const again = await importScientSource({ root, operationId: "file_import_large_3", candidate });
    expect(again.outcome).toBe("duplicate");
    const records = await listScientSourceRecords(root);
    expect(new Set(records.map((record) => record.citationKey)).size).toBe(501);
    expect(records).toHaveLength(501);
  });

  it("returns the same operation for a repeated request and discards the stage on cancel", async () => {
    const root = await project();
    const input = {
      root,
      operationId: "file_import_replay",
      fileName: "library.bib",
      text: BIB,
      actor: "agent" as const,
    };
    const first = await beginBibliographyFileImport(input);
    const second = await beginBibliographyFileImport(input);
    expect(second.operation?.operationId).toBe(first.operation?.operationId);
    expect(second.report).toEqual(first.report);
    await expect(NodeFSP.readdir(stagingDirectory(root))).resolves.toEqual([
      "file_import_replay.json",
    ]);

    await cancelSourceImport({ root, operationId: "file_import_replay" });
    await expect(NodeFSP.readdir(stagingDirectory(root))).resolves.toEqual([]);
  });

  it("asks for a known format when the file is not a reference file", async () => {
    const root = await project();
    await expect(
      beginBibliographyFileImport({
        root,
        operationId: "file_import_unknown",
        fileName: "notes.txt",
        text: "Just some notes.",
        actor: "user",
      }),
    ).rejects.toThrow("Scient could not tell what kind of reference file this is.");
  });

  it("reads Windows-1252 exports and keeps project files inside the project", async () => {
    const root = await project();
    await NodeFSP.writeFile(
      NodePath.join(root, "old.ris"),
      Buffer.from("TY  - JOUR\nAU  - M\xfcller, J\xf6rg\nER  - \n", "latin1"),
    );
    const file = await resolveProjectBibliographyFile(root, "old.ris");
    expect(await readBibliographyFile(file.absolutePath)).toContain("Müller, Jörg");

    await expect(resolveProjectBibliographyFile(root, "../outside.bib")).rejects.toThrow(
      "must remain inside the project",
    );
    await NodeFSP.mkdir(NodePath.join(root, SCIENT_SOURCES_DIRECTORY), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, SCIENT_SOURCES_DIRECTORY, "x.json"), "[]");
    await expect(
      resolveProjectBibliographyFile(root, `${SCIENT_SOURCES_DIRECTORY}/x.json`),
    ).rejects.toThrow("outside .scient");
  });

  it("does not pass filesystem paths through error messages", async () => {
    const missing = await NodeFSP.readFile("/nonexistent/scient/file.bib").catch((error) => error);
    expect(bibliographyFileErrorMessage(missing, "fallback")).toBe(
      "The file was not found in this project.",
    );
    const denied = Object.assign(new Error("EACCES: permission denied, open '/Users/x'"), {
      code: "EACCES",
    });
    expect(bibliographyFileErrorMessage(denied, "fallback")).toBe("fallback");
  });
});

describe("reference file export", () => {
  it("exports selected sources under their keys and leaves notes out by default", async () => {
    const root = await project();
    await importBibliographyFile({
      root,
      operationId: "file_import_export",
      fileName: "library.bib",
      text: BIB,
      actor: "user",
    });
    const records = await listScientSourceRecords(root);
    const knuth = records.find((record) => record.citationKey === "knuth1997");
    const exported = await exportBibliography({
      root,
      format: "bibtex",
      sourceIds: [knuth?.sourceId ?? "", "source_missing"],
    });
    expect(exported).toMatchObject({
      fileName: "references.bib",
      sourceCount: 1,
      missingSourceIds: ["source_missing"],
    });
    expect(exported.content).toMatch(/^@book\{knuth1997,/u);

    const all = await exportBibliography({ root, format: "ris" });
    expect(all.sourceCount).toBe(3);
    expect(all.content).not.toContain("Compare with chapter 3");
    const withNotes = await exportBibliography({ root, format: "ris", includeNotes: true });
    expect(withNotes.content).toContain("N1  - Compare with chapter 3");
  });

  it("writes an export atomically, keeps existing files unless asked and stays out of .scient", async () => {
    const root = await project();
    await NodeFSP.mkdir(NodePath.join(root, "refs"));
    const write = (relativePath: string, content: string, overwrite = false) =>
      writeProjectBibliographyFile({
        root,
        relativePath,
        content,
        overwrite,
        caseInsensitive: false,
      });

    await expect(write("refs/library.bib", "first")).resolves.toEqual({
      outcome: "written",
      relativePath: "refs/library.bib",
    });
    await expect(write("refs/library.bib", "second")).resolves.toMatchObject({ outcome: "exists" });
    expect(await NodeFSP.readFile(NodePath.join(root, "refs/library.bib"), "utf8")).toBe("first");
    await write("refs/library.bib", "second", true);
    expect(await NodeFSP.readFile(NodePath.join(root, "refs/library.bib"), "utf8")).toBe("second");
    await expect(NodeFSP.readdir(NodePath.join(root, "refs"))).resolves.toEqual(["library.bib"]);

    await expect(write("../escape.bib", "x")).rejects.toThrow("inside the project");
    await expect(write(".scient/sources/records/x.json", "x")).rejects.toThrow("outside .scient");
    await expect(write("missing/library.bib", "x")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(write("references.bib", "x")).rejects.toThrow("kept up to date from the Library");
  });

  it("refuses .scient and managed files reached through a folder symlink or case alias, even with overwrite", async () => {
    const root = await project();
    await NodeFSP.symlink(
      NodePath.join(root, ".scient"),
      NodePath.join(root, "storage"),
      "junction",
    );
    await NodeFSP.symlink(root, NodePath.join(root, "here"), "junction");
    const write = (relativePath: string) =>
      writeProjectBibliographyFile({
        root,
        relativePath,
        content: "x",
        overwrite: true,
        caseInsensitive: true,
      });

    await expect(write("storage/probe.bib")).rejects.toThrow("outside .scient");
    await expect(write("here/.scient/probe.bib")).rejects.toThrow("outside .scient");
    await expect(write("here/References.BIB")).rejects.toThrow("kept up to date from the Library");
    await expect(NodeFSP.stat(NodePath.join(root, ".scient", "probe.bib"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(NodeFSP.stat(NodePath.join(root, "references.bib"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
