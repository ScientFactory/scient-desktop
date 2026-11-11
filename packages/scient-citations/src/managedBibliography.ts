import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { formatBibliography } from "@scientfactory/scient-sources/bibliography";

const MANAGED_BIBTEX_HEADER =
  "% Written by Scient from this project's Library. Scient offers edits made here back as an import.\n";

export interface ManagedBibliographyContents {
  readonly bibtex: string;
  readonly cslJson: string;
  readonly keys: ReadonlyArray<string>;
}

/**
 * Both managed files, sorted by citation key, with the entries a Library export
 * writes minus notes (private) and abstracts (large, and no document needs them).
 * Sources without a key are left out.
 */
export function renderManagedBibliography(
  records: ReadonlyArray<ScientSourceRecord>,
): ManagedBibliographyContents {
  const items = records
    .flatMap((record) => (record.citationKey ? [{ record, citationKey: record.citationKey }] : []))
    .toSorted(
      (left, right) =>
        left.citationKey.localeCompare(right.citationKey, "en", { sensitivity: "base" }) ||
        left.citationKey.localeCompare(right.citationKey),
    );
  const options = { includeNotes: false, includeAbstracts: false };
  return {
    bibtex: `${MANAGED_BIBTEX_HEADER}\n${formatBibliography(items, "bibtex", options)}`,
    cslJson: formatBibliography(items, "csl-json", options),
    keys: items.map(({ citationKey }) => citationKey),
  };
}

/** Entry text by key, for comparing a hand-edited file with what Scient wrote. */
export function bibtexEntriesByKey(contents: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const starts = [...contents.matchAll(/^@\s*([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,/gmu)];
  for (const [index, match] of starts.entries()) {
    const type = match[1]?.toLowerCase();
    const key = match[2];
    if (!key || type === "comment" || type === "preamble" || type === "string") continue;
    const end = starts[index + 1]?.index ?? contents.length;
    entries.set(key, contents.slice(match.index, end).trim());
  }
  return entries;
}

export function cslJsonEntriesByKey(contents: string): ReadonlyMap<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries = new Map<string, string>();
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const id = (item as { readonly id?: unknown }).id;
    if (typeof id !== "string" && typeof id !== "number") return null;
    entries.set(String(id), JSON.stringify(item));
  }
  return entries;
}

export interface BibliographyEntryChanges {
  readonly added: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export function compareBibliographyEntries(
  written: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): BibliographyEntryChanges {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, entry] of current) {
    const previous = written.get(key);
    if (previous === undefined) added.push(key);
    else if (previous !== entry) changed.push(key);
  }
  const removed = [...written.keys()].filter((key) => !current.has(key));
  return { added, changed, removed };
}
