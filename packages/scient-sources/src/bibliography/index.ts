import * as Schema from "effect/Schema";

import {
  assignCitationKey,
  citationKeyComparisonValue,
  takenCitationKeys,
} from "../citationKeys.ts";
import { assessSourceDuplicate } from "../duplicates.ts";
import type { ScientSourceCandidate, ScientSourceRecord } from "../model.ts";
import { normalizePersistentIdentifier } from "../normalize.ts";
import { formatBibtex, parseBibtex } from "./bibtex.ts";
import { formatCslJson, parseCslJson } from "./cslJson.ts";
import { formatEndnoteXml, parseEndnoteXml } from "./endnoteXml.ts";
import {
  BIBLIOGRAPHY_FORMATS,
  bibliographyEntryCandidate,
  bibliographyEntryIdentity,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyFormat,
  type BibliographyParseResult,
  type BibliographyUnreadableEntry,
} from "./entry.ts";
import { formatRis, parseRis } from "./ris.ts";

export type {
  BibliographyEntry,
  BibliographyExportItem,
  BibliographyExportOptions,
  BibliographyFormat,
  BibliographyParseResult,
} from "./entry.ts";
export { BIBLIOGRAPHY_FORMATS } from "./entry.ts";

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
  entryCount: Schema.Int,
  citationKeys: Schema.Array(Schema.String),
});
export type BibliographyFieldLoss = typeof BibliographyFieldLoss.Type;

export const BibliographyImportReport = Schema.Struct({
  format: BibliographyFormatSchema,
  /** Entries recognised in the file, readable or not. */
  entryCount: Schema.Int,
  /** New entries staged for this import. */
  importCount: Schema.Int,
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
  notKept: Schema.Array(BibliographyFieldLoss),
  withoutCitationKey: Schema.Int,
});
export type BibliographyImportReport = typeof BibliographyImportReport.Type;

export interface BibliographyImportPlan {
  readonly candidates: ReadonlyArray<ScientSourceCandidate>;
  readonly report: BibliographyImportReport;
}

function hasContent(candidate: ScientSourceCandidate): boolean {
  return Boolean(
    candidate.title || candidate.identifiers.length > 0 || candidate.creators.length > 0,
  );
}

/**
 * Turns a parsed file into the next batch of new import candidates and a
 * report of everything that will not arrive in the Library as written.
 * Entries already in the Library are left out before the batch limit applies,
 * so importing the same large file again continues where the last import ended.
 */
export function planBibliographyImport(input: {
  readonly parse: BibliographyParseResult;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly sourceKeyFor: (identity: string) => string;
  /** The store's source ID for a source key, so entries imported before count as present whatever their metadata. */
  readonly sourceIdFor: (sourceKey: string) => string;
  readonly limit: number;
}): BibliographyImportPlan {
  const { parse } = input;
  const unreadable: BibliographyUnreadableEntry[] = [...parse.unreadable];
  const notKept = new Map<string, { entryCount: number; citationKeys: string[] }>();
  const seenKeys = new Map<string, number | null>();
  const seenWorks = new Map<string, number | null>();
  const fresh: ScientSourceCandidate[] = [];
  let alreadyInLibrary = 0;
  let withoutCitationKey = 0;
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
    if (seenKeys.has(sourceKey)) {
      const firstLine = seenKeys.get(sourceKey);
      unreadable.push({
        line: entry.line,
        citationKey: entry.citationKey,
        reason: firstLine
          ? `This entry repeats the entry on line ${firstLine}.`
          : "This entry repeats an earlier entry.",
      });
      continue;
    }
    seenKeys.set(sourceKey, entry.line);
    if (!entry.citationKey) withoutCitationKey += 1;
    for (const field of entry.notKept) {
      const summary = notKept.get(field) ?? { entryCount: 0, citationKeys: [] };
      summary.entryCount += 1;
      if (summary.citationKeys.length < REPORT_KEY_LIMIT) summary.citationKeys.push(label);
      notKept.set(field, summary);
    }
    const workKeys = candidate.identifiers.flatMap((identifier) =>
      WORK_LEVEL_SCHEMES.has(identifier.scheme)
        ? [normalizePersistentIdentifier(identifier.scheme, identifier.value)]
        : [],
    );
    const repeated = workKeys.map((key) => seenWorks.get(key)).find((line) => line !== undefined);
    if (repeated !== undefined) {
      unreadable.push({
        line: entry.line,
        citationKey: entry.citationKey,
        reason: repeated
          ? `This entry has the same identifier as the entry on line ${repeated}.`
          : "This entry has the same identifier as an earlier entry.",
      });
      continue;
    }
    for (const key of workKeys) seenWorks.set(key, entry.line);
    const sourceId = input.sourceIdFor(sourceKey);
    if (assessSourceDuplicate({ candidate, existing: input.existing, sourceId }).kind !== "new") {
      alreadyInLibrary += 1;
      continue;
    }
    fresh.push(candidate);
  }
  const candidates = fresh.slice(0, input.limit);
  return {
    candidates,
    report: {
      format: parse.format,
      entryCount: parse.entries.length + parse.unreadable.length,
      importCount: candidates.length,
      alreadyInLibrary,
      remaining: fresh.length - candidates.length,
      unreadableCount: unreadable.length,
      unreadable: unreadable.slice(0, REPORT_LIST_LIMIT).map((entry) => ({ ...entry })),
      notKept: [...notKept.entries()]
        .toSorted((left, right) => right[1].entryCount - left[1].entryCount)
        .slice(0, REPORT_LIST_LIMIT)
        .map(([field, summary]) => ({ field, ...summary })),
      withoutCitationKey,
    },
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
