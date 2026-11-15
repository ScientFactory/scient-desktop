import type {
  ScientSourceImportOperation,
  ScientSourcesFileImportResult,
} from "@t3tools/contracts";

type Report = ScientSourcesFileImportResult["report"];
type Item = ScientSourceImportOperation["items"][number];

/** How many of one item each kind of note names before it counts them instead. */
const NAMED_IN_NOTES = 2;
const FIELDS_SHOWN = 4;
const TITLE_LENGTH = 60;

export const countOf = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

export interface ReferenceFileNotes {
  /** Short sentences about what did not go as the file says, most important first. */
  readonly notes: ReadonlyArray<string>;
  /** Each entry those notes count, one line each, for the full receipt. */
  readonly details: ReadonlyArray<string>;
}

/**
 * The exceptions of one reference file import, from its report and the finished items: the
 * same work given twice, keys this project already uses, short author lists, entries that
 * could not be read, PDFs not attached and fields not kept.
 */
export function referenceFileNotes(input: {
  readonly report: Report;
  readonly items: ReadonlyArray<Item>;
  readonly sourceTitle?: ((sourceId: string) => string | null) | undefined;
}): ReferenceFileNotes {
  const { report, items } = input;
  const notes: string[] = [];
  const details: string[] = [];
  const nameOf = (item: Item | undefined, fallback: string) => {
    const title = item?.sourceId ? input.sourceTitle?.(item.sourceId) : null;
    if (!title) return fallback;
    return title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : title;
  };

  const sameWork = report.sameWork ?? [];
  if (sameWork.length > 0) {
    const said = sameWork.map((entry) =>
      entry.identifier === null && entry.citationKey === entry.sameAs
        ? `${entry.citationKey} appears twice in the file`
        : `${entry.citationKey} cites the same paper as ${entry.sameAs}`,
    );
    const readable = report.entryCount - report.unreadableCount;
    const works = readable - sameWork.length;
    notes.push(
      `${countOf(readable, "entry", "entries")} describe ${countOf(works, "work", "works")}; ${
        sameWork.length === 1 ? said[0] : "each repeated entry's key cites the work it repeats"
      }`,
    );
    if (sameWork.length > 1) details.push(...said);
  }

  const taken = items.flatMap((item) =>
    (item.citationKeys ?? []).flatMap((key) =>
      key.outcome === "taken"
        ? [
            `${key.citationKey} already cites another source in this project, which keeps it${
              item.projectKey
                ? `; this project cites ${nameOf(item, "the work")} as ${item.projectKey}`
                : ""
            }`,
          ]
        : [],
    ),
  );
  if (taken.length > NAMED_IN_NOTES) {
    notes.push(
      `${countOf(taken.length, "key", "keys")} already cite other sources in this project, which keep them`,
    );
    details.push(...taken);
  } else {
    notes.push(...taken);
  }

  const conflicts = (report.keyConflicts ?? []).map(
    ({ citationKey, line, firstLine }) =>
      `${citationKey} names two different works${
        firstLine !== null && line !== null ? ` (lines ${firstLine} and ${line})` : ""
      }; the second came in under another key`,
  );
  if (conflicts.length > NAMED_IN_NOTES) {
    notes.push(`${countOf(conflicts.length, "key names", "keys name")} two different works`);
    details.push(...conflicts);
  } else {
    notes.push(...conflicts);
  }

  // Only works this import brought: a source already present kept its own author list.
  const authors = (report.incompleteAuthors ?? []).flatMap((entry) => {
    const item = items.find((candidate) => candidate.itemKey === entry.sourceKey);
    if (item?.state !== "imported") return [];
    const name = nameOf(item, entry.label);
    return [
      item.authorList === "completed"
        ? { completed: true, line: `${name}: full author list taken from its DOI` }
        : {
            completed: false,
            line: `${name} lists ${countOf(entry.named, "author", "authors")} and others; the full list was unavailable`,
          },
    ];
  });
  if (authors.length > NAMED_IN_NOTES) {
    const completed = authors.filter((entry) => entry.completed).length;
    notes.push(
      `${countOf(authors.length, "author list ends", "author lists end")} with “and others”: ${completed.toLocaleString()} filled in from DOIs, ${(authors.length - completed).toLocaleString()} kept as they are`,
    );
    details.push(...authors.map((entry) => entry.line));
  } else {
    notes.push(...authors.map((entry) => entry.line));
  }

  if (report.unreadableCount > 0) {
    notes.push(`${countOf(report.unreadableCount, "entry", "entries")} could not be read`);
    details.push(...new Set(report.unreadable.map(unreadableEntryLabel)));
    const unlisted = report.unreadableCount - report.unreadable.length;
    if (unlisted > 0) details.push(`and ${countOf(unlisted, "more entry", "more entries")}`);
  }

  // A loss with a reason is a linked PDF that will not be attached; the rest are fields.
  const pdfLosses = report.notKept.filter((loss) => loss.reason);
  const unattached = pdfLosses.reduce((sum, loss) => sum + loss.entryCount, 0);
  if (unattached > 0) {
    notes.push(`${countOf(unattached, "linked PDF was", "linked PDFs were")} not attached`);
    details.push(
      ...pdfLosses.map(
        (loss) =>
          `PDF not attached (${loss.reason}): ${keysOf(loss.citationKeys, loss.entryCount)}`,
      ),
    );
  }
  const fieldLosses = report.notKept.filter((loss) => !loss.reason);
  if (fieldLosses.length > 0) {
    const shown = fieldLosses
      .slice(0, FIELDS_SHOWN)
      .map((loss) => `${loss.field} (${loss.entryCount.toLocaleString()})`);
    const more = fieldLosses.length - shown.length;
    notes.push(`Fields not kept: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`);
    details.push(
      ...fieldLosses.map(
        (loss) => `${loss.field} not kept: ${keysOf(loss.citationKeys, loss.entryCount)}`,
      ),
    );
  }

  if (report.alreadyInLibrary > 0) {
    notes.push(
      `${countOf(report.alreadyInLibrary, "entry was", "entries were")} left out as probably already in My Library`,
    );
  }
  if (report.remaining > 0) {
    notes.push(
      `${countOf(report.remaining, "more new reference", "more new references")} in the file ${
        report.remaining === 1 ? "is" : "are"
      } not imported yet`,
    );
  }
  return { notes, details };
}

function keysOf(keys: ReadonlyArray<string>, entryCount: number): string {
  const more = entryCount - keys.length;
  return `${keys.join(", ")}${more > 0 ? ` and ${more.toLocaleString()} more` : ""}`;
}

export function unreadableEntryLabel(entry: Report["unreadable"][number]): string {
  const where = [entry.line ? `Line ${entry.line}` : null, entry.citationKey]
    .filter(Boolean)
    .join(" · ");
  return where ? `${where}: ${entry.reason}` : entry.reason;
}

// `.txt` too: the file picker takes it, and the server reads what the text is, not its name.
const REFERENCE_FILE_EXTENSIONS = /\.(?:bib|bibtex|biblatex|ris|json|xml|txt)$/iu;

export function isReferenceFileName(fileName: string): boolean {
  return REFERENCE_FILE_EXTENSIONS.test(fileName.trim());
}
