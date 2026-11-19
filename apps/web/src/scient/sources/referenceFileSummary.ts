import type {
  ScientSourceImportOperation,
  ScientSourcesFileImportResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

type Report = ScientSourcesFileImportResult["report"];
type Item = ScientSourceImportOperation["items"][number];

/** How many of one item each kind of note names before it counts them instead. */
const NAMED_IN_NOTES = 2;
const FIELDS_SHOWN = 4;
const TITLE_LENGTH = 60;

/** A count for a plural message: `count` picks the form, `shown` is what it prints. */
const amount = (count: number) => ({ count, shown: count.toLocaleString() });

const NOTES = {
  twice: msg("{key} appears twice in the file"),
  samePaper: msg("{key} cites the same paper as {sameAs}"),
  sameWork: msg(
    "{entries, plural, one {{entriesShown} entry} other {{entriesShown} entries}} describe {works, plural, one {{worksShown} work} other {{worksShown} works}}; {detail}",
  ),
  eachRepeated: msg("each repeated entry's key cites the work it repeats"),
  taken: msg("{key} already cites another source in this project, which keeps it"),
  takenAs: msg(
    "{key} already cites another source in this project, which keeps it; this project cites {work} as {projectKey}",
  ),
  takenAsWork: msg(
    "{key} already cites another source in this project, which keeps it; this project cites the work as {projectKey}",
  ),
  takenCount: msg(
    "{count, plural, one {{shown} key already cite other sources in this project, which keep them} other {{shown} keys already cite other sources in this project, which keep them}}",
  ),
  conflict: msg("{key} names two different works; the second came in under another key"),
  conflictLines: msg(
    "{key} names two different works (lines {firstLine} and {line}); the second came in under another key",
  ),
  conflictCount: msg(
    "{count, plural, one {{shown} key names two different works} other {{shown} keys name two different works}}",
  ),
  authorsCompleted: msg("{name}: full author list taken from its DOI"),
  authorsShort: msg(
    "{name} lists {count, plural, one {{shown} author} other {{shown} authors}} and others; the full list was unavailable",
  ),
  authorsCount: msg(
    "{count, plural, one {{shown} author list ends with “and others”: {completed} filled in from DOIs, {kept} kept as they are} other {{shown} author lists end with “and others”: {completed} filled in from DOIs, {kept} kept as they are}}",
  ),
  unreadable: msg(
    "{count, plural, one {{shown} entry could not be read} other {{shown} entries could not be read}}",
  ),
  unlisted: msg("{count, plural, one {and {shown} more entry} other {and {shown} more entries}}"),
  unattached: msg(
    "{count, plural, one {{shown} linked PDF was not attached} other {{shown} linked PDFs were not attached}}",
  ),
  pdfNotAttached: msg("PDF not attached ({reason}): {keys}"),
  fieldsNotKept: msg("Fields not kept: {fields}"),
  fieldsNotKeptMore: msg("Fields not kept: {fields}, and {more} more"),
  fieldNotKept: msg("{field} not kept: {keys}"),
  alreadyInLibrary: msg(
    "{count, plural, one {{shown} entry was left out as probably already in My Library} other {{shown} entries were left out as probably already in My Library}}",
  ),
  remaining: msg(
    "{count, plural, one {{shown} more new reference in the file is not imported yet} other {{shown} more new references in the file are not imported yet}}",
  ),
  keysAndMore: msg("{keys} and {more} more"),
  line: msg("Line {line}: {reason}"),
  lineAndKey: msg("Line {line} · {key}: {reason}"),
} as const;

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
export function referenceFileNotes(
  input: {
    readonly report: Report;
    readonly items: ReadonlyArray<Item>;
    readonly sourceTitle?: ((sourceId: string) => string | null) | undefined;
  },
  resolve: MessageResolver = m,
): ReferenceFileNotes {
  const { report, items } = input;
  const notes: string[] = [];
  const details: string[] = [];
  const titleOf = (item: Item | undefined): string | null => {
    const title = item?.sourceId ? input.sourceTitle?.(item.sourceId) : null;
    if (!title) return null;
    return title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : title;
  };

  const sameWork = report.sameWork ?? [];
  if (sameWork.length > 0) {
    const said = sameWork.map((entry) =>
      entry.identifier === null && entry.citationKey === entry.sameAs
        ? resolve(NOTES.twice, { key: entry.citationKey })
        : resolve(NOTES.samePaper, { key: entry.citationKey, sameAs: entry.sameAs }),
    );
    const readable = report.entryCount - report.unreadableCount;
    const works = readable - sameWork.length;
    notes.push(
      resolve(NOTES.sameWork, {
        entries: readable,
        entriesShown: readable.toLocaleString(),
        works,
        worksShown: works.toLocaleString(),
        detail: sameWork.length === 1 ? said[0]! : resolve(NOTES.eachRepeated),
      }),
    );
    if (sameWork.length > 1) details.push(...said);
  }

  const taken = items.flatMap((item) =>
    (item.citationKeys ?? []).flatMap((key) => {
      if (key.outcome !== "taken") return [];
      if (!item.projectKey) return [resolve(NOTES.taken, { key: key.citationKey })];
      const work = titleOf(item);
      return [
        work === null
          ? resolve(NOTES.takenAsWork, { key: key.citationKey, projectKey: item.projectKey })
          : resolve(NOTES.takenAs, { key: key.citationKey, work, projectKey: item.projectKey }),
      ];
    }),
  );
  if (taken.length > NAMED_IN_NOTES) {
    notes.push(resolve(NOTES.takenCount, amount(taken.length)));
    details.push(...taken);
  } else {
    notes.push(...taken);
  }

  const conflicts = (report.keyConflicts ?? []).map(({ citationKey, line, firstLine }) =>
    firstLine !== null && line !== null
      ? resolve(NOTES.conflictLines, {
          key: citationKey,
          firstLine: String(firstLine),
          line: String(line),
        })
      : resolve(NOTES.conflict, { key: citationKey }),
  );
  if (conflicts.length > NAMED_IN_NOTES) {
    notes.push(resolve(NOTES.conflictCount, amount(conflicts.length)));
    details.push(...conflicts);
  } else {
    notes.push(...conflicts);
  }

  // Only works this import brought: a source already present kept its own author list.
  const authors = (report.incompleteAuthors ?? []).flatMap((entry) => {
    const item = items.find((candidate) => candidate.itemKey === entry.sourceKey);
    if (item?.state !== "imported") return [];
    const name = titleOf(item) ?? entry.label;
    return [
      item.authorList === "completed"
        ? { completed: true, line: resolve(NOTES.authorsCompleted, { name }) }
        : {
            completed: false,
            line: resolve(NOTES.authorsShort, { name, ...amount(entry.named) }),
          },
    ];
  });
  if (authors.length > NAMED_IN_NOTES) {
    const completed = authors.filter((entry) => entry.completed).length;
    notes.push(
      resolve(NOTES.authorsCount, {
        ...amount(authors.length),
        completed: completed.toLocaleString(),
        kept: (authors.length - completed).toLocaleString(),
      }),
    );
    details.push(...authors.map((entry) => entry.line));
  } else {
    notes.push(...authors.map((entry) => entry.line));
  }

  if (report.unreadableCount > 0) {
    notes.push(resolve(NOTES.unreadable, amount(report.unreadableCount)));
    details.push(
      ...new Set(report.unreadable.map((entry) => unreadableEntryLabel(entry, resolve))),
    );
    const unlisted = report.unreadableCount - report.unreadable.length;
    if (unlisted > 0) details.push(resolve(NOTES.unlisted, amount(unlisted)));
  }

  // A loss with a reason is a linked PDF that will not be attached; the rest are fields.
  const pdfLosses = report.notKept.filter((loss) => loss.reason);
  const unattached = pdfLosses.reduce((sum, loss) => sum + loss.entryCount, 0);
  if (unattached > 0) {
    notes.push(resolve(NOTES.unattached, amount(unattached)));
    details.push(
      ...pdfLosses.map((loss) =>
        resolve(NOTES.pdfNotAttached, {
          reason: loss.reason ?? "",
          keys: keysOf(loss.citationKeys, loss.entryCount, resolve),
        }),
      ),
    );
  }
  const fieldLosses = report.notKept.filter((loss) => !loss.reason);
  if (fieldLosses.length > 0) {
    const fields = fieldLosses
      .slice(0, FIELDS_SHOWN)
      .map((loss) => `${loss.field} (${loss.entryCount.toLocaleString()})`);
    const more = fieldLosses.length - fields.length;
    notes.push(
      more > 0
        ? resolve(NOTES.fieldsNotKeptMore, { fields: fields.join(", "), more: String(more) })
        : resolve(NOTES.fieldsNotKept, { fields: fields.join(", ") }),
    );
    details.push(
      ...fieldLosses.map((loss) =>
        resolve(NOTES.fieldNotKept, {
          field: loss.field,
          keys: keysOf(loss.citationKeys, loss.entryCount, resolve),
        }),
      ),
    );
  }

  if (report.alreadyInLibrary > 0) {
    notes.push(resolve(NOTES.alreadyInLibrary, amount(report.alreadyInLibrary)));
  }
  if (report.remaining > 0) {
    notes.push(resolve(NOTES.remaining, amount(report.remaining)));
  }
  return { notes, details };
}

function keysOf(keys: ReadonlyArray<string>, entryCount: number, resolve: MessageResolver): string {
  const more = entryCount - keys.length;
  return more > 0
    ? resolve(NOTES.keysAndMore, { keys: keys.join(", "), more: more.toLocaleString() })
    : keys.join(", ");
}

function unreadableEntryLabel(
  entry: Report["unreadable"][number],
  resolve: MessageResolver,
): string {
  if (entry.line && entry.citationKey) {
    return resolve(NOTES.lineAndKey, {
      line: String(entry.line),
      key: entry.citationKey,
      reason: entry.reason,
    });
  }
  if (entry.line) return resolve(NOTES.line, { line: String(entry.line), reason: entry.reason });
  return entry.citationKey ? `${entry.citationKey}: ${entry.reason}` : entry.reason;
}

// `.txt` too: the file picker takes it, and the server reads what the text is, not its name.
const REFERENCE_FILE_EXTENSIONS = /\.(?:bib|bibtex|biblatex|ris|json|xml|txt)$/iu;

export function isReferenceFileName(fileName: string): boolean {
  return REFERENCE_FILE_EXTENSIONS.test(fileName.trim());
}
