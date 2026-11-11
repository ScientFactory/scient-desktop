import type { ScientSourceType } from "../model.ts";
import { normalizeImportedCitationKey } from "../citationKeys.ts";
import {
  BibliographyEntryBuilder,
  standardNumberScheme,
  type BibliographyEntry,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyParseResult,
} from "./entry.ts";
import { collapseWhitespace } from "./latex.ts";
import { parsePlainName, plainCreatorName } from "./names.ts";
import {
  childElements,
  encodeXmlText,
  findElements,
  parseXml,
  textContent,
  type XmlElement,
} from "./xml.ts";

const TYPE_BY_ENDNOTE_TYPE: Readonly<Record<string, ScientSourceType>> = {
  "journal article": "article",
  "electronic article": "article",
  "magazine article": "article",
  "newspaper article": "article",
  book: "book",
  "edited book": "book",
  "electronic book": "book",
  "book section": "book-chapter",
  "electronic book section": "book-chapter",
  encyclopedia: "book-chapter",
  "conference paper": "conference-paper",
  "conference proceedings": "conference-paper",
  thesis: "thesis",
  report: "report",
  "government document": "report",
  dataset: "dataset",
  "web page": "web",
  blog: "web",
};

const TYPE_BY_ENDNOTE_NUMBER: Readonly<Record<string, ScientSourceType>> = {
  "17": "article",
  "43": "article",
  "6": "book",
  "28": "book",
  "5": "book-chapter",
  "47": "conference-paper",
  "10": "conference-paper",
  "32": "thesis",
  "27": "report",
  "59": "dataset",
  "12": "web",
};

const IGNORED_ELEMENTS = new Set([
  "database",
  "source-app",
  "rec-number",
  "foreign-keys",
  "ref-type",
  "remote-database-name",
  "remote-database-provider",
  "access-date",
  "modified-date",
  "short-title",
  "alt-periodical",
  "work-type",
]);

function text(element: XmlElement | undefined): string | null {
  if (!element) return null;
  const value = collapseWhitespace(textContent(element));
  return value || null;
}

function multilineText(element: XmlElement | undefined): string | null {
  if (!element) return null;
  const value = textContent(element).replace(/\r\n?/gu, "\n").trim();
  return value || null;
}

function entryFromRecord(record: XmlElement, index: number): BibliographyEntry {
  const builder = new BibliographyEntryBuilder(index, record.line);
  const child = (name: string) => childElements(record, name)[0];
  const refType = child("ref-type");
  const typeName = (refType?.attributes["name"] ?? "").trim();
  builder.type =
    TYPE_BY_ENDNOTE_TYPE[typeName.toLowerCase()] ??
    TYPE_BY_ENDNOTE_NUMBER[text(refType) ?? ""] ??
    "other";
  builder.customType = typeName || "Document";

  const contributors = child("contributors");
  const roleFor: Record<string, string> = {
    authors: "author",
    "secondary-authors": "editor",
    "tertiary-authors": "seriesEditor",
    "subsidiary-authors": "translator",
    "translated-authors": "translator",
  };
  for (const group of contributors ? childElements(contributors) : []) {
    const role = roleFor[group.name];
    const names = childElements(group, "author").flatMap(
      (author) => parsePlainName(textContent(author), role ?? "contributor") ?? [],
    );
    if (role) builder.addCreators(names, `contributors/${group.name}`);
    else if (names.length > 0) builder.notKeep(`contributors/${group.name}`);
  }

  const titles = child("titles");
  const title = (name: string) => (titles ? text(childElements(titles, name)[0]) : null);
  builder.set("title", title("title"), "titles/title");
  builder.set("containerTitle", title("secondary-title"), "titles/secondary-title");
  const periodical = child("periodical");
  if (periodical) {
    builder.set(
      "containerTitle",
      text(childElements(periodical, "full-title")[0]),
      "periodical/full-title",
    );
    builder.set(
      "containerTitle",
      text(childElements(periodical, "abbr-1")[0]),
      "periodical/abbr-1",
    );
  }
  if (titles) {
    for (const element of childElements(titles)) {
      if (!["title", "secondary-title", "short-title", "alt-title"].includes(element.name)) {
        builder.notKeep(`titles/${element.name}`);
      }
    }
  }

  const dates = child("dates");
  const year = dates ? text(childElements(dates, "year")[0]) : null;
  const pubDate = dates
    ? findElements(dates, "date")
        .map((date) => text(date))
        .find(Boolean)
    : null;
  const isoDate = pubDate?.match(/^\d{4}-\d{2}(?:-\d{2})?$/u) ? pubDate : null;
  builder.set("issuedRaw", isoDate ?? year, isoDate ? "dates/pub-dates" : "dates/year");

  builder.set("volume", text(child("volume")), "volume");
  builder.set(
    "issue",
    text(child("number")) ?? text(child("issue")),
    child("number") ? "number" : "issue",
  );
  const pages = text(child("pages"));
  if (pages) builder.set("pages", pages.replace(/\s*[–—]+\s*/gu, "-"), "pages");
  builder.set("publisher", text(child("publisher")), "publisher");
  builder.set("language", text(child("language")), "language");
  builder.set("abstract", multilineText(child("abstract")), "abstract");
  builder.addNote(multilineText(child("notes")));
  builder.addNote(multilineText(child("research-notes")));

  const doi = text(child("electronic-resource-num"));
  if (doi) builder.addIdentifier("doi", doi, "electronic-resource-num");
  for (const part of (text(child("isbn")) ?? "").split(/[;,\n]|\s+(?=\d)/u)) {
    const clean = collapseWhitespace(part.replace(/\(.*?\)/gu, ""));
    const scheme = standardNumberScheme(clean);
    if (scheme) builder.addIdentifier(scheme, clean, "isbn");
    else if (clean) builder.notKeep("isbn");
  }
  const accession = text(child("accession-num"));
  const arxiv = accession?.match(/^arxiv:\s*(\S+)$/iu)?.[1];
  const database = `${text(child("remote-database-name")) ?? ""} ${text(child("remote-database-provider")) ?? ""}`;
  if (arxiv) builder.addIdentifier("arxiv", arxiv, "accession-num");
  else if (accession && /^\d{1,9}$/u.test(accession) && /pubmed|medline|nlm/iu.test(database)) {
    builder.addIdentifier("pmid", accession, "accession-num");
  } else if (accession) builder.notKeep("accession-num");
  // EndNote's PubMed import keeps the PMCID in Custom 2.
  const custom2 = text(child("custom2"));
  const pmcid = custom2?.match(/\bPMC\d+\b/u)?.[0];
  if (pmcid) builder.addIdentifier("pmcid", pmcid, "custom2");
  else if (custom2) builder.notKeep("custom2");
  if (builder.type === "article" && /^preprint$/iu.test(text(child("work-type")) ?? "")) {
    builder.type = "preprint";
  }

  const keywords = child("keywords");
  if (keywords) {
    builder.addTags(
      childElements(keywords, "keyword").flatMap((keyword) => text(keyword) ?? []),
      "keywords",
    );
  }
  const urls = child("urls");
  if (urls) {
    for (const url of findElements(urls, "url")) {
      const value = text(url);
      if (!value || !/^https?:\/\//iu.test(value)) continue;
      builder.set("url", value, "urls/related-urls");
    }
    for (const pdfUrls of childElements(urls, "pdf-urls")) {
      for (const url of findElements(pdfUrls, "url")) {
        const value = text(url);
        if (value) builder.addLinkedFile(value, "urls/pdf-urls");
      }
    }
  }
  builder.citationKey = normalizeImportedCitationKey(text(child("label")));

  const handled = new Set([
    "contributors",
    "titles",
    "periodical",
    "dates",
    "volume",
    "number",
    "issue",
    "pages",
    "publisher",
    "language",
    "abstract",
    "notes",
    "research-notes",
    "electronic-resource-num",
    "isbn",
    "accession-num",
    "custom2",
    "keywords",
    "urls",
    "label",
  ]);
  for (const element of childElements(record)) {
    if (!handled.has(element.name) && !IGNORED_ELEMENTS.has(element.name) && text(element)) {
      builder.notKeep(element.name);
    }
  }
  return builder.build();
}

export function parseEndnoteXml(text: string): BibliographyParseResult {
  const document = parseXml(text);
  const records = findElements(document, "record");
  return {
    format: "endnote-xml",
    entries: records.map(entryFromRecord),
    unreadable:
      records.length === 0 && text.trim().length > 0
        ? [
            {
              line: null,
              citationKey: null,
              reason: "No EndNote records were found in this XML file.",
            },
          ]
        : [],
  };
}

const ENDNOTE_TYPE_BY_TYPE: Readonly<Record<ScientSourceType, readonly [string, number]>> = {
  article: ["Journal Article", 17],
  preprint: ["Electronic Article", 43],
  book: ["Book", 6],
  "book-chapter": ["Book Section", 5],
  "conference-paper": ["Conference Paper", 47],
  thesis: ["Thesis", 32],
  report: ["Report", 27],
  dataset: ["Dataset", 59],
  web: ["Web Page", 12],
  other: ["Generic", 13],
};

function element(name: string, value: string | null | undefined): string {
  const clean = value?.trim();
  return clean ? `<${name}>${encodeXmlText(clean)}</${name}>` : "";
}

export function formatEndnoteXml(
  items: ReadonlyArray<BibliographyExportItem>,
  options: BibliographyExportOptions,
): string {
  const records = items.map(({ record, citationKey }, index) => {
    const [typeName, typeNumber] = ENDNOTE_TYPE_BY_TYPE[record.type];
    const names = (roles: ReadonlySet<string>) =>
      record.creators
        .filter((creator) => roles.has(creator.creatorType.toLowerCase()))
        .map((creator) =>
          element(
            "author",
            creator.literalName ? `${creator.literalName},` : plainCreatorName(creator),
          ),
        )
        .join("");
    const authors = names(new Set(["author"]));
    const editors = names(new Set(["editor", "contributor"]));
    const seriesEditors = names(new Set(["serieseditor"]));
    const translators = names(new Set(["translator"]));
    const contributors = [
      authors ? `<authors>${authors}</authors>` : "",
      editors ? `<secondary-authors>${editors}</secondary-authors>` : "",
      seriesEditors ? `<tertiary-authors>${seriesEditors}</tertiary-authors>` : "",
      translators ? `<subsidiary-authors>${translators}</subsidiary-authors>` : "",
    ].join("");
    const identifier = (scheme: string) =>
      record.identifiers.find((entry) => entry.scheme.toLowerCase() === scheme)?.value;
    const standardNumbers = record.identifiers
      .filter((entry) => ["isbn", "issn"].includes(entry.scheme.toLowerCase()))
      .map((entry) => entry.value)
      .join("; ");
    const pmid = identifier("pmid");
    const arxiv = identifier("arxiv");
    const isArticle = record.type === "article" || record.type === "preprint";
    const year = record.issuedYear !== null ? String(record.issuedYear) : record.issuedRaw;
    const pubDate = record.issuedRaw && record.issuedRaw !== year ? record.issuedRaw : null;
    const parts = [
      `<rec-number>${index + 1}</rec-number>`,
      `<ref-type name="${typeName}">${typeNumber}</ref-type>`,
      contributors ? `<contributors>${contributors}</contributors>` : "",
      `<titles>${element("title", record.title)}${element("secondary-title", record.containerTitle)}</titles>`,
      isArticle && record.containerTitle
        ? `<periodical>${element("full-title", record.containerTitle)}</periodical>`
        : "",
      element("pages", record.pages),
      element("volume", record.volume),
      element("number", record.issue),
      record.tags.length > 0
        ? `<keywords>${record.tags.map((tag) => element("keyword", tag)).join("")}</keywords>`
        : "",
      year || pubDate
        ? `<dates>${element("year", year)}${pubDate ? `<pub-dates>${element("date", pubDate)}</pub-dates>` : ""}</dates>`
        : "",
      element("publisher", record.publisher),
      element("isbn", standardNumbers),
      element("accession-num", pmid ?? (arxiv ? `arXiv:${arxiv}` : null)),
      element("electronic-resource-num", identifier("doi")),
      element("abstract", record.abstract),
      options.includeNotes ? element("notes", record.note ?? null) : "",
      element("label", citationKey),
      record.url ? `<urls><related-urls>${element("url", record.url)}</related-urls></urls>` : "",
      pmid || arxiv ? element("remote-database-name", pmid ? "PubMed" : "arXiv") : "",
      element("language", record.language),
      record.type === "preprint"
        ? element("work-type", "Preprint")
        : record.type === "other" && record.customType
          ? element("work-type", record.customType)
          : "",
      element("custom2", identifier("pmcid")),
    ];
    return `<record>${parts.join("")}</record>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xml><records>\n${records.join("\n")}\n</records></xml>\n`;
}
