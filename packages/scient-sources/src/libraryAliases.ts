// @effect-diagnostics nodeBuiltinImport:off -- Aliases are a file in the personal library.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { ScientLibraryLocation } from "./libraryRoot.ts";
import { atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const SCIENT_LIBRARY_ALIASES_FILE = "aliases.json";
const MAX_ALIASES_BYTES = 32 * 1024 * 1024;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

export const ScientLibraryAlias = Schema.Struct({
  /** The merged source's ID, which pins, reviews and links may still name. */
  sourceId: NonEmptyString,
  survivorId: NonEmptyString,
  mergeId: NonEmptyString,
  mergedAt: NonEmptyString,
  /** Set by the merge's Undo. The entry stays as a tombstone so sync never brings the alias back. */
  undoneAt: Schema.optionalKey(NonEmptyString),
});
export type ScientLibraryAlias = typeof ScientLibraryAlias.Type;

const ScientLibraryAliasesFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  aliases: Schema.Array(ScientLibraryAlias),
});

/** Aliases by merged source ID. */
export type ScientLibraryAliases = ReadonlyMap<string, ScientLibraryAlias>;

function aliasesPath(root: string): string {
  return NodePath.join(root, SCIENT_LIBRARY_ALIASES_FILE);
}

/** Reads `aliases.json` at a canonical library root; a missing file means no merge ran yet. */
export async function readLibraryAliasesAt(root: string): Promise<Map<string, ScientLibraryAlias>> {
  const filePath = aliasesPath(root);
  const state = await snapshot(filePath);
  if (state === "missing") return new Map();
  if (state !== "file")
    throw new Error(`${SCIENT_LIBRARY_ALIASES_FILE} is not a safe regular file.`);
  const { aliases } = await readBoundedJson(filePath, MAX_ALIASES_BYTES, ScientLibraryAliasesFile);
  return new Map(aliases.map((alias) => [alias.sourceId, alias]));
}

/** Caller holds the library lock. Sorted by ID so two computers' files differ only where they must. */
export async function writeLibraryAliasesAt(
  root: string,
  aliases: ReadonlyMap<string, ScientLibraryAlias>,
): Promise<void> {
  await atomicWriteJson(
    aliasesPath(root),
    {
      formatVersion: 1,
      aliases: [...aliases.values()].toSorted((left, right) =>
        left.sourceId.localeCompare(right.sourceId),
      ),
    },
    MAX_ALIASES_BYTES,
  );
}

export async function readScientLibraryAliases(
  library: ScientLibraryLocation,
): Promise<ScientLibraryAliases> {
  return readLibraryAliasesAt(await NodeFSP.realpath(library.root));
}

/**
 * The ID a source ID stands for now: aliases are followed to the last survivor, skipping
 * tombstones. An ID with no alias stands for itself. The project instance map resolves through
 * this too, so pins, reviews, annotation hints and links all agree.
 */
export function resolveScientLibraryAlias(aliases: ScientLibraryAliases, sourceId: string): string {
  let current = sourceId;
  const seen = new Set([current]);
  while (true) {
    const alias = aliases.get(current);
    if (!alias || alias.undoneAt !== undefined || seen.has(alias.survivorId)) return current;
    current = alias.survivorId;
    seen.add(current);
  }
}
