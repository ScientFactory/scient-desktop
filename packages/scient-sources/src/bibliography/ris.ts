import type { ScientSourceType } from "../model.ts";
import {
  BibliographyEntryBuilder,
  plausibleCitationKey,
  standardNumberScheme,
  type BibliographyEntry,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyParseResult,
  type BibliographyUnreadableEntry,
} from "./entry.ts";
import { collapseWhitespace } from "./latex.ts";
import { parsePlainName, plainCreatorName } from "./names.ts";

interface RawRisRecord {
  readonly line: number;
  readonly tags: Array<[string, string]>;
}

const TAG_LINE = /^([A-Z][A-Z0-9])[ \t]{1,2}-(?:[ \t](.*))?$/u;

function readRis(text: string): {
  readonly records: RawRisRecord[];
  readonly unreadable: BibliographyUnreadableEntry[];
} {
  const records: RawRisRecord[] = [];
  const unreadable: BibliographyUnreadableEntry[] = [];
  let current: RawRisRecord | null = null;
  const lines = text.split(/\r\n?|\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/^﻿/u, "");
    const match = TAG_LINE.exec(line.trimEnd());
    if (!match) {
      const last = current?.tags.at(-1);
      if (current && last && line.trim()) last[1] = `${last[1]}\n${line.trim()}`;
      continue;
    }
    const tag = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (tag === "TY") {
      if (current) {
        unreadable.push({
          line: current.line,
          citationKey: null,
          reason: "This record has no end (ER) line; it was read up to the next record.",
        });
        records.push(current);
      }
      current = { line: index + 1, tags: [["TY", value]] };
      continue;
    }
    if (tag === "ER") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (current) current.tags.push([tag, value]);
  }
  if (current) records.push(current);
  return { records, unreadable };
}

const TYPE_BY_RIS_TYPE: Readonly<Record<string, ScientSourceType>> = {
  JOUR: "article",
  JFULL: "article",
  MGZN: "article",
  NEWS: "article",
  EJOUR: "article",
  INPR: "article",
  BOOK: "book",
  EBOOK: "book",
  EDBOOK: "book",
  CHAP: "book-chapter",
  ECHAP: "book-chapter",
  CONF: "conference-paper",
  CPAPER: "conference-paper",
  THES: "thesis",
  RPRT: "report",
  DATA: "dataset",
  DBASE: "dataset",
  ELEC: "web",
  WEB: "web",
  BLOG: "web",
};

const CUSTOM_TYPE_LABELS: Readonly<Record<string, string>> = {
  GEN: "Document",
  UNPB: "Unpublished",
  PAT: "Patent",
  COMP: "Software",
  STAND: "Standard",
  STAT: "Statute",
  CASE: "Case",
  BILL: "Bill",
  HEAR: "Hearing",
  VIDEO: "Video",
  MPCT: "Film",
  SOUND: "Audio",
  MUSIC: "Music",
  ART: "Artwork",
  MAP: "Map",
  PCOMM: "Letter",
  ICOMM: "Email",
  SLIDE: "Slides",
  ABST: "Abstract",
  MANSCPT: "Manuscript",
  PAMP: "Pamphlet",
  CTLG: "Catalog",
  GOVDOC: "Government document",
  LEGAL: "Legal document",
  ENCYC: "Encyclopedia",
  DICT: "Dictionary",
  AGGR: "Database",
  ADVS: "Audiovisual",
  CHART: "Chart",
  CLSWK: "Classical work",
  EQUA: "Equation",
  FIGURE: "Figure",
  GRANT: "Grant",
  SER: "Serial",
};

/** Database bookkeeping tags; they describe where a record came from, not the work. */
const IGNORED_TAGS = new Set(["DB", "DP", "Y2", "ST", "J2", "JA", "J1", "M3", "AN"]);

/** RIS dates are "YYYY/MM/DD/other"; Mendeley and Zotero also write ISO dates. */
function risDate(value: string): string {
  const parts = value.split("/");
  if (parts.length < 2) return value;
  const [year = "", month = "", day = ""] = parts;
  if (!/^\d{4}$/u.test(year)) return value;
  if (!/^\d{1,2}$/u.test(month)) return year;
  if (!/^\d{1,2}$/u.test(day)) return `${year}-${month.padStart(2, "0")}`;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function entryFromRaw(raw: RawRisRecord, index: number): BibliographyEntry {
  const builder = new BibliographyEntryBuilder(index, raw.line);
  const risType = (raw.tags[0]?.[1] ?? "").toUpperCase();
  builder.type = TYPE_BY_RIS_TYPE[risType] ?? "other";
  builder.customType = CUSTOM_TYPE_LABELS[risType] ?? (risType || "Document");
  const values = (tag: string) => raw.tags.filter(([name]) => name === tag).map(([, v]) => v);
  const first = (tag: string) => values(tag).find((value) => value.trim().length > 0) ?? null;
  const handled = new Set(["TY"]);
  const use = (...tags: string[]) => {
    for (const tag of tags) handled.add(tag);
  };

  const editorRole = builder.type === "book-chapter" || builder.type === "conference-paper";
  for (const [tag, role] of [
    ["AU", "author"],
    ["A1", "author"],
    ["A2", editorRole || builder.type === "book" ? "editor" : "contributor"],
    ["ED", "editor"],
    ["A3", "seriesEditor"],
    ["A4", "translator"],
  ] as const) {
    use(tag);
    builder.addCreators(
      values(tag).flatMap((name) => parsePlainName(name, role) ?? []),
      tag,
    );
  }

  const isBook = builder.type === "book";
  for (const tag of isBook ? ["TI", "T1", "BT", "CT"] : ["TI", "T1", "CT"]) {
    use(tag);
    builder.set("title", first(tag), tag);
  }
  for (const tag of isBook ? ["T2", "JF", "JO"] : ["T2", "JF", "JO", "BT", "JA", "J2", "J1"]) {
    use(tag);
    builder.set("containerTitle", first(tag), tag);
  }
  for (const tag of ["DA", "Y1", "PY"]) {
    use(tag);
    const value = first(tag);
    if (value) builder.set("issuedRaw", risDate(value), tag);
  }
  use("VL", "IS", "CP", "SP", "EP", "PB", "LA", "AB", "N2", "N1", "KW", "DO", "UR", "SN", "ID");
  builder.set("volume", first("VL"), "VL");
  builder.set("issue", first("IS") ?? first("CP"), first("IS") ? "IS" : "CP");
  const start = first("SP");
  const end = first("EP");
  if (start) {
    builder.set(
      "pages",
      end && !start.includes("-") ? `${start}-${end}` : start.replace(/\s*[–—]+\s*/gu, "-"),
      "SP",
    );
  }
  builder.set("publisher", first("PB"), "PB");
  builder.set("language", first("LA"), "LA");
  builder.set("abstract", first("AB") ?? first("N2"), first("AB") ? "AB" : "N2");
  for (const note of values("N1")) builder.addNote(note.replace(/<[^>]+>/gu, " "));
  builder.addTags(
    values("KW").flatMap((value) => value.split(/\n|;/u)),
    "KW",
  );
  for (const value of values("DO")) builder.addIdentifier("doi", value, "DO");
  for (const value of values("SN")) {
    for (const part of value.split(/[;,\n]|\s+(?=\d)/u)) {
      const clean = collapseWhitespace(part.replace(/\(.*?\)/gu, ""));
      const scheme = standardNumberScheme(clean);
      if (scheme) builder.addIdentifier(scheme, clean, "SN");
      else if (clean) builder.notKeep("SN");
    }
  }
  for (const value of values("AN")) {
    const prefixed = value.match(/^pmid:?\s*(\d{1,9})$/iu)?.[1];
    const plain = value.match(/^\d{1,9}$/u)?.[0];
    const fromPubmed = /pubmed|medline/iu.test([...values("DB"), ...values("DP")].join(" "));
    const pmid = prefixed ?? (fromPubmed ? plain : undefined);
    if (pmid) {
      builder.addIdentifier("pmid", pmid, "AN");
    }
  }
  for (const value of values("C2")) {
    const pmcid = value.match(/\bPMC\d+\b/u)?.[0];
    if (pmcid) {
      use("C2");
      builder.addIdentifier("pmcid", pmcid, "C2");
    }
  }
  const urls = [...values("UR"), ...values("L2"), ...values("LK")].flatMap((value) =>
    value.split(/\s+/u),
  );
  for (const url of urls) {
    if (!/^https?:\/\//iu.test(url)) continue;
    const doi = url.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/iu)?.[1];
    if (doi) builder.addIdentifier("doi", decodeURIComponent(doi), "UR");
    builder.set("url", url, "UR");
  }
  use("L2", "LK");
  const key = first("ID");
  if (key && !/^\d+$/u.test(key)) builder.citationKey = plausibleCitationKey(key);
  if (
    builder.type === "article" &&
    /\b(?:arxiv|biorxiv|medrxiv|ssrn)\b/iu.test(builder.get("containerTitle") ?? "")
  ) {
    builder.type = "preprint";
  }

  for (const [tag] of raw.tags) {
    if (!handled.has(tag) && !IGNORED_TAGS.has(tag)) builder.notKeep(tag);
  }
  return builder.build();
}

export function parseRis(text: string): BibliographyParseResult {
  const { records, unreadable } = readRis(text);
  return { format: "ris", entries: records.map(entryFromRaw), unreadable };
}

const RIS_TYPE_BY_TYPE: Readonly<Record<ScientSourceType, string>> = {
  article: "JOUR",
  preprint: "JOUR",
  book: "BOOK",
  "book-chapter": "CHAP",
  "conference-paper": "CPAPER",
  thesis: "THES",
  report: "RPRT",
  dataset: "DATA",
  web: "ELEC",
  other: "GEN",
};

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/gu, " ").trim();
}

export function formatRis(
  items: ReadonlyArray<BibliographyExportItem>,
  options: BibliographyExportOptions,
): string {
  return items
    .map(({ record, citationKey }) => {
      const lines: string[] = [`TY  - ${RIS_TYPE_BY_TYPE[record.type]}`, `ID  - ${citationKey}`];
      const add = (tag: string, value: string | null | undefined, multiline = false) => {
        const clean = value?.trim();
        if (clean) lines.push(`${tag}  - ${multiline ? clean : oneLine(clean)}`);
      };
      for (const creator of record.creators) {
        const role = creator.creatorType.toLowerCase();
        const tag =
          role === "author"
            ? "AU"
            : role === "editor"
              ? "ED"
              : role === "serieseditor"
                ? "A3"
                : role === "translator"
                  ? "A4"
                  : "A2";
        add(tag, creator.literalName ? `${creator.literalName},` : plainCreatorName(creator));
      }
      add("TI", record.title);
      add(
        record.type === "article" || record.type === "preprint" ? "JO" : "T2",
        record.containerTitle,
      );
      const issued = record.issuedRaw?.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/u);
      if (issued?.[1]) {
        add("PY", issued[1]);
        if (issued[2]) {
          add(
            "DA",
            `${issued[1]}/${issued[2].padStart(2, "0")}/${issued[3]?.padStart(2, "0") ?? ""}`,
          );
        }
      } else if (record.issuedYear !== null) add("PY", String(record.issuedYear));
      add("VL", record.volume);
      add("IS", record.issue);
      const [startPage, endPage] = (record.pages ?? "").split(/\s*[-–—]+\s*/u);
      add("SP", startPage);
      add("EP", endPage);
      add("PB", record.publisher);
      for (const identifier of record.identifiers) {
        const scheme = identifier.scheme.toLowerCase();
        if (scheme === "doi") add("DO", identifier.value);
        else if (scheme === "isbn" || scheme === "issn") add("SN", identifier.value);
        else if (scheme === "pmcid") add("C2", identifier.value);
        else if (scheme === "pmid") {
          add("AN", identifier.value);
          add("DB", "PubMed");
        } else if (scheme === "arxiv") add("UR", `https://arxiv.org/abs/${identifier.value}`);
      }
      add("UR", record.url);
      add("LA", record.language);
      add("AB", record.abstract);
      for (const tag of record.tags) add("KW", tag);
      if (options.includeNotes) add("N1", record.note ?? null, true);
      if (record.type === "other" && record.customType) add("M3", record.customType);
      lines.push("ER  - ");
      return lines.join("\r\n");
    })
    .join("\r\n\r\n")
    .concat(items.length > 0 ? "\r\n" : "");
}
