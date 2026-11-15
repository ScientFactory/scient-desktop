// @effect-diagnostics nodeBuiltinImport:off -- This test verifies the Node filesystem adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { backUpScientLibrary, checkScientLibraryBackup } from "./libraryBackup.ts";
import { withScientFileLock } from "./libraryLock.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { ensureScientLibrary, scientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  deleteScientSourcesPermanently,
  importScientSource,
  listScientSourceRecords,
  removeScientSource,
} from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function candidate(sourceKey: string, title: string, pdf: boolean): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
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
    pdfAvailable: pdf,
    pdfFileName: pdf ? `${sourceKey}.pdf` : null,
    pdfAttachmentCount: pdf ? 1 : 0,
  };
}

/** A Library with a paper and its PDF, a merged pair and a paper in the Trash with its PDF. */
async function fixture() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-backup-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "state", "scient", "library");
  await ensureScientLibrary(root);
  const library = scientLibraryLocation(root);
  const destination = NodePath.join(base, "backups");
  await NodeFSP.mkdir(destination);
  const add = async (key: string, title: string, pdf: boolean) => {
    const pdfPath = NodePath.join(base, `${key}.pdf`);
    if (pdf) await NodeFSP.writeFile(pdfPath, `%PDF-1.7\n${title}\n`);
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate(key, title, pdf),
      ...(pdf ? { pdfPath } : {}),
    });
    return imported.record!;
  };
  const kept = await add("A", "Sleep and memory", true);
  const copy = await add("B", "Sleep and memory, a copy", false);
  const removed = await add("C", "Soil carbon budgets", true);
  const merged = await mergeScientLibrarySources({
    library,
    sourceIds: [kept.sourceId, copy.sourceId],
    survivorId: kept.sourceId,
  });
  if (merged.outcome !== "merged") throw new Error(`Not merged: ${merged.outcome}`);
  await removeScientSource({ root: library, sourceId: removed.sourceId, expectedRevision: 1 });
  // Derived text and a leftover temporary file, which a backup leaves out.
  await NodeFSP.mkdir(NodePath.join(root, "text", "sha256", "ab"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "text", "sha256", "ab", "x.json"), "{}");
  await NodeFSP.writeFile(NodePath.join(root, "records", "x.json.tmp-1"), "{");
  return { base, root, library, destination, kept, removed };
}

const filesIn = async (folder: string): Promise<ReadonlyArray<string>> =>
  (await NodeFSP.readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      NodePath.relative(folder, NodePath.join(entry.parentPath, entry.name))
        .split(NodePath.sep)
        .join("/"),
    )
    .toSorted();

describe("backing up the Library", () => {
  it("copies everything the Library keeps into a dated folder that checks as complete", async () => {
    const { root, library, destination } = await fixture();
    const progress: number[] = [];
    const result = await backUpScientLibrary({
      library,
      destination,
      onProgress: ({ done }) => progress.push(done),
    });
    if (result.outcome !== "backed-up") throw new Error(`Not backed up: ${result.outcome}`);

    expect(NodePath.basename(result.path)).toMatch(
      /^Scient Library backup \d{4}-\d{2}-\d{2} \d{4}$/u,
    );
    expect(await NodeFSP.readdir(destination)).toEqual([NodePath.basename(result.path)]);
    // One live paper (the merge kept it), two in the Trash folder (the merged copy and the
    // removed paper), both PDFs.
    expect(result.counts).toMatchObject({ sources: 1, trashed: 2, pdfs: 2 });
    expect(progress.at(-1)).toBe(result.counts.files);

    // The payload is the Library's own files, byte for byte, without what is left out.
    const backedUp = await filesIn(NodePath.join(result.path, "library"));
    const kept = (await filesIn(root)).filter(
      (path) => !path.startsWith("text/") && !path.includes(".lock") && !path.includes(".tmp-"),
    );
    expect(backedUp).toEqual(kept);
    expect(backedUp).toEqual(expect.arrayContaining(["library.json", "aliases.json"]));
    for (const path of backedUp) {
      expect(await NodeFSP.readFile(NodePath.join(result.path, "library", path))).toEqual(
        await NodeFSP.readFile(NodePath.join(root, path)),
      );
    }
    const readme = await NodeFSP.readFile(NodePath.join(result.path, "README.md"), "utf8");
    expect(readme).toContain("each project's citation keys");

    expect(await checkScientLibraryBackup(result.path)).toMatchObject({
      outcome: "complete",
      counts: result.counts,
    });
    // A second backup in the same minute gets its own folder.
    const second = await backUpScientLibrary({ library, destination });
    expect(second.outcome === "backed-up" && second.path).not.toBe(result.path);
  });

  it("says which files of a backup changed, are gone or do not belong", async () => {
    const { library, destination, base } = await fixture();
    const result = await backUpScientLibrary({ library, destination });
    if (result.outcome !== "backed-up") throw new Error(`Not backed up: ${result.outcome}`);
    const payload = NodePath.join(result.path, "library");
    await NodeFSP.appendFile(NodePath.join(payload, "library.json"), " ");
    await NodeFSP.rm(NodePath.join(payload, "aliases.json"));
    await NodeFSP.writeFile(NodePath.join(payload, "records", "stray.json"), "{}");

    expect(await checkScientLibraryBackup(result.path)).toEqual({
      outcome: "damaged",
      changed: ["aliases.json", "library.json"],
      unlisted: ["records/stray.json"],
    });
    expect(await checkScientLibraryBackup(base)).toEqual({ outcome: "not-a-backup" });
  });

  it("keeps a PDF that is deleted for good while the backup runs", async () => {
    const { root, library, destination, removed } = await fixture();
    // The deletion is another caller's: it starts once the first file is copied and has to
    // wait for the backup to finish. (Started from the callback it would be the backup's own.)
    let copying!: () => void;
    const firstFileCopied = new Promise<void>((resolve) => {
      copying = resolve;
    });
    const deletion = firstFileCopied.then(() => deleteScientSourcesPermanently({ root: library }));
    const result = await backUpScientLibrary({ library, destination, onProgress: () => copying() });
    await deletion;
    if (result.outcome !== "backed-up") throw new Error(`Not backed up: ${result.outcome}`);

    expect(await NodeFSP.readdir(NodePath.join(root, "trash"))).toHaveLength(1);
    expect(result.counts).toMatchObject({ trashed: 2, pdfs: 2 });
    expect(
      await NodeFSP.readFile(
        NodePath.join(result.path, "library", "trash", `${removed.sourceId}.json`),
        "utf8",
      ),
    ).toContain("Soil carbon budgets");
    expect(await checkScientLibraryBackup(result.path)).toMatchObject({ outcome: "complete" });
  });

  it("leaves nothing behind when it is stopped, fails, or cannot start", async () => {
    const { root, library, destination } = await fixture();
    let asked = 0;
    expect(
      await backUpScientLibrary({ library, destination, shouldStop: () => (asked += 1) > 2 }),
    ).toEqual({ outcome: "stopped" });

    // A record that cannot be read stops the backup with its error.
    const [record] = await listScientSourceRecords(library);
    const recordPath = NodePath.join(root, "records", `${record!.sourceId}.json`);
    await NodeFSP.chmod(recordPath, 0o000);
    await expect(backUpScientLibrary({ library, destination })).rejects.toThrow();
    await NodeFSP.chmod(recordPath, 0o600);

    // A project is moving into the Library right now.
    const moving = NodePath.join(root, "migrations", "instance_1");
    await NodeFSP.mkdir(moving, { recursive: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const holding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const move = withScientFileLock(NodePath.join(moving, "move.lock"), async () => {
      started();
      await held;
    });
    await holding;
    expect(await backUpScientLibrary({ library, destination })).toEqual({ outcome: "busy" });
    release();
    await move;

    expect(
      await backUpScientLibrary({ library, destination: NodePath.join(root, "records") }),
    ).toEqual({ outcome: "unsafe-destination" });
    expect(await NodeFSP.readdir(destination)).toEqual([]);
  });
});
