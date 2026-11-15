import type { ScientSourceImportOperation, ScientSourceNotBrought } from "./model.ts";

/**
 * One thing an import did not bring, across the whole import: how many, and for which sources.
 * The Sources panel and an agent's import result name it with the same words, from here.
 */
export interface NotBroughtLine {
  readonly kind: ScientSourceNotBrought["kind"];
  readonly name: string | null;
  readonly count: number;
  /** The imported sources it concerns; empty for what belongs to no reference. */
  readonly sourceIds: ReadonlyArray<string>;
}

/** Zotero's field names a researcher would not recognise, in the words Zotero's own screen uses. */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  place: "Place of publication",
  numPages: "Number of pages",
  numberOfVolumes: "Number of volumes",
  shortTitle: "Short title",
  callNumber: "Call number",
  archiveLocation: "Location in archive",
  libraryCatalog: "Library catalogue",
  accessDate: "Date accessed",
  journalAbbreviation: "Journal abbreviation",
  seriesTitle: "Series title",
  seriesText: "Series text",
  seriesNumber: "Series number",
  conferenceName: "Conference name",
  meetingName: "Meeting name",
  reportNumber: "Report number",
  reportType: "Report type",
  thesisType: "Thesis type",
  websiteType: "Website type",
  programmingLanguage: "Programming language",
  versionNumber: "Version",
  runningTime: "Running time",
  originalDate: "Original date",
  publicationTitle: "Publication title",
  bookTitle: "Book title",
  proceedingsTitle: "Proceedings title",
};

/** `numPages` → "Num pages": a field with no name above is said in Zotero's own word, spaced. */
function spaced(name: string): string {
  // An abbreviation (PMCID) is already what Zotero shows.
  if (!/[a-z]/u.test(name)) return name;
  const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const FILE_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^text\/html$/u, "Web page snapshots"],
  [/^application\/epub\+zip$/u, "EPUB files"],
  [/^image\//u, "Images"],
  [/wordprocessingml|msword/u, "Word documents"],
  [/spreadsheetml|ms-excel/u, "Spreadsheets"],
  [/presentationml|ms-powerpoint/u, "Slides"],
  [/^text\//u, "Text files"],
];

/** What was not brought, as a person would name it. */
export function notBroughtName(line: Pick<NotBroughtLine, "kind" | "name">): string {
  const name = line.name ?? "";
  switch (line.kind) {
    case "field":
      return FIELD_NAMES[name] ?? spaced(name);
    case "extra":
      return name === "(text)" ? "Other text in Extra" : `Extra line “${name}”`;
    case "file":
      return (
        FILE_KINDS.find(([pattern]) => pattern.test(name))?.[1] ??
        (name === "unknown" ? "Files of an unknown kind" : `Files (${name})`)
      );
    case "link":
      return "Links kept as attachments";
    case "pdf":
      return name === "over-limit"
        ? "PDFs beyond the first 10 of a reference"
        : "PDFs Zotero could not hand over";
    case "note-cut":
      return "Notes cut at 100,000 characters";
    case "note-formatting":
      return "Notes whose links, headings, tables, images or code became plain text";
    case "highlights":
      return "Highlights and comments on PDFs";
    case "related":
      return "Links to related items";
    case "automatic-tags":
      return "Automatic tags, which came in as ordinary tags";
    case "notes-alone":
      return "Notes that belong to no reference";
    case "files-alone":
      return "Files that belong to no reference";
    case "alone-uncounted":
      return "Notes and files that belong to no reference: Zotero did not say how many";
    case "already-here":
      return "References that were already in your Library: nothing was taken from Zotero's copy (its notes, files and details)";
  }
}

const references = (count: number) =>
  count === 1 ? "1 reference" : `${count.toLocaleString()} references`;

/** How many, in the unit that fits: references for a field, items for countable things. */
export function notBroughtAmount(line: NotBroughtLine): string {
  const on = line.sourceIds.length;
  if (line.kind === "notes-alone" || line.kind === "files-alone") {
    return line.count.toLocaleString();
  }
  if (line.kind === "alone-uncounted") return "not counted";
  if (line.kind === "already-here") return references(line.count);
  // A field or a line is there once per reference, so the references are the count.
  if (line.kind === "field" || line.kind === "extra" || line.kind === "note-cut") {
    return references(on);
  }
  return `${line.count.toLocaleString()} on ${references(on)}`;
}

/**
 * Everything an import did not bring, one line per thing, most references first; what
 * belongs to no reference comes last.
 */
export function summarizeNotBrought(
  operation: Pick<ScientSourceImportOperation, "items" | "notBrought"> &
    Partial<Pick<ScientSourceImportOperation, "adapter">>,
): ReadonlyArray<NotBroughtLine> {
  const lines = new Map<string, { line: NotBroughtLine; sourceIds: Set<string> }>();
  const alreadyHere = operation.items.filter(
    (item) =>
      item.state === "skipped" &&
      item.duplicateKind !== undefined &&
      item.duplicateKind !== "same-origin" &&
      item.duplicateKind !== "new",
  );
  for (const item of operation.items) {
    if (item.state !== "imported" || !item.sourceId) continue;
    for (const entry of item.notBrought ?? []) {
      const key = `${entry.kind}\0${entry.name ?? ""}`;
      const found = lines.get(key) ?? {
        line: { kind: entry.kind, name: entry.name ?? null, count: 0, sourceIds: [] },
        sourceIds: new Set<string>(),
      };
      found.line = { ...found.line, count: found.line.count + entry.count };
      found.sourceIds.add(item.sourceId);
      lines.set(key, found);
    }
  }
  return [
    ...[...lines.values()]
      .map(({ line, sourceIds }) => ({ ...line, sourceIds: [...sourceIds] }))
      .toSorted(
        (left, right) =>
          right.sourceIds.length - left.sourceIds.length ||
          notBroughtName(left).localeCompare(notBroughtName(right)),
      ),
    // A Zotero item that was already here under another origin (the same DOI, a possible
    // match) was skipped whole: what Zotero holds for it was not looked at.
    ...(operation.adapter?.startsWith("zotero") && alreadyHere.length > 0
      ? [
          {
            kind: "already-here" as const,
            name: null,
            count: alreadyHere.length,
            sourceIds: [...new Set(alreadyHere.flatMap((item) => item.sourceId ?? []))],
          },
        ]
      : []),
    ...(operation.notBrought ?? []).map((entry) => ({
      kind: entry.kind,
      name: entry.name ?? null,
      count: entry.count,
      sourceIds: [],
    })),
  ];
}
