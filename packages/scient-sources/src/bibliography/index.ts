import * as Schema from "effect/Schema";

import {
  assignCitationKey,
  citationKeyComparisonValue,
  takenCitationKeys,
} from "../citationKeys.ts";
import { assessSourceDuplicate, type ScientSourceIntakeExclusions } from "../duplicates.ts";
import {
  scientCreatorRoleIncomplete,
  type ScientSourceCandidate,
  type ScientSourceRecord,
} from "../model.ts";
import { normalizePersistentIdentifier } from "../normalize.ts";
import { scientSourceMoreKind, scientSourceMoreLabel } from "../sourceMore.ts";
import { scientLibraryIdentityProblem } from "../sourceIdentity.ts";
import { formatBibtex, parseBibtex } from "./bibtex.ts";
import { cslDateFromText, formatCslJson, parseCslJson } from "./cslJson.ts";
import { formatEndnoteXml, parseEndnoteXml } from "./endnoteXml.ts";
import {
  BIBLIOGRAPHY_FORMATS,
  bibliographyEntryCandidate,
  bibliographyEntryIdentity,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyFormat,
  type BibliographyLinkedFile,
  type BibliographyParseResult,
  type BibliographyUnreadableEntry,
} from "./entry.ts";
import { formatRis, parseRis } from "./ris.ts";

export type {
  BibliographyEntry,
  BibliographyExportItem,
  BibliographyExportOptions,
  BibliographyFormat,
  BibliographyLinkedFile,
  BibliographyParseResult,
} from "./entry.ts";
export { BIBLIOGRAPHY_FORMATS } from "./entry.ts";
export { CSL_INCOMPLETE_NAMES, cslJsonItem, type CslJsonItem } from "./cslJson.ts";

export const BibliographyFormatSchema = Schema.Literals(BIBLIOGRAPHY_FORMATS);

export const BIBLIOGRAPHY_FILE_EXTENSIONS: Readonly<Record<BibliographyFormat, string>> = {
  bibtex: ".bib",
  ris: ".ris",
  "csl-json": ".json",
  "endnote-xml": ".xml",
};

/** Upload and project-file bound for one reference file. */
export const BIBLIOGRAPHY_FILE_MAX_BYTES = 32 * 1024 * 1024;

const EXTENSION_FORMATS: Readonly<Record<string, BibliographyFormat>> = {
  bib: "bibtex",
  bibtex: "bibtex",
  biblatex: "bibtex",
  ris: "ris",
  json: "csl-json",
  csljson: "csl-json",
  xml: "endnote-xml",
};

export function detectBibliographyFormat(
  fileName: string,
  text: string,
): BibliographyFormat | null {
  const start = text.replace(/^﻿/u, "").trimStart();
  if (/^[[{]/u.test(start)) return "csl-json";
  if (/^<(?:\?xml|xml\b|records\b)/iu.test(start)) return "endnote-xml";
  if (/^TY {1,2}-/mu.test(start)) return "ris";
  if (/@[A-Za-z]+\s*[{(]/u.test(start)) return "bibtex";
  const extension = fileName.toLowerCase().match(/\.([a-z]+)$/u)?.[1];
  return extension ? (EXTENSION_FORMATS[extension] ?? null) : null;
}

export function parseBibliography(
  text: string,
  format: BibliographyFormat,
): BibliographyParseResult {
  switch (format) {
    case "bibtex":
      return parseBibtex(text);
    case "ris":
      return parseRis(text);
    case "csl-json":
      return parseCslJson(text);
    case "endnote-xml":
      return parseEndnoteXml(text);
  }
}

export function formatBibliography(
  items: ReadonlyArray<BibliographyExportItem>,
  format: BibliographyFormat,
  options: BibliographyExportOptions,
): string {
  switch (format) {
    case "bibtex":
      return formatBibtex(items, options);
    case "ris":
      return formatRis(items, options);
    case "csl-json":
      return formatCslJson(items, options);
    case "endnote-xml":
      return formatEndnoteXml(items, options);
  }
}

/**
 * Pairs each source with the key it is exported under: its own citation key,
 * or for an older source without one, a key from the Library's key rules that
 * no other exported source uses.
 */
export function bibliographyExportItems(
  records: ReadonlyArray<ScientSourceRecord>,
): BibliographyExportItem[] {
  const taken = takenCitationKeys(records);
  const used = new Set<string>();
  return records.map((record) => {
    const own = record.citationKey;
    const citationKey =
      own && !used.has(citationKeyComparisonValue(own))
        ? own
        : assignCitationKey({ ...record, preferred: own ?? null, taken });
    used.add(citationKeyComparisonValue(citationKey));
    taken.add(citationKeyComparisonValue(citationKey));
    return { record, citationKey };
  });
}

const REPORT_LIST_LIMIT = 50;
const WORK_LEVEL_SCHEMES = new Set(["arxiv", "doi", "pmcid", "pmid"]);
const REPORT_KEY_LIMIT = 5;

/** A field that some entries could not keep, with the first few entries' keys. */
export const BibliographyFieldLoss = Schema.Struct({
  field: Schema.String,
  /** Why a value of the field was not kept, when the field itself has a place (linked PDFs). */
  reason: Schema.optionalKey(Schema.String),
  entryCount: Schema.Int,
  citationKeys: Schema.Array(Schema.String),
});
export type BibliographyFieldLoss = typeof BibliographyFieldLoss.Type;

/** A later entry for a work an earlier entry of the file already gave; its key cites that work too. */
export const BibliographySameWork = Schema.Struct({
  citationKey: Schema.String,
  line: Schema.NullOr(Schema.Int),
  /** The earlier entry, by its key (or line). */
  sameAs: Schema.String,
  /** The identifier both give (DOI, arXiv ID, PMID, PMCID); null for an exact copy of the entry. */
  identifier: Schema.NullOr(Schema.String),
});
export type BibliographySameWork = typeof BibliographySameWork.Type;

export const BibliographyImportReport = Schema.Struct({
  format: BibliographyFormatSchema,
  /** Entries recognised in the file, readable or not. */
  entryCount: Schema.Int,
  /** Works new to the Library staged for this import. */
  importCount: Schema.Int,
  /** Works the Library has, staged too so the import adds them to the project with their keys. */
  presentCount: Schema.optionalKey(Schema.Int),
  /** Entries left out as already in the Library: a possible match by details, or past this batch. */
  alreadyInLibrary: Schema.Int,
  /** New entries beyond one import's limit; importing the file again continues with them. */
  remaining: Schema.Int,
  unreadableCount: Schema.Int,
  unreadable: Schema.Array(
    Schema.Struct({
      line: Schema.NullOr(Schema.Int),
      citationKey: Schema.NullOr(Schema.String),
      reason: Schema.String,
    }),
  ),
  /** Several entries for one work: each later entry's key cites the work the first one gave. */
  sameWork: Schema.optionalKey(Schema.Array(BibliographySameWork)),
  /** One key given to two different works; the later work comes in under another key. */
  keyConflicts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        citationKey: Schema.String,
        line: Schema.NullOr(Schema.Int),
        firstLine: Schema.NullOr(Schema.Int),
      }),
    ),
  ),
  /** Staged works whose author list the file ended with "and others", by source key. */
  incompleteAuthors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ sourceKey: Schema.String, label: Schema.String, named: Schema.Int }),
    ),
  ),
  notKept: Schema.Array(BibliographyFieldLoss),
  withoutCitationKey: Schema.Int,
  /** PDFs named in the file that will be attached to the staged entries. */
  linkedPdfCount: Schema.optionalKey(Schema.Int),
});
export type BibliographyImportReport = typeof BibliographyImportReport.Type;

export interface BibliographyImportPlan {
  /** New works first, then works the Library has (which an import adds to the project). */
  readonly candidates: ReadonlyArray<ScientSourceCandidate>;
  readonly report: BibliographyImportReport;
  /** Files the staged entries name, by source key, with the entry's report label. */
  readonly linkedFiles: ReadonlyArray<{
    readonly sourceKey: string;
    readonly label: string;
    readonly files: ReadonlyArray<BibliographyLinkedFile>;
  }>;
  /** Every key the file cites each staged work by, by source key, its own key first. */
  readonly citationKeys: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Works the Library has past this batch's room, with the keys the file cites them by. */
  readonly presentPastBatch: ReadonlyArray<{
    readonly sourceId: string;
    readonly citationKeys: ReadonlyArray<string>;
  }>;
}

function hasContent(candidate: ScientSourceCandidate): boolean {
  return Boolean(
    candidate.title || candidate.identifiers.length > 0 || candidate.creators.length > 0,
  );
}

/** A work the file gives: new, one the Library has, or one that may be (which is left out). */
interface PlannedWork {
  readonly kind: "new" | "present" | "maybe";
  readonly candidate: ScientSourceCandidate;
  readonly label: string;
  readonly line: number | null;
  readonly sourceId: string | null;
  readonly keys: string[];
  readonly linkedFiles: BibliographyLinkedFile[];
}

/**
 * Turns a parsed file into the next batch of import candidates and a report of everything that
 * will not arrive as written. Several entries for one work become one work cited by each of their
 * keys. New works fill the batch first, so importing a large file again continues where the last
 * import ended; works the Library has follow in the room left.
 */
export function planBibliographyImport(input: {
  readonly parse: BibliographyParseResult;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly sourceKeyFor: (identity: string) => string;
  /** The store's source ID for a source key, so entries imported before count as present whatever their metadata. */
  readonly sourceIdFor: (sourceKey: string) => string;
  /** The Library's merge decisions, so an entry is never taken for a record they keep apart. */
  readonly exclusions?: ScientSourceIntakeExclusions;
  readonly limit: number;
}): BibliographyImportPlan {
  const { parse } = input;
  const unreadable: BibliographyUnreadableEntry[] = [...parse.unreadable];
  const notKept = new Map<string, { entryCount: number; citationKeys: string[] }>();
  const works: PlannedWork[] = [];
  const bySourceKey = new Map<string, PlannedWork>();
  const byIdentifier = new Map<string, PlannedWork[]>();
  const byCitationKey = new Map<string, PlannedWork>();
  const sameWork: BibliographySameWork[] = [];
  const keyConflicts: Array<{
    citationKey: string;
    line: number | null;
    firstLine: number | null;
  }> = [];
  let withoutCitationKey = 0;
  // A key cites the work it was first given to; given again to another work it is a conflict.
  const claimKey = (work: PlannedWork, key: string | null, line: number | null) => {
    if (!key) return;
    const claimed = byCitationKey.get(citationKeyComparisonValue(key));
    if (!claimed) {
      byCitationKey.set(citationKeyComparisonValue(key), work);
      work.keys.push(key);
    } else if (claimed !== work) {
      keyConflicts.push({ citationKey: key, line, firstLine: claimed.line });
    }
  };
  for (const entry of parse.entries) {
    const label =
      entry.citationKey ?? (entry.line ? `line ${entry.line}` : `item ${entry.index + 1}`);
    const sourceKey = input.sourceKeyFor(bibliographyEntryIdentity(parse.format, entry));
    const candidate = bibliographyEntryCandidate({ entry, format: parse.format, sourceKey });
    if (!hasContent(candidate)) {
      unreadable.push({
        line: entry.line,
        citationKey: entry.citationKey,
        reason: "This entry has no title, author or identifier.",
      });
      continue;
    }
    const copied = bySourceKey.get(sourceKey);
    if (copied) {
      sameWork.push({
        citationKey: label,
        line: entry.line,
        sameAs: copied.label,
        identifier: null,
      });
      continue;
    }
    const workKeys = candidate.identifiers.flatMap((identifier) =>
      WORK_LEVEL_SCHEMES.has(identifier.scheme)
        ? [
            {
              key: normalizePersistentIdentifier(identifier.scheme, identifier.value),
              label: IDENTIFIER_LABELS[identifier.scheme] ?? identifier.scheme,
            },
          ]
        : [],
    );
    // A shared identifier repeats an entry only when the two corroborate one work.
    const repeated = workKeys
      .flatMap((key) => (byIdentifier.get(key.key) ?? []).map((work) => ({ work, key })))
      .find(({ work }) => scientLibraryIdentityProblem(candidate, work.candidate) === null);
    if (repeated) {
      sameWork.push({
        citationKey: label,
        line: entry.line,
        sameAs: repeated.work.label,
        identifier: repeated.key.label,
      });
      claimKey(repeated.work, entry.citationKey, entry.line);
      for (const file of entry.linkedFiles) {
        if (!repeated.work.linkedFiles.some((known) => known.path === file.path)) {
          repeated.work.linkedFiles.push(file);
        }
      }
      continue;
    }
    if (!entry.citationKey) withoutCitationKey += 1;
    for (const field of entry.notKept) {
      const summary = notKept.get(field) ?? { entryCount: 0, citationKeys: [] };
      summary.entryCount += 1;
      if (summary.citationKeys.length < REPORT_KEY_LIMIT) summary.citationKeys.push(label);
      notKept.set(field, summary);
    }
    const duplicate = assessSourceDuplicate({
      candidate,
      existing: input.existing,
      sourceId: input.sourceIdFor(sourceKey),
      ...(input.exclusions ? { exclusions: input.exclusions } : {}),
    });
    const match = duplicate.matchingSourceIds[0] ?? null;
    const work: PlannedWork = {
      kind:
        duplicate.kind === "new"
          ? "new"
          : duplicate.kind !== "possible-metadata-match" && match
            ? "present"
            : "maybe",
      candidate,
      label,
      line: entry.line,
      sourceId: duplicate.kind === "new" ? null : match,
      keys: [],
      linkedFiles: [...entry.linkedFiles],
    };
    works.push(work);
    bySourceKey.set(sourceKey, work);
    for (const key of workKeys)
      byIdentifier.set(key.key, [...(byIdentifier.get(key.key) ?? []), work]);
    claimKey(work, entry.citationKey, entry.line);
  }
  const fresh = works.filter((work) => work.kind === "new");
  const present = works.filter((work) => work.kind === "present");
  const staged = [...fresh.slice(0, input.limit)];
  staged.push(...present.slice(0, Math.max(0, input.limit - staged.length)));
  const stagedPresent = staged.length - Math.min(fresh.length, input.limit);
  const presentPastBatch = present.slice(stagedPresent);
  const stagedFresh = staged.filter((work) => work.kind === "new");
  const incompleteAuthors = stagedFresh.flatMap((work) =>
    scientCreatorRoleIncomplete(work.candidate.incompleteCreatorRoles, "author")
      ? [
          {
            sourceKey: work.candidate.sourceKey,
            label: work.label,
            named: work.candidate.creators.filter(
              (creator) => creator.creatorType.toLowerCase() === "author",
            ).length,
          },
        ]
      : [],
  );
  return {
    candidates: staged.map((work) => work.candidate),
    linkedFiles: stagedFresh.flatMap((work) =>
      work.linkedFiles.length > 0
        ? [{ sourceKey: work.candidate.sourceKey, label: work.label, files: work.linkedFiles }]
        : [],
    ),
    citationKeys: Object.fromEntries(
      staged.flatMap((work) =>
        work.keys.length > 0 ? [[work.candidate.sourceKey, work.keys]] : [],
      ),
    ),
    presentPastBatch: presentPastBatch.map((work) => ({
      sourceId: work.sourceId!,
      citationKeys: work.keys,
    })),
    report: {
      format: parse.format,
      entryCount: parse.entries.length + parse.unreadable.length,
      importCount: stagedFresh.length,
      ...(stagedPresent > 0 ? { presentCount: stagedPresent } : {}),
      alreadyInLibrary:
        works.filter((work) => work.kind === "maybe").length + presentPastBatch.length,
      remaining: fresh.length - stagedFresh.length,
      unreadableCount: unreadable.length,
      unreadable: unreadable.slice(0, REPORT_LIST_LIMIT).map((entry) => ({ ...entry })),
      ...(sameWork.length > 0 ? { sameWork: sameWork.slice(0, REPORT_LIST_LIMIT) } : {}),
      ...(keyConflicts.length > 0
        ? { keyConflicts: keyConflicts.slice(0, REPORT_LIST_LIMIT) }
        : {}),
      ...(incompleteAuthors.length > 0
        ? { incompleteAuthors: incompleteAuthors.slice(0, REPORT_LIST_LIMIT) }
        : {}),
      notKept: [...notKept.entries()]
        .toSorted((left, right) => right[1].entryCount - left[1].entryCount)
        .slice(0, REPORT_LIST_LIMIT)
        .map(([field, summary]) => ({ field, ...summary })),
      withoutCitationKey,
    },
  };
}

/**
 * Adds what became of the staged entries' linked files: how many PDFs will be
 * attached, and each one that will not, under its field with the reason.
 */
export function withLinkedFileReport(
  report: BibliographyImportReport,
  linked: {
    readonly pdfCount: number;
    readonly losses: ReadonlyArray<{
      readonly field: string;
      readonly reason: string;
      readonly label: string;
    }>;
  },
): BibliographyImportReport {
  const losses = new Map<string, { field: string; reason: string; labels: Set<string> }>();
  for (const loss of linked.losses) {
    const key = `${loss.field}\0${loss.reason}`;
    const summary = losses.get(key) ?? {
      field: loss.field,
      reason: loss.reason,
      labels: new Set(),
    };
    summary.labels.add(loss.label);
    losses.set(key, summary);
  }
  const notKept = [
    ...report.notKept,
    ...[...losses.values()].map((loss) => ({
      field: loss.field,
      reason: loss.reason,
      entryCount: loss.labels.size,
      citationKeys: [...loss.labels].slice(0, REPORT_KEY_LIMIT),
    })),
  ]
    .toSorted((left, right) => right.entryCount - left.entryCount)
    .slice(0, REPORT_LIST_LIMIT);
  return {
    ...report,
    notKept,
    ...(linked.pdfCount > 0 ? { linkedPdfCount: linked.pdfCount } : {}),
  };
}

const IDENTIFIER_LABELS: Readonly<Record<string, string>> = {
  arxiv: "arXiv ID",
  doi: "DOI",
  isbn: "ISBN",
  issn: "ISSN",
  pmcid: "PMCID",
  pmid: "PMID",
};

/**
 * Writes the file, then reads it back to name what the format could not
 * hold (identifiers, the source type), so a backup or move is not silently
 * poorer than the Library. Notes are left out on purpose and not reported.
 */
/** A person or body by the words of the name, however a format split or ordered them. */
const personOf = (creator: {
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly literalName: string | null;
}) =>
  [creator.familyName, creator.givenName, creator.literalName]
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .toSorted()
    .join(" ");

export function exportBibliographyFile(
  items: ReadonlyArray<BibliographyExportItem>,
  format: BibliographyFormat,
  options: BibliographyExportOptions,
): { readonly content: string; readonly notKept: ReadonlyArray<BibliographyFieldLoss> } {
  const content = formatBibliography(items, format, options);
  const entries = parseBibliography(content, format).entries;
  const byKey = new Map(entries.map((entry) => [entry.citationKey, entry]));
  const lost = new Map<string, { entryCount: number; citationKeys: string[] }>();
  items.forEach(({ record, citationKey }, index) => {
    const entry = byKey.get(citationKey) ?? entries[index];
    const kept = new Set(
      entry?.identifiers.map((identifier) =>
        normalizePersistentIdentifier(identifier.scheme, identifier.value),
      ),
    );
    const fields = new Set(
      record.identifiers.flatMap((identifier) => {
        const scheme = identifier.scheme.toLowerCase();
        return kept.has(normalizePersistentIdentifier(identifier.scheme, identifier.value))
          ? []
          : [IDENTIFIER_LABELS[scheme] ?? scheme];
      }),
    );
    if (entry?.type !== record.type) fields.add("Source type");
    // A further detail the format has no field for, or a line kept as written.
    for (const [name, value] of Object.entries(record.more ?? {})) {
      const back = entry?.more[name];
      // A date is the same when it cites the same: with or without a time of day, not a prefix.
      const same =
        back === value ||
        // An abbreviation that is the title itself is carried by the title.
        (name === "container-title-short" && value === entry?.containerTitle) ||
        (back !== undefined &&
          scientSourceMoreKind(name) === "date" &&
          JSON.stringify(cslDateFromText(back)) === JSON.stringify(cslDateFromText(value)));
      if (!same) fields.add(scientSourceMoreLabel(name));
    }
    // A creator the file does not name at all, and one it names under another role.
    const back = new Map(entry?.creators.map((creator) => [personOf(creator), creator]));
    for (const creator of record.creators) {
      const found = back.get(personOf(creator));
      if (!found) fields.add("Some creators");
      else if (found.creatorType.toLowerCase() !== creator.creatorType.toLowerCase()) {
        fields.add("Creator roles");
      }
    }
    // RIS and EndNote XML have no way to say a name list goes on past the names given.
    if (
      record.incompleteCreatorRoles?.some(
        (role) => !scientCreatorRoleIncomplete(entry?.incompleteCreatorRoles, role),
      )
    ) {
      fields.add("“et al.” after a list of names");
    }
    for (const field of fields) {
      const summary = lost.get(field) ?? { entryCount: 0, citationKeys: [] };
      summary.entryCount += 1;
      if (summary.citationKeys.length < REPORT_KEY_LIMIT) summary.citationKeys.push(citationKey);
      lost.set(field, summary);
    }
  });
  return {
    content,
    notKept: [...lost.entries()]
      .toSorted((left, right) => right[1].entryCount - left[1].entryCount)
      .map(([field, summary]) => ({ field, ...summary })),
  };
}
