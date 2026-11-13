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
import { unpinScientLibrarySource, readScientProjectPins } from "./projectPins.ts";
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

/**
 * What one package import did, kept in the Library. `added` is what Undo removes; joined things
 * (a matched source, an existing pin's note history, a highlight merged into an existing file, a
 * review version kept beside one) overwrote nothing, so Undo leaves them.
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
  }),
  joined: Schema.Struct({
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

export type ScientProjectPackageUndo =
  | { readonly outcome: "undone"; readonly kept: ReadonlyArray<string> }
  | { readonly outcome: "already-undone" }
  | { readonly outcome: "not-found" };

/**
 * Undo of one import: unpins the pins it added, removes the review files and highlight files it
 * created while unchanged, deletes the collections it created (restorable), detaches the PDFs it
 * attached and moves the sources it added to the trash. Anything changed since stays and is named.
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
  const kept: string[] = [];
  const pinned = new Map(
    (await readScientProjectPins(input.projectRoot)).map((pin) => [pin.citationKey, pin]),
  );
  for (const citationKey of receipt.added.pins) {
    if (!pinned.has(citationKey)) continue;
    await unpinScientLibrarySource({
      projectRoot: input.projectRoot,
      citationKey,
      actor: input.actor,
    });
  }
  for (const file of receipt.added.reviewFiles) {
    if (!(await removeIfUnchanged(input.projectRoot, file))) kept.push(file.path);
  }
  for (const file of receipt.added.annotationFiles) {
    if (!(await removeIfUnchanged(input.library.root, file))) kept.push(file.path);
  }
  for (const collectionId of receipt.added.collections) {
    await deleteScientSourceCollection({ root: input.library, collectionId, actor: input.actor });
  }
  for (const { sourceId, attachmentId } of receipt.added.pdfs) {
    const record = await readScientSourceRecord(input.library, sourceId);
    if (!record?.attachments.some((attachment) => attachment.attachmentId === attachmentId)) {
      continue;
    }
    await detachScientSourcePdf({
      root: input.library,
      sourceId,
      attachmentId,
      expectedRevision: record.revision,
      actor: input.actor,
    });
  }
  for (const sourceId of receipt.added.sources) {
    const record = await readScientSourceRecord(input.library, sourceId);
    if (!record) continue;
    await removeScientSource({
      root: input.library,
      sourceId,
      expectedRevision: record.revision,
      actor: input.actor,
    });
  }
  await writeScientProjectPackageReceipt(input.library, {
    ...receipt,
    undone: { at: new Date().toISOString(), by: input.actor, kept },
  });
  return { outcome: "undone", kept };
}
