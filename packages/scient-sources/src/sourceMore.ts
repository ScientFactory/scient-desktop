/**
 * The bibliographic details a source may have beyond its own fields, each under the CSL
 * variable it is cited with (`edition`, `publisher-place`), so that what is kept is also what
 * a citation uses. `extra` is not a CSL variable: it keeps, as written, the lines of a
 * reference manager's free-text field that are none of the others.
 */
const MORE = [
  ["edition", "text", "Edition"],
  ["publisher-place", "text", "Place of publication"],
  ["collection-title", "text", "Series"],
  ["collection-number", "text", "Number in series"],
  ["number-of-pages", "text", "Number of pages"],
  ["number-of-volumes", "text", "Number of volumes"],
  ["title-short", "text", "Short title"],
  ["container-title-short", "text", "Journal abbreviation"],
  ["original-title", "text", "Original title"],
  ["volume-title", "text", "Title of the volume"],
  ["part-number", "text", "Part number"],
  ["part-title", "text", "Title of the part"],
  ["chapter-number", "text", "Chapter number"],
  ["event-title", "text", "Conference or event"],
  ["event-place", "text", "Place of the event"],
  ["event-date", "date", "Date of the event"],
  ["genre", "text", "Kind (thesis type, report type, …)"],
  ["medium", "text", "Medium or format"],
  ["number", "text", "Number (report, patent, …)"],
  ["version", "text", "Version"],
  ["authority", "text", "Issuing body or court"],
  ["section", "text", "Section"],
  ["status", "text", "Status"],
  ["archive", "text", "Archive"],
  ["archive_location", "text", "Location in archive"],
  ["archive-place", "text", "Place of the archive"],
  ["archive_collection", "text", "Collection in archive"],
  ["call-number", "text", "Call number"],
  ["source", "text", "Library catalogue"],
  ["license", "text", "Rights"],
  ["dimensions", "text", "Size or running time"],
  ["scale", "text", "Scale"],
  ["references", "text", "History or references"],
  ["original-publisher", "text", "Original publisher"],
  ["original-publisher-place", "text", "Original place of publication"],
  ["original-date", "date", "Original date"],
  ["accessed", "date", "Date accessed"],
  ["submitted", "date", "Date filed"],
  ["extra", "text", "Extra"],
] as const;

export type ScientSourceMoreName = (typeof MORE)[number][0];

/** Every name `more` may hold, with whether it is a date and what a person calls it. */
export const SCIENT_SOURCE_MORE_FIELDS: ReadonlyArray<{
  readonly name: ScientSourceMoreName;
  readonly kind: "text" | "date";
  readonly label: string;
}> = MORE.map(([name, kind, label]) => ({ name, kind, label }));

const KNOWN: ReadonlyMap<string, (typeof SCIENT_SOURCE_MORE_FIELDS)[number]> = new Map(
  SCIENT_SOURCE_MORE_FIELDS.map((field) => [field.name, field]),
);

const SCIENT_SOURCE_MORE_LIMITS = { entries: 40, value: 2_000, extra: 10_000 } as const;

/** What a person calls one of these details. */
export const scientSourceMoreLabel = (name: string): string => KNOWN.get(name)?.label ?? name;

export const isScientSourceMoreName = (name: string): name is ScientSourceMoreName =>
  KNOWN.has(name);

export const scientSourceMoreKind = (name: string): "text" | "date" =>
  KNOWN.get(name)?.kind ?? "text";

/** Whether a whole map is one a record may keep: known names, text that fits, not too many. */
export function isValidScientSourceMore(more: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(more);
  return (
    entries.length <= SCIENT_SOURCE_MORE_LIMITS.entries &&
    entries.every(
      ([name, value]) =>
        KNOWN.has(name) &&
        value.trim().length > 0 &&
        value.length <=
          (name === "extra" ? SCIENT_SOURCE_MORE_LIMITS.extra : SCIENT_SOURCE_MORE_LIMITS.value),
    )
  );
}

/**
 * Entries as a record may keep them, in the list's order: trimmed, empty ones dropped.
 * Nothing is ever cut to fit: an entry with an unknown name, or text too long, or one past
 * the limit, is returned in `left` so the caller can say it was not kept.
 */
export function normalizeScientSourceMore(input: Readonly<Record<string, string>> | undefined): {
  readonly more: Readonly<Record<string, string>> | null;
  readonly left: ReadonlyArray<string>;
} {
  const kept: Record<string, string> = {};
  const left: string[] = [];
  const given = new Map(
    Object.entries(input ?? {}).flatMap(([name, value]) => {
      const text = value.trim();
      return text ? [[name, text] as const] : [];
    }),
  );
  for (const name of given.keys()) if (!KNOWN.has(name)) left.push(name);
  for (const { name } of SCIENT_SOURCE_MORE_FIELDS) {
    const value = given.get(name);
    if (value === undefined) continue;
    const limit =
      name === "extra" ? SCIENT_SOURCE_MORE_LIMITS.extra : SCIENT_SOURCE_MORE_LIMITS.value;
    if (value.length > limit || Object.keys(kept).length >= SCIENT_SOURCE_MORE_LIMITS.entries) {
      left.push(name);
    } else {
      kept[name] = value;
    }
  }
  return { more: Object.keys(kept).length > 0 ? kept : null, left };
}
