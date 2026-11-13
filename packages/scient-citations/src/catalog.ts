import bundled from "./bundledStyles.json" with { type: "json" };
import { CSL_STYLE_ID_PATTERN, readCslStyle } from "./cslStyle.ts";

export interface CslCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly titleShort: string | null;
  readonly dependent: boolean;
  readonly bundled: boolean;
}

const bundledXml = new Map(bundled.styles.map((style) => [style.id, style.xml]));

/** Common styles that work without a network, unmodified from the CSL styles repository. */
export const BUNDLED_CSL_STYLES: ReadonlyArray<CslCatalogEntry> = bundled.styles.map((style) => {
  const info = readCslStyle(style.xml);
  if (info === null || info.parentId !== null)
    throw new Error(`Bundled style ${style.id} is invalid.`);
  return {
    id: style.id,
    title: info.title,
    titleShort: info.titleShort,
    dependent: false,
    bundled: true,
  };
});

export function bundledCslStyleXml(id: string): string | null {
  return bundledXml.get(id) ?? null;
}

/**
 * Reads the Zotero Style Repository's index (`styles-files/styles.json`): an array of
 * `{ name, title, titleShort?, dependent }`. Entries it cannot use are left out.
 */
export function parseCslStyleIndex(value: unknown): ReadonlyArray<CslCatalogEntry> | null {
  if (!Array.isArray(value)) return null;
  const entries: Array<CslCatalogEntry> = [];
  for (const item of value as ReadonlyArray<unknown>) {
    if (typeof item !== "object" || item === null) continue;
    const { name, title, titleShort, dependent } = item as Record<string, unknown>;
    if (typeof name !== "string" || !CSL_STYLE_ID_PATTERN.test(name)) continue;
    if (typeof title !== "string" || title.trim() === "") continue;
    entries.push({
      id: name,
      title: title.trim(),
      titleShort: typeof titleShort === "string" && titleShort.trim() ? titleShort.trim() : null,
      dependent: dependent === 1 || dependent === true,
      bundled: bundledXml.has(name),
    });
  }
  return entries.length > 0 ? entries : null;
}

function normalized(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(text: string): ReadonlyArray<string> {
  return normalized(text).split(" ").filter(Boolean);
}

/**
 * Lower ranks first: an exact name, then a bundled style, then a name that starts with the
 * query, then any name with all its words. "Harvard" offers the common Harvard styles first.
 */
function rank(entry: CslCatalogEntry, query: string, terms: ReadonlyArray<string>): number | null {
  const names = [entry.title, entry.titleShort ?? "", entry.id].map(normalized);
  if (names.includes(query)) return 0;
  const known = names.flatMap((name) => name.split(" "));
  if (!terms.every((term) => known.some((word) => word.startsWith(term)))) return null;
  if (entry.bundled) return 1;
  return names.some((name) => name.startsWith(`${query} `)) ? 2 : 3;
}

/** Finds styles by journal or style name; independent styles before journal variants. */
export function searchCslCatalog(
  entries: ReadonlyArray<CslCatalogEntry>,
  query: string,
  limit: number,
): ReadonlyArray<CslCatalogEntry> {
  const text = normalized(query);
  if (text === "") return entries.filter((entry) => entry.bundled).slice(0, limit);
  const terms = words(query);
  return entries
    .flatMap((entry) => {
      const score = rank(entry, text, terms);
      return score === null ? [] : [{ entry, score }];
    })
    .toSorted(
      (a, b) =>
        a.score - b.score ||
        Number(a.entry.dependent) - Number(b.entry.dependent) ||
        a.entry.title.length - b.entry.title.length ||
        a.entry.title.localeCompare(b.entry.title),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}
