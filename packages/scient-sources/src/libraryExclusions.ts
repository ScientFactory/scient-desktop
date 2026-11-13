// @effect-diagnostics nodeBuiltinImport:off -- Merge receipts and distinct pairs are library files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { readLibraryAliasesAt, resolveScientLibraryAlias } from "./libraryAliases.ts";
import type { ScientLibraryAliases } from "./libraryAliases.ts";
import { ScientLibraryMerge } from "./libraryMergeReceipt.ts";
import { pairKey } from "./libraryDuplicates.ts";
import { ScientSourceActor } from "./model.ts";
import type { ScientLibraryIdentityProblem } from "./sourceIdentity.ts";
import { readBoundedJson, snapshot } from "./storeFiles.ts";

export const SCIENT_LIBRARY_MERGES_DIRECTORY = "merges";
const DISTINCT_PAIRS_FILE = "distinct-pairs.json";
export const SCIENT_LIBRARY_MAX_MERGE_BYTES = 8 * 1024 * 1024;
export const SCIENT_LIBRARY_MAX_DISTINCT_PAIRS_BYTES = 16 * 1024 * 1024;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

export const ScientLibraryDistinctPair = Schema.Struct({
  sourceIds: Schema.Tuple([NonEmptyString, NonEmptyString]),
  /** A person's or agent's decision, or copies of one project that diverged (written by the move). */
  reason: Schema.Literals(["marked-distinct", "divergent-copies"]),
  markedAt: NonEmptyString,
  markedBy: ScientSourceActor,
});
export type ScientLibraryDistinctPair = typeof ScientLibraryDistinctPair.Type;
const DistinctPairsFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  pairs: Schema.Array(ScientLibraryDistinctPair),
});

/** A receipt this Scient cannot read, with the source IDs still legible in it. */
export interface ScientLibraryDamagedReceipt {
  readonly mergeId: string;
  readonly sourceIds: ReadonlyArray<string>;
}

export async function readScientLibraryDistinctPairs(
  root: string,
): Promise<ReadonlyArray<ScientLibraryDistinctPair>> {
  const filePath = NodePath.join(root, DISTINCT_PAIRS_FILE);
  const state = await snapshot(filePath);
  if (state === "missing") return [];
  if (state !== "file") throw new Error(`${DISTINCT_PAIRS_FILE} is not a safe regular file.`);
  return (
    await readBoundedJson(filePath, SCIENT_LIBRARY_MAX_DISTINCT_PAIRS_BYTES, DistinctPairsFile)
  ).pairs;
}

export function scientLibraryDistinctPairsPath(root: string): string {
  return NodePath.join(root, DISTINCT_PAIRS_FILE);
}

async function legibleSourceIds(filePath: string): Promise<ReadonlyArray<string>> {
  const stats = await NodeFSP.lstat(filePath).catch(() => null);
  if (!stats?.isFile()) return [];
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stats.size, SCIENT_LIBRARY_MAX_MERGE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return [
      ...new Set(
        [...text.matchAll(/"(?:survivorId|loserId)"\s*:\s*"([^"\\]+)"/gu)].map(
          (match) => match[1]!,
        ),
      ),
    ];
  } finally {
    await handle.close();
  }
}

/**
 * Every merge receipt in `merges/`, decoded whole (the engine's own schema). Receipts are never pruned: they hold
 * the Undo decisions. One that cannot be read is returned as damaged, never skipped silently.
 */
export async function readScientLibraryMergeReceipts(root: string): Promise<{
  readonly receipts: ReadonlyArray<ScientLibraryMerge>;
  readonly damaged: ReadonlyArray<ScientLibraryDamagedReceipt>;
}> {
  const directory = NodePath.join(root, SCIENT_LIBRARY_MERGES_DIRECTORY);
  if ((await snapshot(directory)) !== "directory") return { receipts: [], damaged: [] };
  const receipts: Array<ScientLibraryMerge> = [];
  const damaged: ScientLibraryDamagedReceipt[] = [];
  const entries = (await NodeFSP.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".json")) continue;
    const filePath = NodePath.join(directory, entry.name);
    try {
      receipts.push(
        await readBoundedJson(filePath, SCIENT_LIBRARY_MAX_MERGE_BYTES, ScientLibraryMerge),
      );
    } catch {
      damaged.push({
        mergeId: entry.name.slice(0, -".json".length),
        sourceIds: await legibleSourceIds(filePath).catch(() => []),
      });
    }
  }
  return { receipts, damaged };
}

export interface ScientLibraryExclusions {
  readonly isDistinct: (left: string, right: string) => boolean;
  /** Why a pair that agrees is still never merged automatically, or null. */
  readonly keptApart: (left: string, right: string) => ScientLibraryIdentityProblem | null;
  /** IDs a live merge alias still forwards; a new record must not take one. */
  readonly forwarded: (sourceId: string) => boolean;
  readonly damaged: ReadonlyArray<ScientLibraryDamagedReceipt>;
}

/**
 * Distinct pairs, undone merges and merges whose Undo stopped after bringing the merged-away
 * source back. Aliases are followed, except one whose merged-away source is live again, so neither
 * a later merge of either side nor a third copy reunites them. A damaged receipt keeps every record
 * it still names out of automatic merging, and every record when it names none.
 */
export function scientLibraryExclusionsFrom(input: {
  readonly distinctPairs: ReadonlyArray<ScientLibraryDistinctPair>;
  readonly receipts: ReadonlyArray<Pick<ScientLibraryMerge, "survivorId" | "loserId" | "state">>;
  readonly damaged: ReadonlyArray<ScientLibraryDamagedReceipt>;
  readonly aliases: ScientLibraryAliases;
  readonly live: ReadonlySet<string>;
}): ScientLibraryExclusions {
  const aliases = new Map(
    [...input.aliases].filter(([sourceId, alias]) => !input.live.has(sourceId) && !alias.undoneAt),
  );
  const resolve = (sourceId: string) => resolveScientLibraryAlias(aliases, sourceId);
  const index = (pairs: ReadonlyArray<readonly [string, string]>) => {
    const keys = new Set<string>();
    for (const [left, right] of pairs) {
      const [leftId, rightId] = [resolve(left), resolve(right)];
      if (leftId !== rightId) keys.add(pairKey(leftId, rightId));
    }
    return (left: string, right: string) => keys.has(pairKey(resolve(left), resolve(right)));
  };
  const isDistinct = index(input.distinctPairs.map((pair) => pair.sourceIds));
  const wasUnmerged = index(
    input.receipts
      .filter(
        (receipt) =>
          receipt.state === "undone" ||
          (receipt.state === "done" && input.live.has(receipt.loserId)),
      )
      .map((receipt) => [receipt.survivorId, receipt.loserId] as const),
  );
  const unreadableAll = input.damaged.some((receipt) => receipt.sourceIds.length === 0);
  const unreadable = new Set(
    input.damaged.flatMap((receipt) => receipt.sourceIds.flatMap((id) => [id, resolve(id)])),
  );
  return {
    isDistinct,
    keptApart: (left, right) =>
      wasUnmerged(left, right)
        ? "merge-undone"
        : unreadableAll ||
            [left, right].some((id) => unreadable.has(id) || unreadable.has(resolve(id)))
          ? "merge-record-unreadable"
          : null,
    forwarded: (sourceId) => resolve(sourceId) !== sourceId,
    damaged: input.damaged,
  };
}

/** The exclusions of the library at `root`, for intake: which records may be reused. */
export async function readScientLibraryExclusions(
  root: string,
  live: ReadonlySet<string>,
): Promise<ScientLibraryExclusions> {
  const [distinctPairs, { receipts, damaged }, aliases] = await Promise.all([
    readScientLibraryDistinctPairs(root),
    readScientLibraryMergeReceipts(root),
    readLibraryAliasesAt(root),
  ]);
  return scientLibraryExclusionsFrom({ distinctPairs, receipts, damaged, aliases, live });
}
