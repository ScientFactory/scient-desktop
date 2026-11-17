// @effect-diagnostics nodeBuiltinImport:off -- Categories share the source store's filesystem boundary.
import * as NodePath from "node:path";

import {
  ScientSourceCategoriesDocument,
  scientSourceCategoryBasis,
  scientSourceCategorySummary,
  type ScientSourceCategories,
  type ScientSourceCategorySummary,
} from "./categories.ts";
import type { ScientSourceStoreLocation } from "./libraryRoot.ts";
import type { ScientSourceIdentifier } from "./model.ts";
import { scientSourceStoreInternals } from "./store.ts";

/** `.scient/sources/categories.json` in a project, `categories.json` in the library. */
const SCIENT_SOURCE_CATEGORIES_FILE = "categories.json";
const MAX_CATEGORIES_BYTES = 32 * 1024 * 1024;
const { sourceStorePaths, snapshot, readBoundedJson, atomicWriteJson, withStoreLock } =
  scientSourceStoreInternals;

type Entries = Readonly<Record<string, ScientSourceCategories>>;

async function readEntries(base: string): Promise<Entries> {
  const filePath = NodePath.join(base, SCIENT_SOURCE_CATEGORIES_FILE);
  if ((await snapshot(filePath)) !== "file") return {};
  // Registry data is looked up again, so a damaged file is treated as empty and replaced.
  return readBoundedJson(filePath, MAX_CATEGORIES_BYTES, ScientSourceCategoriesDocument).then(
    (document) => document.sources,
    () => ({}),
  );
}

/**
 * Every stored entry by source ID, including ones whose source's identifiers have changed. A
 * project without a Library, or a file that cannot be read, has none.
 */
export async function readScientSourceCategories(
  root: ScientSourceStoreLocation,
): Promise<Entries> {
  try {
    return await readEntries((await sourceStorePaths(root)).base);
  } catch {
    return {};
  }
}

/** Sets (an entry) or forgets (null) the categories of some sources, keeping the rest. */
export async function writeScientSourceCategories(
  root: ScientSourceStoreLocation,
  changes: Readonly<Record<string, ScientSourceCategories | null>>,
): Promise<void> {
  const paths = await sourceStorePaths(root);
  await withStoreLock(paths, "categories-write", async () => {
    const next: Record<string, ScientSourceCategories> = { ...(await readEntries(paths.base)) };
    for (const [sourceId, entry] of Object.entries(changes)) {
      if (entry) next[sourceId] = entry;
      else delete next[sourceId];
    }
    await atomicWriteJson(
      NodePath.join(paths.base, SCIENT_SOURCE_CATEGORIES_FILE),
      { formatVersion: 1, sources: next } satisfies ScientSourceCategoriesDocument,
      MAX_CATEGORIES_BYTES,
    );
  });
}

/** The stored entry, when it was looked up by the source's current identifiers. */
export function currentScientSourceCategories(
  source: {
    readonly sourceId: string;
    readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  },
  entries: Entries,
): ScientSourceCategories | undefined {
  const entry = entries[source.sourceId];
  return entry && entry.basis === scientSourceCategoryBasis(source.identifiers) ? entry : undefined;
}

export function scientSourceCategorySummaryFor(
  source: {
    readonly sourceId: string;
    readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  },
  entries: Entries,
): ScientSourceCategorySummary | null {
  return scientSourceCategorySummary(currentScientSourceCategories(source, entries));
}
