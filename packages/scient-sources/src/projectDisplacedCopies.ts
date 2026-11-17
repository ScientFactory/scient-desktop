// @effect-diagnostics nodeBuiltinImport:off -- Displaced copies are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const DISPLACED_DIRECTORY = [".scient", "library", "displaced"] as const;
const MAX_DISPLACED_BYTES = 64 * 1024 * 1024;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** How a copy was captured, not what it says: two copies that differ only here are the same. */
const CAPTURE_FIELDS = new Set(["capturedAt", "capturedRevision"]);

/**
 * A copy of a source's details that this project (a citation key, or a review) held and that was
 * replaced by the Library's record whole after a merge was undone. It is kept because it differs
 * from that record: it may hold the other paper's values, or this paper's that the record lacks.
 * Nothing reads these back on its own; they are for a person or an agent who wants one.
 */
const ScientDisplacedCopy = Schema.Struct({
  at: Schema.String,
  /** The Library source the copy stood for. */
  sourceId: Schema.String,
  /** Where the copy was: the project's citation key, or the review's ID. */
  heldBy: Schema.String,
  /** When the merge was undone; one copy is kept per holder, source and Undo. */
  undoneAt: Schema.String,
  /** The fields whose values the replacement changed or dropped. */
  differs: Schema.Array(Schema.String),
  /** The copy as it was. */
  work: Schema.Unknown,
});
export type ScientDisplacedCopy = typeof ScientDisplacedCopy.Type;

const DisplacedFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  copies: Schema.Array(ScientDisplacedCopy),
});

/** The project's citation keys share one file; each review has its own, as its snapshot does. */
export type ScientDisplacedHolder =
  | { readonly kind: "project" }
  | { readonly kind: "review"; readonly reviewId: string };

function displacedPath(root: string, holder: ScientDisplacedHolder): string {
  if (holder.kind === "project") return NodePath.join(root, ...DISPLACED_DIRECTORY, "project.json");
  const name = SAFE_FILE_ID.test(holder.reviewId)
    ? holder.reviewId
    : `id-${NodeCrypto.createHash("sha256").update(holder.reviewId).digest("hex").slice(0, 32)}`;
  return NodePath.join(root, ...DISPLACED_DIRECTORY, "reviews", `${name}.json`);
}

/** The fields that say something else, or nothing, once the replacement stands. */
export function scientValuesChangedBy(
  earlier: Readonly<Record<string, unknown>>,
  replacement: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  return [...new Set([...Object.keys(earlier), ...Object.keys(replacement)])].filter(
    (key) =>
      !CAPTURE_FIELDS.has(key) &&
      JSON.stringify(earlier[key] ?? null) !== JSON.stringify(replacement[key] ?? null),
  );
}

export async function readScientDisplacedCopies(
  root: string,
  holder: ScientDisplacedHolder,
): Promise<ReadonlyArray<ScientDisplacedCopy>> {
  const filePath = displacedPath(root, holder);
  if ((await snapshot(filePath)) !== "file") return [];
  return (await readBoundedJson(filePath, MAX_DISPLACED_BYTES, DisplacedFile)).copies;
}

/**
 * Keeps the copies before they are replaced; a failure here stops the replacement. The caller
 * holds the lock of the file the copies come from. One copy is kept per holder, source and
 * Undo. A file that cannot be read is moved aside under a dated name, never overwritten.
 */
export async function keepScientDisplacedCopies(
  root: string,
  holder: ScientDisplacedHolder,
  copies: ReadonlyArray<Omit<ScientDisplacedCopy, "at">>,
): Promise<void> {
  if (copies.length === 0) return;
  const filePath = displacedPath(root, holder);
  const kept = [
    ...(await readScientDisplacedCopies(root, holder).catch(async () => {
      await NodeFSP.rename(filePath, `${filePath}.unreadable-${Date.now()}`);
      return [];
    })),
  ];
  const key = (copy: Pick<ScientDisplacedCopy, "sourceId" | "heldBy" | "undoneAt">) =>
    JSON.stringify([copy.heldBy, copy.sourceId, copy.undoneAt]);
  const known = new Set(kept.map(key));
  const at = new Date().toISOString();
  const before = kept.length;
  for (const copy of copies) {
    if (known.has(key(copy))) continue;
    known.add(key(copy));
    kept.push({ at, ...copy });
  }
  if (kept.length === before) return;
  await atomicWriteJson(filePath, { formatVersion: 1, copies: kept }, MAX_DISPLACED_BYTES);
}
