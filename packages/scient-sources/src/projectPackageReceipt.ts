// @effect-diagnostics nodeBuiltinImport:off -- Import receipts are files in the Library.
// @effect-diagnostics globalDate:off -- Receipts use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { deleteScientSourceCollection } from "./collections.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import { ScientSourceActor } from "./model.ts";
import {
  clearScientProjectPinNoteIfUnchanged,
  unpinScientProjectPinIfUnchanged,
} from "./projectPins.ts";
import { readScientSourceRecord } from "./store.ts";
import { readScientLibraryAliases, resolveScientLibraryAlias } from "./libraryAliases.ts";
import { atomicWriteJson, isNodeError, readBoundedJson } from "./storeFiles.ts";

const RECEIPTS_DIRECTORY = "package-imports";
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const RECEIPT_ID = /^import_[0-9a-f]{32}$/u;

/** A file the import created, with the bytes it wrote. */
const CreatedFile = Schema.Struct({ path: Schema.String, sha256: Schema.String });

export const ScientProjectPackageFailure = Schema.Struct({
  part: Schema.Literals(["source", "pdf", "annotations", "review", "collection", "pins"]),
  /** The package path or ID of what failed. */
  item: Schema.String,
  message: Schema.String,
});
export type ScientProjectPackageFailure = typeof ScientProjectPackageFailure.Type;

const PinVersion = Schema.Struct({
  citationKey: Schema.String,
  sourceId: Schema.String,
  note: Schema.NullOr(Schema.String),
});

/**
 * Versions from each owning write; Undo checks project additions and collections, never papers.
 */
const Created = Schema.Struct({
  sources: Schema.Array(Schema.Struct({ sourceId: Schema.String, revision: Schema.Int })),
  pins: Schema.Array(PinVersion),
  /** Notes given to pins that had none. */
  notes: Schema.Array(PinVersion),
  collections: Schema.Array(
    Schema.Struct({ collectionId: Schema.String, updatedAt: Schema.String }),
  ),
});

/**
 * Undo checks versions of created project additions; Library papers and joined evidence stay.
 * Receipts without `created` keep everything.
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
    created: Schema.optionalKey(Created),
  }),
  joined: Schema.Struct({
    /** Existing records, pins and collections this import joined: another import's Undo keeps them. */
    sourceIds: Schema.optionalKey(Schema.Array(Schema.String)),
    pinKeys: Schema.optionalKey(Schema.Array(Schema.String)),
    collectionIds: Schema.optionalKey(Schema.Array(Schema.String)),
    /** What it put into what was already here (PDFs, notices, highlights, history): Undo leaves it. */
    evidence: Schema.optionalKey(Schema.Array(Schema.String)),
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
      /** What it created that changed since, or that another import uses, and so stayed. */
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

/** Every other import in this Library not undone: one may use what this one created. */
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
    if (other && !other.undone) others.push(other);
  }
  return others;
}

const failure = (error: unknown) => (error instanceof Error ? error.message : "It failed.");

export type ScientProjectPackageUndo =
  | {
      readonly outcome: "undone";
      /** What it created that changed since, or that another import uses: it stays. */
      readonly kept: ReadonlyArray<string>;
      /** Imported Library papers still available, after following later merges. */
      readonly retainedSourceIds: ReadonlyArray<string>;
      /** What it put into what was already here, and the highlights and review files it brought: they stay. */
      readonly left: ReadonlyArray<string>;
    }
  | { readonly outcome: "already-undone" }
  | { readonly outcome: "not-found" };

/** Everything a receipt from before Undo kept versions names; its Undo keeps all of it. */
function everythingAdded(receipt: ScientProjectPackageReceipt): ReadonlyArray<string> {
  const { added } = receipt;
  return [
    ...added.pins.map((key) => `pin ${key}`),
    ...added.collections.map((id) => `collection ${id}`),
    ...added.sources.map((id) => `source ${id}`),
    ...added.pdfs.map((pdf) => `PDF ${pdf.attachmentId} on source ${pdf.sourceId}`),
    ...added.annotationFiles.map((file) => `highlights ${file.path}`),
    ...added.reviewFiles.map((file) => `review file ${file.path}`),
  ];
}

/**
 * Removes unchanged project additions and collections under their locks; Library papers stay.
 * Joined evidence stays and is listed. A failed step leaves the import available to retry.
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
  const aliases = await readScientLibraryAliases(input.library);
  const retainedSourceIds: string[] = [];
  for (const id of new Set(
    receipt.added.sources.map((id) => resolveScientLibraryAlias(aliases, id)),
  )) {
    if (await readScientSourceRecord(input.library, id)) retainedSourceIds.push(id);
  }
  const created = receipt.added.created;
  const left = created
    ? [
        ...(receipt.joined.evidence ?? []),
        ...receipt.added.annotationFiles.map((file) => `highlights ${file.path}`),
        ...receipt.added.reviewFiles.map((file) => `review file ${file.path}`),
      ]
    : (receipt.joined.evidence ?? []);
  if (!created) {
    const kept = everythingAdded(receipt);
    await writeScientProjectPackageReceipt(input.library, {
      ...receipt,
      undone: { at: new Date().toISOString(), by: input.actor, kept: [...kept] },
    });
    return { outcome: "undone", kept, left, retainedSourceIds };
  }
  const others = await otherImports(input.library, receipt);
  const usedCollections = new Set(others.flatMap((other) => other.joined.collectionIds ?? []));
  const usedKeys = new Set(
    others
      .filter((other) => other.projectId === receipt.projectId)
      .flatMap((other) => other.joined.pinKeys ?? []),
  );
  const kept: string[] = [];
  const unfinished: string[] = [];
  const step = async (label: string, used: boolean, run: () => Promise<boolean>) => {
    if (used) {
      kept.push(label);
      return;
    }
    try {
      if (!(await run())) kept.push(label);
    } catch (error) {
      unfinished.push(`${label}: ${failure(error)}`);
    }
  };

  for (const pin of created.pins) {
    await step(`pin ${pin.citationKey}`, usedKeys.has(pin.citationKey), async () => {
      const outcome = await unpinScientProjectPinIfUnchanged({
        projectRoot: input.projectRoot,
        ...pin,
        actor: input.actor,
      });
      return outcome !== "changed";
    });
  }
  for (const pin of created.notes) {
    await step(`note on pin ${pin.citationKey}`, usedKeys.has(pin.citationKey), async () => {
      if (pin.note === null) return true;
      const outcome = await clearScientProjectPinNoteIfUnchanged({
        projectRoot: input.projectRoot,
        citationKey: pin.citationKey,
        sourceId: pin.sourceId,
        note: pin.note,
        actor: input.actor,
      });
      return outcome !== "changed";
    });
  }
  for (const { collectionId, updatedAt } of created.collections) {
    await step(`collection ${collectionId}`, usedCollections.has(collectionId), async () => {
      const change = await deleteScientSourceCollection({
        root: input.library,
        collectionId,
        actor: input.actor,
        expectedUpdatedAt: updatedAt,
      });
      return (
        change.outcome === "deleted" ||
        change.outcome === "not-found" ||
        change.collection?.deletedAt !== undefined
      );
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
  return { outcome: "undone", kept, left, retainedSourceIds };
}
