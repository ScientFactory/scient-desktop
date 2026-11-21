// @effect-diagnostics nodeBuiltinImport:off -- Displaced copies are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { assertScientProjectDirectory } from "./projectFiles.ts";
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
 * Nothing puts them back on its own; source details show them, for a person to copy a value from.
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

/** False when the folder is not there; throws when it, or a folder above it, is a link. */
async function safeFolder(root: string, folder: string): Promise<boolean> {
  try {
    await assertScientProjectDirectory(root, folder);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readScientDisplacedCopies(
  root: string,
  holder: ScientDisplacedHolder,
): Promise<ReadonlyArray<ScientDisplacedCopy>> {
  const canonicalRoot = await NodeFSP.realpath(root);
  const filePath = displacedPath(canonicalRoot, holder);
  if (!(await safeFolder(canonicalRoot, NodePath.dirname(filePath)))) return [];
  if ((await snapshot(filePath)) !== "file") return [];
  return (await readBoundedJson(filePath, MAX_DISPLACED_BYTES, DisplacedFile)).copies;
}

type DisplacedHolderKind = "citation-key" | "review";

/** `holder` says whether `heldBy` is a citation key or a review's ID. */
export type ScientDisplacedCopyInProject = ScientDisplacedCopy & {
  readonly holder: DisplacedHolderKind;
};

/**
 * Gives `visit` every kept copy in the project, file by file, and returns how many files could
 * not be read, counting ones already set aside as such and a linked folder as one.
 */
async function visitDisplacedCopies(
  root: string,
  visit: (copy: ScientDisplacedCopy, holder: DisplacedHolderKind) => void,
): Promise<number> {
  const canonicalRoot = await NodeFSP.realpath(root);
  const directory = NodePath.join(canonicalRoot, ...DISPLACED_DIRECTORY);
  const folders = [
    { path: directory, holder: "citation-key" },
    { path: NodePath.join(directory, "reviews"), holder: "review" },
  ] as const;
  let unreadable = 0;
  for (const folder of folders) {
    const present = await safeFolder(canonicalRoot, folder.path).catch(() => null);
    if (present === null) {
      unreadable += 1;
      break;
    }
    if (!present) continue;
    for (const name of (await NodeFSP.readdir(folder.path)).toSorted()) {
      const filePath = NodePath.join(folder.path, name);
      if (name.includes(".unreadable-")) {
        unreadable += 1;
        continue;
      }
      if (!name.endsWith(".json") || (await snapshot(filePath)) !== "file") continue;
      try {
        const read = await readBoundedJson(filePath, MAX_DISPLACED_BYTES, DisplacedFile);
        for (const copy of read.copies) visit(copy, folder.holder);
      } catch {
        unreadable += 1;
      }
    }
  }
  return unreadable;
}

/** One source's kept copies in the project, whoever held them and whether or not that holder remains. */
export async function readScientDisplacedCopiesOf(
  root: string,
  sourceId: string,
): Promise<ReadonlyArray<ScientDisplacedCopyInProject>> {
  const copies: Array<ScientDisplacedCopyInProject> = [];
  await visitDisplacedCopies(root, (copy, holder) => {
    if (copy.sourceId === sourceId) copies.push({ ...copy, holder });
  });
  return copies;
}

/** How many kept copies the project holds, and how many of their files could not be read. */
export async function countScientDisplacedCopiesInProject(
  root: string,
): Promise<{ readonly copies: number; readonly unreadable: number }> {
  let copies = 0;
  const unreadable = await visitDisplacedCopies(root, () => {
    copies += 1;
  });
  return { copies, unreadable };
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
  const canonicalRoot = await NodeFSP.realpath(root);
  const filePath = displacedPath(canonicalRoot, holder);
  // Before anything is read or moved aside: a linked folder would reach another checkout.
  await assertScientProjectDirectory(canonicalRoot, NodePath.dirname(filePath), { create: true });
  const kept = [
    ...(await readScientDisplacedCopies(canonicalRoot, holder).catch(async () => {
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
