// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { editableMetadataFromRecord } from "@scientfactory/scient-sources";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceStagedFileImport,
  updateScientSourceMetadata,
  updateScientSourceNote,
  SCIENT_SOURCES_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  beginBibliographyFileImport,
  bibliographyFileErrorMessage,
  exportBibliography,
  readBibliographyFile,
  resolveProjectBibliographyFile,
  verifiedUploadFolder,
  writeProjectBibliographyFile,
} from "./BibliographyFileAdapter.ts";
import {
  advanceSourceImport,
  cancelSourceImport,
  importBibliographyFile,
  retrySourceImport,
} from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

const rename = NodeFS.promises.rename;

async function failThirdPdf(work: () => Promise<unknown>): Promise<void> {
  NodeFS.promises.rename = async (from, to) => {
    if (String(to).includes(`${NodePath.sep}records${NodePath.sep}`)) {
      const record = JSON.parse(await NodeFSP.readFile(to, "utf8")) as {
        attachments: unknown[];
      };
      if (record.attachments.length === 2) {
        NodeFS.promises.rename = rename;
        NodeModule.syncBuiltinESMExports();
        throw new Error("Transient PDF record write failure.");
      }
    }
    return rename(from, to);
  };
  NodeModule.syncBuiltinESMExports();
  try {
    await work();
  } finally {
    NodeFS.promises.rename = rename;
    NodeModule.syncBuiltinESMExports();
  }
}

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
    // A file whose works are all here still gets an import of its own, so its receipt says so.
    expect(again.operation?.items.map((item) => item.state)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(again.report).toMatchObject({ importCount: 0, presentCount: 3, alreadyInLibrary: 0 });
    expect(await listScientSourceRecords(root)).toHaveLength(3);
  });

  it("does not resume another operation's matching source or add its remaining PDFs", async () => {
    const root = await project();
    for (const name of ["one", "two"]) {
      await NodeFSP.writeFile(NodePath.join(root, `${name}.pdf`), `%PDF-1.7\n${name}\n`);
    }
    await beginBibliographyFileImport({
      root,
      operationId: "unrelated-file-import",
      fileName: "duplicates.bib",
      sourceFolder: root,
      text: "@article{duplicateKey, title={Existing work}, annote={New note}, file={:one.pdf:PDF;:two.pdf:PDF}}",
      actor: "user",
    });
    const staged = await readScientSourceStagedFileImport(root, "unrelated-file-import");
    const existing = await importScientSource({
      root,
      operationId: "preexisting-source",
      candidate: { ...staged!.candidates[0]!, note: "My original note" },
      actor: "user",
      intake: "file",
    });
    const finished = await advanceSourceImport({ root, operationId: "unrelated-file-import" });
    expect(finished.items[0]).toMatchObject({
      state: "skipped",
      sourceId: existing.record!.sourceId,
    });
    expect(finished.items[0]?.attachedPdf).toBeUndefined();
    expect(await listScientSourceRecords(root)).toEqual([existing.record]);
    expect(await readScientSourceStagedFileImport(root, "unrelated-file-import")).toBeNull();
  });

  it("resumes its committed entry after a later PDF fails, keeping later edits and all project keys", async () => {
    const root = await project();
    const libraryRoot = scientLibraryRootFor(NodePath.join(root, "state"));
    await ensureScientLibrary(libraryRoot);
    const library = scientLibraryLocation(libraryRoot);
    for (const name of ["one", "two", "three"]) {
      await NodeFSP.writeFile(NodePath.join(root, `${name}.pdf`), `%PDF-1.7\n${name}\n`);
    }
    const text = String.raw`@article{retryKey,
      title={Retry with all authors}, author={Doe, Jane and others}, year={2026}, doi={10.1234/retry},
      annote={Imported note}, file={:one.pdf:PDF;:two.pdf:PDF;:three.pdf:PDF}}
      @article{aliasKey, title={Retry with all authors}, author={Doe, Jane and others}, year={2026}, doi={10.1234/retry}}`;
    const begun = await beginBibliographyFileImport({
      root: library,
      projectRoot: root,
      pinInto: root,
      operationId: "file_retry_pdfs",
      fileName: "retry.bib",
      sourceFolder: root,
      text,
      actor: "user",
    });
    const itemKey = begun.operation!.items[0]!.itemKey;
    const staged = await readScientSourceStagedFileImport(library, "file_retry_pdfs");
    const candidate = staged!.candidates[0]!;
    let resolutions = 0;
    const resolveIdentifier = async () => {
      resolutions += 1;
      return {
        status: "found" as const,
        identifier: { scheme: "doi", value: "10.1234/retry" },
        retrievedAt: "2026-11-16T12:00:00.000Z",
        metadata: {
          ...candidate,
          abstractSections: [],
          creators: [
            ...candidate.creators,
            { creatorType: "author", givenName: "John", familyName: "Roe", literalName: null },
          ],
        },
      };
    };
    await failThirdPdf(async () => {
      const failed = await advanceSourceImport({
        root: library,
        operationId: "file_retry_pdfs",
        resolveIdentifier,
      });
      expect(failed.items[0]).toMatchObject({ state: "failed" });
    });
    const [partial] = await listScientSourceRecords(library);
    expect(partial?.attachments).toHaveLength(2);
    expect(partial?.creators).toHaveLength(2);
    expect(await readScientSourceStagedFileImport(library, "file_retry_pdfs")).not.toBeNull();
    const edited = await updateScientSourceMetadata({
      root: library,
      sourceId: partial!.sourceId,
      expectedRevision: partial!.revision,
      metadata: {
        ...editableMetadataFromRecord(partial!),
        title: "My later title",
        citationKey: "myLaterKey",
        creators: [
          { creatorType: "author", givenName: "Edited", familyName: "Author", literalName: null },
        ],
      },
      actor: "user",
    });
    expect(edited.outcome).toBe("updated");
    const noted = await updateScientSourceNote({
      root: library,
      sourceId: edited.record.sourceId,
      expectedRevision: edited.record.revision,
      note: "My later note",
      actor: "user",
    });
    await retrySourceImport({ root: library, operationId: "file_retry_pdfs", itemKeys: [itemKey] });
    const finished = await advanceSourceImport({
      root: library,
      operationId: "file_retry_pdfs",
      resolveIdentifier,
    });
    expect(finished.items[0]).toMatchObject({
      state: "imported",
      sourceId: partial!.sourceId,
      authorList: "completed",
      citationKeys: expect.arrayContaining([
        expect.objectContaining({ citationKey: "retryKey" }),
        expect.objectContaining({ citationKey: "aliasKey" }),
      ]),
    });
    const records = await listScientSourceRecords(library);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      title: "My later title",
      citationKey: "myLaterKey",
      note: "My later note",
      revision: noted.record.revision + 1,
    });
    expect(records[0]!.creators).toEqual(edited.record.creators);
    expect(resolutions).toBe(1);
    expect(records[0]!.attachments.map((attachment) => attachment.fileName)).toEqual([
      "one.pdf",
      "two.pdf",
      "three.pdf",
    ]);
    expect((await readScientProjectPins(root)).map((pin) => pin.citationKey).toSorted()).toEqual([
      "aliasKey",
      "retryKey",
    ]);
    expect(await readScientSourceStagedFileImport(library, "file_retry_pdfs")).toBeNull();
    expect(await advanceSourceImport({ root: library, operationId: "file_retry_pdfs" })).toEqual(
      finished,
    );
    expect(await listScientSourceRecords(library)).toEqual(records);
  });

  it("stages at most 500 entries of a reference file per import", async () => {
    const root = await project();
    const text = Array.from(
      { length: 501 },
      (_, index) => `@misc{k${index}, title = {Entry ${index}}}`,
    ).join("\n");
    const begun = await beginBibliographyFileImport({
      root,
      operationId: "file_import_limit",
      fileName: "large.bib",
      text,
      actor: "user",
    });
    expect(begun.report).toMatchObject({ importCount: 500, remaining: 1 });
  });

  it("continues a large file with sparse entries by their identity, without duplicates", async () => {
    const root = await project();
    const text = Array.from(
      { length: 6 },
      (_, index) => `@misc{k${index}, title = {Entry ${index}}}`,
    ).join("\n");
    const input = { root, fileName: "large.bib", text, actor: "user" as const, batchLimit: 5 };
    const first = await importBibliographyFile({ ...input, operationId: "file_import_large_1" });
    expect(first.report).toMatchObject({ importCount: 5, remaining: 1 });

    const second = await beginBibliographyFileImport({
      ...input,
      operationId: "file_import_large_2",
    });
    // New entries come first; works already here fill the room left, the rest are counted.
    expect(second.report).toMatchObject({
      importCount: 1,
      presentCount: 4,
      alreadyInLibrary: 1,
      remaining: 0,
    });
    const staged = await readScientSourceStagedFileImport(root, "file_import_large_2");
    expect(staged?.candidates[0]?.citationKey).toBe("k5");
    expect(staged?.candidates).toHaveLength(5);
    const continued = await importBibliographyFile({
      ...input,
      operationId: "file_import_large_2",
    });
    expect(continued.operation?.items.filter((item) => item.state === "imported")).toHaveLength(1);

    const [candidate] = staged?.candidates ?? [];
    if (!candidate) throw new Error("Missing staged entry");
    const again = await importScientSource({ root, operationId: "file_import_large_3", candidate });
    expect(again.outcome).toBe("duplicate");
    const records = await listScientSourceRecords(root);
    expect(new Set(records.map((record) => record.citationKey)).size).toBe(6);
    expect(records).toHaveLength(6);
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

  it("attaches linked PDFs inside the project or the file's folder and reports the rest", async () => {
    const root = await project();
    const exportFolder = await project();
    const elsewhere = await project();
    const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
    await NodeFSP.mkdir(NodePath.join(root, "papers"));
    await NodeFSP.mkdir(NodePath.join(exportFolder, "files"));
    const inProject = NodePath.join(root, "papers", "in-project.pdf");
    await NodeFSP.writeFile(inProject, pdf("project"));
    await NodeFSP.writeFile(NodePath.join(exportFolder, "files", "near.pdf"), pdf("near"));
    await NodeFSP.writeFile(NodePath.join(exportFolder, "files", "page.pdf"), "<html></html>");
    const far = NodePath.join(elsewhere, "far.pdf");
    await NodeFSP.writeFile(far, pdf("far"));
    const escaped = (path: string) => path.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
    const text = [
      `@article{both, title={Both}, file={:files/near.pdf:PDF;:${escaped(inProject)}:PDF}}`,
      `@article{far, title={Far}, file={${escaped(far)}}}`,
      `@article{missing, title={Missing}, file={files/missing.pdf}}`,
      `@article{page, title={Page}, file={files/page.pdf}}`,
    ].join("\n");

    const { report } = await importBibliographyFile({
      root,
      operationId: "file_import_linked",
      fileName: "library.bib",
      text,
      sourceFolder: exportFolder,
      actor: "agent",
    });

    expect(report.linkedPdfCount).toBe(2);
    expect(
      report.notKept.map(({ field, reason, citationKeys }) => ({ field, reason, citationKeys })),
    ).toEqual(
      expect.arrayContaining([
        {
          field: "file",
          reason: "outside the project and the reference file's folder",
          citationKeys: ["far"],
        },
        { field: "file", reason: "not found", citationKeys: ["missing"] },
        { field: "file", reason: "not a PDF", citationKeys: ["page"] },
      ]),
    );
    const records = await listScientSourceRecords(root);
    const pdfs = (key: string) =>
      records
        .find((record) => record.citationKey === key)
        ?.attachments.filter((attachment) => attachment.kind === "pdf").length;
    expect([pdfs("both"), pdfs("far"), pdfs("missing"), pdfs("page")]).toEqual([2, 0, 0, 0]);
  });

  it("uses an upload's folder only when the named file holds the uploaded bytes", async () => {
    const folder = await project();
    const original = NodePath.join(folder, "library.bib");
    const upload = NodePath.join(folder, "upload.tmp");
    await NodeFSP.writeFile(original, "@article{a, title={A}}");
    await NodeFSP.writeFile(upload, "@article{a, title={A}}");
    expect(await verifiedUploadFolder(original, upload)).toBe(folder);
    await NodeFSP.writeFile(upload, "@article{b, title={B}}");
    expect(await verifiedUploadFolder(original, upload)).toBeUndefined();
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
