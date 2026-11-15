// @effect-diagnostics nodeBuiltinImport:off -- Displaced copies are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const DISPLACED_DIRECTORY = [".scient", "library", "displaced"] as const;
/** Newest kept per file; older ones are dropped as new ones arrive. */
const KEPT = 200;
const MAX_DISPLACED_BYTES = 16 * 1024 * 1024;

/**
 * A copy of a source's details that this project (its citation key, or one of its reviews) held
 * and that was replaced by the Library's record whole after a merge was undone, kept because it
 * had values the record lacks. Nothing reads these back on its own: they are for a person or an
 * agent who wants a value that was dropped.
 */
const ScientDisplacedCopy = Schema.Struct({
  at: Schema.String,
  sourceId: Schema.String,
  /** Where the copy was: the project's citation key, or a review's ID. */
  heldBy: Schema.String,
  /** The fields the copy had and the Library's record does not. */
  lost: Schema.Array(Schema.String),
  /** The copy as it was. */
  work: Schema.Unknown,
});
export type ScientDisplacedCopy = typeof ScientDisplacedCopy.Type;

const DisplacedFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  copies: Schema.Array(ScientDisplacedCopy),
});

function displacedPath(root: string, name: "project" | "reviews"): string {
  return NodePath.join(root, ...DISPLACED_DIRECTORY, `${name}.json`);
}

const present = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

/** The fields that have a value in the earlier copy and none in the one that replaces it. */
export function scientValuesLostBy(
  earlier: Readonly<Record<string, unknown>>,
  replacement: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  return Object.keys(earlier).filter((key) => present(earlier[key]) && !present(replacement[key]));
}

export async function readScientDisplacedCopies(
  root: string,
  name: "project" | "reviews",
): Promise<ReadonlyArray<ScientDisplacedCopy>> {
  const filePath = displacedPath(root, name);
  if ((await snapshot(filePath)) !== "file") return [];
  return (await readBoundedJson(filePath, MAX_DISPLACED_BYTES, DisplacedFile)).copies;
}

/**
 * Keeps the copies before they are replaced. The caller holds the lock of the file the copies
 * come from (the pins lock for `project`, the reviews lock for `reviews`), which also orders
 * these writes. A copy already kept as the newest of its holder is not kept twice, so a
 * replacement that is retried after a stop adds nothing.
 */
export async function keepScientDisplacedCopies(
  root: string,
  name: "project" | "reviews",
  copies: ReadonlyArray<Omit<ScientDisplacedCopy, "at">>,
): Promise<void> {
  if (copies.length === 0) return;
  const kept = [...(await readScientDisplacedCopies(root, name).catch(() => []))];
  const at = new Date().toISOString();
  for (const copy of copies) {
    const last = kept.findLast(
      (entry) => entry.sourceId === copy.sourceId && entry.heldBy === copy.heldBy,
    );
    if (last && JSON.stringify(last.work) === JSON.stringify(copy.work)) continue;
    kept.push({ at, ...copy });
  }
  await atomicWriteJson(
    displacedPath(root, name),
    { formatVersion: 1, copies: kept.slice(-KEPT) },
    MAX_DISPLACED_BYTES,
  );
}
