// @effect-diagnostics nodeBuiltinImport:off -- An import receipt is a file in the Library; Undo removes files it names.
// @effect-diagnostics globalDate:off -- Receipts use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { deleteScientSourceCollection } from "./collections.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import { ScientSourceActor } from "./model.ts";
import { unpinScientProjectPinIfUnchanged } from "./projectPins.ts";
import { detachScientSourcePdf, readScientSourceRecord, removeScientSource } from "./store.ts";
import { atomicWriteJson, isNodeError, readBoundedJson } from "./storeFiles.ts";

const RECEIPTS_DIRECTORY = "package-imports";
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const RECEIPT_ID = /^import_[0-9a-f]{32}$/u;

/** A file the import created, with the bytes it wrote: Undo removes it only while unchanged. */
const CreatedFile = Schema.Struct({ path: Schema.String, sha256: Schema.String });

export const ScientProjectPackageFailure = Schema.Struct({
  part: Schema.Literals(["source", "pdf", "annotations", "review", "collection", "pins"]),
  /** The package path or ID of what failed. */
  item: Schema.String,
  message: Schema.String,
});
export type ScientProjectPackageFailure = typeof ScientProjectPackageFailure.Type;

/** Each added object as the import left it: Undo removes it only while it is still so. */
const AddedVersions = Schema.Struct({
  sources: Schema.Array(Schema.Struct({ sourceId: Schema.String, revision: Schema.Int })),
  pins: Schema.Array(
    Schema.Struct({
      citationKey: Schema.String,
      sourceId: Schema.String,
      note: Schema.NullOr(Schema.String),
    }),
  ),
  collections: Schema.Array(
    Schema.Struct({ collectionId: Schema.String, updatedAt: Schema.String }),
  ),
});

/**
 * What one package import did, kept in the Library. `added` is what Undo may remove; joined things
 * (a matched source and the notices and abstract it took, an existing pin's note or history, a
 * highlight merged into an existing file, a review version kept beside one) stay.
 */
export const ScientProjectPackageReceipt = Schema.Struct({
  formatVersion: Schema.Literal(1),
  importId: Schema.String,
  importedAt: Schema.String,
  importedBy: ScientSourceActor,
  projectId: Schema.String,
  packageTitle: Schema.String,
  added: Schema.Struct({
    sources: Schema.Array(Schema.String),
    pdfs: Schema.Array(Schema.Struct({ sourceId: Schema.String, attachmentId: Schema.String })),
    /** Library-relative highlight files that did not exist before. */
    annotationFiles: Schema.Array(CreatedFile),
    pins: Schema.Array(Schema.String),
    /** Project-relative review, snapshot and kept-version files. */
    reviewFiles: Schema.Array(CreatedFile),
    collections: Schema.Array(Schema.String),
    versions: Schema.optionalKey(AddedVersions),
  }),
  joined: Schema.Struct({
    /** Existing records and pins this import joined: an earlier import's Undo keeps them. */
    sourceIds: Schema.optionalKey(Schema.Array(Schema.String)),
    pinKeys: Schema.optionalKey(Schema.Array(Schema.String)),
    sources: Schema.Int,
    pdfs: Schema.Int,
    annotationConflicts: Schema.Int,
    notesKept: Schema.Int,
    historyAdded: Schema.Int,
    reviewVersionsKept: Schema.Int,
  }),
  failed: Schema.Array(ScientProjectPackageFailure),
  undone: Schema.optionalKey(
    Schema.Struct({
      at: Schema.String,
      by: ScientSourceActor,
      /** What was changed after the import and so stayed. */
      kept: Schema.Array(Schema.String),
    }),
  ),
});
export type ScientProjectPackageReceipt = typeof ScientProjectPackageReceipt.Type;

export function newScientPackageImportId(): string {
  return `import_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
}

function receiptPath(library: ScientLibraryLocation, importId: string): string {
  if (!RECEIPT_ID.test(importId)) throw new Error("The import ID is not a safe name.");
  return NodePath.join(library.root, RECEIPTS_DIRECTORY, `${importId}.json`);
}

export async function writeScientProjectPackageReceipt(
  library: ScientLibraryLocation,
  receipt: ScientProjectPackageReceipt,
): Promise<void> {
  await atomicWriteJson(receiptPath(library, receipt.importId), receipt, MAX_RECEIPT_BYTES);
}

async function readScientProjectPackageReceipt(
  library: ScientLibraryLocation,
  importId: string,
): Promise<ScientProjectPackageReceipt | null> {
  if (!RECEIPT_ID.test(importId)) return null;
  try {
    return await readBoundedJson(
      receiptPath(library, importId),
      MAX_RECEIPT_BYTES,
      ScientProjectPackageReceipt,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function hashOf(filePath: string): Promise<string | null> {
  const hash = NodeCrypto.createHash("sha256");
  try {
    for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  return hash.digest("hex");
}

/** Removes a created file still holding the bytes the import wrote; a changed one stays. */
async function removeIfUnchanged(base: string, file: typeof CreatedFile.Type): Promise<boolean> {
  const target = NodePath.join(base, ...file.path.split("/"));
  const current = await hashOf(target);
  if (current === null) return true;
  if (current !== file.sha256) return false;
  await NodeFSP.rm(target, { force: true });
  return true;
}

/** The project's other imports not undone, which may use what this one added. */
async function otherImports(
  library: ScientLibraryLocation,
  receipt: ScientProjectPackageReceipt,
): Promise<ReadonlyArray<ScientProjectPackageReceipt>> {
  let names: string[];
  try {
    names = await NodeFSP.readdir(NodePath.join(library.root, RECEIPTS_DIRECTORY));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const others: ScientProjectPackageReceipt[] = [];
  for (const name of names) {
    const importId = name.replace(/\.json$/u, "");
    if (importId === receipt.importId || !RECEIPT_ID.test(importId)) continue;
    const other = await readScientProjectPackageReceipt(library, importId);
    if (other && other.projectId === receipt.projectId && !other.undone) others.push(other);
  }
  return others;
}

const failure = (error: unknown) => (error instanceof Error ? error.message : "It failed.");

export type ScientProjectPackageUndo =
  | { readonly outcome: "undone"; readonly kept: ReadonlyArray<string> }
  | { readonly outcome: "already-undone" }
  | { readonly outcome: "not-found" };

/**
 * Undo of one import. Each pin, source, attached PDF and collection it added goes only while it
 * is as the import left it (compared under its own lock) and no other import of this project
 * joined it; review and highlight files only while they hold the bytes it wrote. Anything else
 * stays and is named. A step that fails leaves the import not undone, so Undo can run again.
 */
export async function undoScientProjectPackageImport(input: {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly library: ScientLibraryLocation;
  readonly importId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientProjectPackageUndo> {
  const receipt = await readScientProjectPackageReceipt(input.library, input.importId);
  if (!receipt || receipt.projectId !== input.projectId) return { outcome: "not-found" };
  if (receipt.undone) return { outcome: "already-undone" };
  const others = await otherImports(input.library, receipt);
  const usedSources = new Set(
    others.flatMap((other) => [
      ...(other.joined.sourceIds ?? []),
      ...other.added.pdfs.map((pdf) => pdf.sourceId),
    ]),
  );
  const usedKeys = new Set(others.flatMap((other) => other.joined.pinKeys ?? []));
  const versions = receipt.added.versions;
  const kept: string[] = [];
  const unfinished: string[] = [];
  const step = async (label: string, run: () => Promise<boolean>) => {
    try {
      if (!(await run())) kept.push(label);
    } catch (error) {
      unfinished.push(`${label}: ${failure(error)}`);
    }
  };

  for (const citationKey of receipt.added.pins) {
    const expected = versions?.pins.find((pin) => pin.citationKey === citationKey);
    await step(`pin ${citationKey}`, async () => {
      if (!expected || usedKeys.has(citationKey)) return false;
      const outcome = await unpinScientProjectPinIfUnchanged({
        projectRoot: input.projectRoot,
        citationKey,
        sourceId: expected.sourceId,
        note: expected.note,
        actor: input.actor,
      });
      return outcome !== "changed";
    });
  }
  for (const file of receipt.added.reviewFiles) {
    await step(file.path, () => removeIfUnchanged(input.projectRoot, file));
  }
  for (const file of receipt.added.annotationFiles) {
    await step(file.path, () => removeIfUnchanged(input.library.root, file));
  }
  for (const collectionId of receipt.added.collections) {
    const expected = versions?.collections.find((entry) => entry.collectionId === collectionId);
    await step(`collection ${collectionId}`, async () => {
      if (!expected) return false;
      const change = await deleteScientSourceCollection({
        root: input.library,
        collectionId,
        actor: input.actor,
        expectedUpdatedAt: expected.updatedAt,
      });
      return (
        change.outcome === "deleted" ||
        change.outcome === "not-found" ||
        change.collection?.deletedAt !== undefined
      );
    });
  }
  // A source as the import left it: never edited since, nor joined by another import.
  const unchanged = async (sourceId: string) => {
    const record = await readScientSourceRecord(input.library, sourceId);
    const expected = versions?.sources.find((entry) => entry.sourceId === sourceId);
    if (!record) return { record, unchanged: true };
    return {
      record,
      unchanged:
        expected !== undefined &&
        record.revision === expected.revision &&
        !usedSources.has(sourceId),
    };
  };
  const added = new Set(receipt.added.sources);
  for (const { sourceId, attachmentId } of receipt.added.pdfs) {
    if (added.has(sourceId)) continue;
    await step(`PDF ${attachmentId}`, async () => {
      const current = await unchanged(sourceId);
      if (!current.record?.attachments.some((entry) => entry.attachmentId === attachmentId)) {
        return true;
      }
      if (!current.unchanged) return false;
      const detached = await detachScientSourcePdf({
        root: input.library,
        sourceId,
        attachmentId,
        expectedRevision: current.record.revision,
        actor: input.actor,
      });
      return detached.outcome !== "stale";
    });
  }
  for (const sourceId of receipt.added.sources) {
    await step(`source ${sourceId}`, async () => {
      const current = await unchanged(sourceId);
      if (!current.record) return true;
      if (!current.unchanged) return false;
      const removed = await removeScientSource({
        root: input.library,
        sourceId,
        expectedRevision: current.record.revision,
        actor: input.actor,
      });
      return removed.outcome !== "stale";
    });
  }
  if (unfinished.length > 0) {
    throw new Error(
      `Undo stopped before it finished (${unfinished.join("; ")}); run it again to finish.`,
    );
  }
  await writeScientProjectPackageReceipt(input.library, {
    ...receipt,
    undone: { at: new Date().toISOString(), by: input.actor, kept },
  });
  return { outcome: "undone", kept };
}
