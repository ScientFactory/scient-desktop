// @effect-diagnostics nodeBuiltinImport:off -- This adapter reads an environment-local staged PDF.
// @effect-diagnostics globalDate:off -- Staged project metadata uses an interoperable ISO timestamp.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  assessSourceDuplicate,
  normalizePersistentIdentifier,
  normalizeScientSourceAbstractDocument,
  sourceMetadataDiagnostics,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceAttachment,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourcePreflightItem,
  type ScientSourceRecord,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import {
  listScientSourceRecords,
  inspectScientSourcePdf,
  readScientSourceStagedMaterial,
  removeScientSourceStagedMaterial,
  stageScientSourcePdfUpload,
  stagedScientSourcePdfAbsolutePath,
  writeScientSourceStagedMaterial,
} from "@scientfactory/scient-sources/store";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { runWithNcbiRequestLimit } from "./NcbiRequestLane.ts";
import { enrichScientSourceCandidate, requestMetadataJson } from "./SourceMetadataEnricher.ts";

const MAX_EXTRACTED_TEXT_LENGTH = 64 * 1024;

const PdfInfo = Schema.Struct({
  Title: Schema.optionalKey(Schema.Unknown),
  Author: Schema.optionalKey(Schema.Unknown),
  Subject: Schema.optionalKey(Schema.Unknown),
  Keywords: Schema.optionalKey(Schema.Unknown),
  CreationDate: Schema.optionalKey(Schema.Unknown),
});

const CslCreator = Schema.Struct({
  given: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.String),
});
const CslDate = Schema.Struct({
  "date-parts": Schema.optionalKey(
    Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  ),
  raw: Schema.optionalKey(Schema.String),
});
const CslMetadata = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.Array(CslCreator)),
  issued: Schema.optionalKey(CslDate),
  DOI: Schema.optionalKey(Schema.String),
  ISBN: Schema.optionalKey(Schema.String),
  ISSN: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  abstract: Schema.optionalKey(Schema.String),
  "container-title": Schema.optionalKey(Schema.String),
  publisher: Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String),
  URL: Schema.optionalKey(Schema.String),
});
type CslMetadata = typeof CslMetadata.Type;

const PubmedAuthor = Schema.Struct({ name: Schema.optionalKey(Schema.String) });
const PubmedArticleId = Schema.Struct({
  idtype: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
});
const PubmedSummary = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  authors: Schema.optionalKey(Schema.Array(PubmedAuthor)),
  pubdate: Schema.optionalKey(Schema.String),
  fulljournalname: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  pages: Schema.optionalKey(Schema.String),
  lang: Schema.optionalKey(Schema.Array(Schema.String)),
  articleids: Schema.optionalKey(Schema.Array(PubmedArticleId)),
});
const PubmedResponse = Schema.Struct({
  result: Schema.Record(Schema.String, Schema.Unknown),
});
const decodePdfInfo = Schema.decodeUnknownSync(PdfInfo);
const decodeCslMetadata = Schema.decodeUnknownSync(CslMetadata);
const decodePubmedResponse = Schema.decodeUnknownSync(PubmedResponse);
const decodePubmedSummary = Schema.decodeUnknownSync(PubmedSummary);

function textValues(value: unknown): ReadonlyArray<string> {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (!Predicate.isString(entry)) return [];
    const trimmed = entry.trim();
    return trimmed ? [trimmed] : [];
  });
}

function text(value: unknown): string | null {
  return textValues(value)[0] ?? null;
}

function year(value: string | null | undefined): number | null {
  const match = value?.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function embeddedTitleWordCount(value: string): number {
  return value.match(/\p{L}[\p{L}\p{M}'’.-]*/gu)?.filter((word) => word.length > 1).length ?? 0;
}

function looksLikeFileLabel(value: string): boolean {
  const fileShaped = /[\\/_]/u.test(value) || /\.pdf$/iu.test(value);
  return fileShaped && embeddedTitleWordCount(value) <= 2;
}

function selectEmbeddedPdfTitle(input: {
  readonly xmpTitle: unknown;
  readonly infoTitle: unknown;
  readonly fallbackTitle: string | null;
}): string | null {
  const xmpTitle = text(input.xmpTitle);
  const infoTitle = text(input.infoTitle);
  if (
    xmpTitle &&
    infoTitle &&
    xmpTitle !== infoTitle &&
    looksLikeFileLabel(xmpTitle) &&
    embeddedTitleWordCount(infoTitle) >= 3
  ) {
    return infoTitle;
  }
  return xmpTitle ?? infoTitle ?? input.fallbackTitle;
}

function normalizeEmbeddedPdfDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const pdfDate = raw.match(
    /^D:(1[5-9]\d{2}|20\d{2}|21\d{2})(\d{2})?(\d{2})?(?:\d{2}){0,3}(?:Z(?:\d{2}'?\d{2}'?)?|[+-]\d{2}'?\d{2}'?)?$/u,
  );
  const pdfYear = pdfDate?.[1];
  if (!pdfYear) return raw;
  const month = pdfDate[2] ? Number.parseInt(pdfDate[2], 10) : null;
  const day = pdfDate[3] ? Number.parseInt(pdfDate[3], 10) : null;
  if (month !== null && (month < 1 || month > 12)) return raw;
  if (day !== null) {
    const daysInMonth = new Date(
      Date.UTC(Number.parseInt(pdfYear, 10), month ?? 1, 0),
    ).getUTCDate();
    if (day < 1 || day > daysInMonth) return raw;
  }
  return [pdfYear, pdfDate[2], pdfDate[3]].filter(Boolean).join("-");
}

function cslIssuedDate(issued: CslMetadata["issued"]): {
  readonly raw: string | null;
  readonly year: number | null;
} {
  const raw = text(issued?.raw);
  const datePart = issued?.["date-parts"]?.[0] ?? [];
  const values = datePart
    .slice(0, 3)
    .map((value) => (typeof value === "number" ? value : Number.parseInt(value, 10)));
  const [issuedYear, month, day] = values;
  const validYear =
    issuedYear !== undefined && issuedYear >= 1500 && issuedYear <= 2199 ? issuedYear : null;
  const validMonth = month !== undefined && month >= 1 && month <= 12 ? month : null;
  const validDay =
    day !== undefined && validMonth !== null
      ? day >= 1 && day <= new Date(Date.UTC(validYear ?? 2000, validMonth, 0)).getUTCDate()
        ? day
        : null
      : null;
  const formatted =
    validYear === null
      ? null
      : [
          String(validYear),
          ...(validMonth === null ? [] : [String(validMonth).padStart(2, "0")]),
          ...(validDay === null ? [] : [String(validDay).padStart(2, "0")]),
        ].join("-");
  return {
    raw: raw ?? formatted,
    year: validYear ?? year(raw),
  };
}

function embeddedCreatorNames(value: unknown): ReadonlyArray<string> {
  return textValues(value).flatMap((entry) => {
    const explicitlySeparated = entry
      .split(/\s*(?:;|\band\b)\s*/iu)
      .map((name) => name.trim())
      .filter(Boolean);
    if (explicitlySeparated.length > 1) return explicitlySeparated;

    const commaSeparated = entry
      .split(/\s*,\s*/u)
      .map((name) => name.trim())
      .filter(Boolean);
    return commaSeparated.length > 1 && commaSeparated.every((name) => /\s/u.test(name))
      ? commaSeparated
      : [entry];
  });
}

function embeddedCreators(value: unknown): ReadonlyArray<ScientSourceCreator> {
  return embeddedCreatorNames(value)
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 256)
    .map((name) => {
      const comma = name.match(/^([^,]+),\s*(.+)$/u);
      return comma?.[1] && comma[2]
        ? {
            creatorType: "author",
            familyName: comma[1].trim(),
            givenName: comma[2].trim(),
            literalName: null,
          }
        : {
            creatorType: "author",
            familyName: null,
            givenName: null,
            literalName: name,
          };
    });
}

function cslCreators(values: ReadonlyArray<typeof CslCreator.Type> | undefined) {
  return (values ?? []).flatMap((value): ReadonlyArray<ScientSourceCreator> => {
    const givenName = text(value.given);
    const familyName = text(value.family);
    const literalName = text(value.literal);
    return givenName || familyName || literalName
      ? [{ creatorType: "author", givenName, familyName, literalName }]
      : [];
  });
}

function sourceTypeFromCsl(value: string | undefined): ScientSourceType {
  switch (value) {
    case "article-journal":
    case "journal-article":
    case "article-magazine":
    case "article-newspaper":
      return "article";
    case "paper-conference":
      return "conference-paper";
    case "chapter":
      return "book-chapter";
    case "book":
      return "book";
    case "thesis":
      return "thesis";
    case "report":
      return "report";
    case "dataset":
      return "dataset";
    case "webpage":
    case "post-weblog":
      return "web";
    default:
      return "other";
  }
}

function deduplicateIdentifiers(
  values: ReadonlyArray<ScientSourceIdentifier>,
): ReadonlyArray<ScientSourceIdentifier> {
  const seen = new Set<string>();
  return values.filter((identifier) => {
    const key = `${identifier.scheme.toLowerCase()}:${identifier.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function provenance(
  origin: ScientSourceFieldProvenance["origin"],
  values: ReadonlyArray<readonly [string, string, boolean]>,
): ReadonlyArray<ScientSourceFieldProvenance> {
  return values
    .filter(([, , present]) => present)
    .map(([field, sourceField]) => ({ field, origin, sourceField }));
}

function candidateFromCsl(input: {
  readonly sourceKey: string;
  readonly csl: CslMetadata;
  readonly fallback: ScientSourceCandidate;
}): ScientSourceCandidate {
  const issued = cslIssuedDate(input.csl.issued);
  const creators = cslCreators(input.csl.author);
  const cslDoi = text(input.csl.DOI);
  const identifiers = deduplicateIdentifiers([
    ...(cslDoi ? [{ scheme: "doi", value: cslDoi }] : []),
    ...(text(input.csl.ISBN) ? [{ scheme: "isbn", value: text(input.csl.ISBN)! }] : []),
    ...(typeof input.csl.ISSN !== "string" && input.csl.ISSN
      ? input.csl.ISSN.flatMap((value) => (text(value) ? [{ scheme: "issn", value }] : []))
      : text(input.csl.ISSN)
        ? [{ scheme: "issn", value: text(input.csl.ISSN)! }]
        : []),
    ...input.fallback.identifiers.filter(
      (identifier) => !(cslDoi && identifier.scheme.trim().toLowerCase() === "doi"),
    ),
  ]);
  const abstract = normalizeScientSourceAbstractDocument(input.csl.abstract);
  const candidate: ScientSourceCandidate = {
    ...input.fallback,
    sourceKey: input.sourceKey,
    type: sourceTypeFromCsl(input.csl.type),
    customType:
      input.csl.type && sourceTypeFromCsl(input.csl.type) === "other" ? input.csl.type : null,
    title: text(input.csl.title) ?? input.fallback.title,
    creators: creators.length > 0 ? creators : input.fallback.creators,
    issuedRaw: issued.raw ?? input.fallback.issuedRaw,
    issuedYear: issued.year ?? input.fallback.issuedYear,
    identifiers,
    abstract: abstract?.text ?? input.fallback.abstract,
    ...(abstract
      ? { abstractSections: [...abstract.sections] }
      : input.fallback.abstractSections
        ? { abstractSections: input.fallback.abstractSections }
        : {}),
    containerTitle: text(input.csl["container-title"]) ?? input.fallback.containerTitle,
    publisher: text(input.csl.publisher) ?? input.fallback.publisher,
    volume: text(input.csl.volume) ?? input.fallback.volume,
    issue: text(input.csl.issue) ?? input.fallback.issue,
    pages: text(input.csl.page) ?? input.fallback.pages,
    language: text(input.csl.language) ?? input.fallback.language,
    url: text(input.csl.URL) ?? (cslDoi ? `https://doi.org/${cslDoi}` : input.fallback.url),
  };
  return {
    ...candidate,
    fieldProvenance: [
      ...input.fallback.fieldProvenance,
      ...provenance("doi", [
        ["type", "type", text(input.csl.type) !== null],
        ["title", "title", text(input.csl.title) !== null],
        ["creators", "author", creators.length > 0],
        ["issuedRaw", "issued", issued.raw !== null],
        ["abstract", "abstract", text(input.csl.abstract) !== null],
        ["containerTitle", "container-title", text(input.csl["container-title"]) !== null],
        ["publisher", "publisher", text(input.csl.publisher) !== null],
        ["volume", "volume", text(input.csl.volume) !== null],
        ["issue", "issue", text(input.csl.issue) !== null],
        ["pages", "page", text(input.csl.page) !== null],
        ["language", "language", text(input.csl.language) !== null],
        ["url", "URL", candidate.url !== input.fallback.url],
        ["identifiers", "DOI/ISBN/ISSN", identifiers.length > input.fallback.identifiers.length],
      ]),
    ],
  };
}

function candidateFromPubmed(input: {
  readonly pmid: string;
  readonly summary: typeof PubmedSummary.Type;
  readonly fallback: ScientSourceCandidate;
}): ScientSourceCandidate {
  const creators = (input.summary.authors ?? []).flatMap(
    (author): ReadonlyArray<ScientSourceCreator> => {
      const name = text(author.name);
      return name
        ? [{ creatorType: "author", givenName: null, familyName: null, literalName: name }]
        : [];
    },
  );
  const identifiers = deduplicateIdentifiers([
    { scheme: "pmid", value: input.pmid },
    ...(input.summary.articleids ?? []).flatMap((identifier) => {
      const scheme = text(identifier.idtype)?.toLowerCase();
      const value = text(identifier.value);
      return scheme && value && ["doi", "pmc", "pii"].includes(scheme) ? [{ scheme, value }] : [];
    }),
    ...input.fallback.identifiers,
  ]);
  const issuedRaw = text(input.summary.pubdate);
  const candidate: ScientSourceCandidate = {
    ...input.fallback,
    type: "article",
    customType: null,
    title: text(input.summary.title) ?? input.fallback.title,
    creators: creators.length > 0 ? creators : input.fallback.creators,
    issuedRaw: issuedRaw ?? input.fallback.issuedRaw,
    issuedYear: year(issuedRaw) ?? input.fallback.issuedYear,
    identifiers,
    containerTitle:
      text(input.summary.fulljournalname) ??
      text(input.summary.source) ??
      input.fallback.containerTitle,
    volume: text(input.summary.volume) ?? input.fallback.volume,
    issue: text(input.summary.issue) ?? input.fallback.issue,
    pages: text(input.summary.pages) ?? input.fallback.pages,
    language: text(input.summary.lang?.[0]) ?? input.fallback.language,
    url: input.fallback.url ?? `https://pubmed.ncbi.nlm.nih.gov/${input.pmid}/`,
  };
  return {
    ...candidate,
    fieldProvenance: [
      ...input.fallback.fieldProvenance,
      ...provenance("pubmed", [
        ["title", "title", text(input.summary.title) !== null],
        ["creators", "authors", creators.length > 0],
        ["issuedRaw", "pubdate", issuedRaw !== null],
        ["identifiers", "articleids", true],
        [
          "containerTitle",
          "fulljournalname",
          candidate.containerTitle !== input.fallback.containerTitle,
        ],
        ["volume", "volume", text(input.summary.volume) !== null],
        ["issue", "issue", text(input.summary.issue) !== null],
        ["pages", "pages", text(input.summary.pages) !== null],
        ["language", "lang", text(input.summary.lang?.[0]) !== null],
        ["url", "pmid", input.fallback.url === null],
      ]),
    ],
  };
}

async function resolveDoi(doi: string): Promise<CslMetadata | null> {
  for (const candidate of doiCandidates(doi)) {
    try {
      const encodedDoi = candidate.split("/").map(encodeURIComponent).join("/");
      const value = await requestMetadataJson(new URL(`https://doi.org/${encodedDoi}`), {
        Accept: "application/vnd.citationstyles.csl+json",
        "User-Agent": "Scient/0.0 (source metadata resolution)",
      });
      const metadata = decodeCslMetadata(value);
      const resolvedDoi = text(metadata.DOI);
      if (!resolvedDoi || doiCandidates(resolvedDoi).includes(candidate)) return metadata;
    } catch {
      // Try the next conservative DOI candidate independently.
    }
  }
  return null;
}

async function resolvePubmed(pmid: string): Promise<typeof PubmedSummary.Type | null> {
  try {
    const parameters = new URLSearchParams({
      db: "pubmed",
      id: pmid,
      retmode: "json",
      tool: "scient_desktop",
    });
    const value = await runWithNcbiRequestLimit(() =>
      requestMetadataJson(
        new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${parameters}`),
        { "User-Agent": "Scient/0.0 (source metadata resolution)" },
      ),
    );
    const decoded = decodePubmedResponse(value);
    const summary = decoded.result[pmid];
    return summary === undefined ? null : decodePubmedSummary(summary);
  } catch {
    return null;
  }
}

function uniqueDoi(textValue: string): string | null {
  const normalizedContexts = [
    ...textValue.matchAll(/\bDOI\s*:?\s*.{0,192}/giu),
    ...textValue.matchAll(
      /(?:https?\s*:\s*\/\s*\/\s*)?(?:dx\s*\.\s*)?doi\s*\.\s*org\s*\/\s*.{0,160}/giu,
    ),
  ].map((match) =>
    (match[0] ?? "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
      .replace(/\s*([-._;/:])\s*/gu, "$1"),
  );
  const values = new Set(
    [textValue, ...normalizedContexts].flatMap((context) =>
      [...context.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu)].map((match) =>
        (match[0] ?? "").replace(/[.,;:)\]}]+$/u, "").toLowerCase(),
      ),
    ),
  );
  if (values.size === 1) return [...values][0]!;

  const articleDoi = [...values].find((value) =>
    [...values].every(
      (candidate) =>
        candidate === value ||
        (candidate.startsWith(`${value}.`) &&
          /^[a-z]\d+$/iu.test(candidate.slice(value.length + 1))),
    ),
  );
  if (articleDoi) return articleDoi;

  const longestFirst = [...values].toSorted((left, right) => right.length - left.length);
  const longest = longestFirst[0];
  return longest && longestFirst.every((value) => longest === value || longest.startsWith(value))
    ? longest
    : null;
}

function doiCandidates(value: string): ReadonlyArray<string> {
  const normalized = normalizePersistentIdentifier("doi", value).slice("doi:".length);
  const candidates = new Set([normalized]);
  const markerIndexes = ["(", ")"]
    .map((marker) => normalized.indexOf(marker))
    .filter((index) => index > 0);
  const firstMarker = markerIndexes.length > 0 ? Math.min(...markerIndexes) : -1;
  if (firstMarker > 0) candidates.add(normalized.slice(0, firstMarker));
  return [...candidates].filter((candidate) => /^10\.\d{4,9}\/\S+$/u.test(candidate));
}

function uniquePmid(textValue: string): string | null {
  const values = new Set(
    [...textValue.matchAll(/\bPMID\s*:?\s*(\d{6,9})\b/giu)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    ),
  );
  return values.size === 1 ? [...values][0]! : null;
}

function candidateFromEmbeddedPdf(input: {
  readonly sourceKey: string;
  readonly fileName: string;
  readonly title: string | null;
  readonly authors: ReadonlyArray<ScientSourceCreator>;
  readonly issuedRaw: string | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly keywords: ReadonlyArray<string>;
}): ScientSourceCandidate {
  const doi = input.identifiers.find((identifier) => identifier.scheme === "doi")?.value ?? null;
  const pmid = input.identifiers.find((identifier) => identifier.scheme === "pmid")?.value ?? null;
  return {
    sourceKey: input.sourceKey,
    type: "other",
    customType: null,
    title: input.title,
    creators: input.authors,
    issuedRaw: input.issuedRaw,
    issuedYear: year(input.issuedRaw),
    identifiers: input.identifiers,
    // PDF Subject and Dublin Core description are generic document metadata.
    // They may contain a citation, summary, or arbitrary publisher text, so
    // they are not authoritative evidence of a scholarly abstract.
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: doi ? `https://doi.org/${doi}` : pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
    tags: input.keywords,
    externalReferences: [],
    fieldProvenance: provenance("local-pdf", [
      ["title", "document-info/title", input.title !== null],
      ["creators", "document-info/author", input.authors.length > 0],
      ["issuedRaw", "document-info/date", input.issuedRaw !== null],
      ["tags", "document-info/keywords", input.keywords.length > 0],
      ["identifiers", "first-pages", input.identifiers.length > 0],
    ]),
    pdfAvailable: true,
    pdfFileName: input.fileName,
    pdfAttachmentCount: 1,
  };
}

async function extractPdfMetadata(input: {
  readonly sourceKey: string;
  readonly fileName: string;
  readonly pdfPath: string;
}): Promise<ScientSourceCandidate> {
  const fallbackTitle = text(
    NodePath.basename(input.fileName, NodePath.extname(input.fileName)).replace(/[_-]+/gu, " "),
  );
  let title: string | null = fallbackTitle;
  let authors: ReadonlyArray<ScientSourceCreator> = [];
  let documentDescription: string | null = null;
  let keywords: ReadonlyArray<string> = [];
  let issuedRaw: string | null = null;
  let extractedText = "";
  let pdfParsingFailed = false;

  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      url: NodeURL.pathToFileURL(input.pdfPath),
      disableAutoFetch: true,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    try {
      const document = await task.promise;
      try {
        const metadata = await document.getMetadata();
        let info: typeof PdfInfo.Type = {};
        try {
          info = decodePdfInfo(metadata.info);
        } catch {
          pdfParsingFailed = true;
        }
        title = selectEmbeddedPdfTitle({
          xmpTitle: metadata.metadata?.get("dc:title"),
          infoTitle: info.Title,
          fallbackTitle,
        });
        authors = embeddedCreators(metadata.metadata?.get("dc:creator") ?? info.Author);
        documentDescription = text(metadata.metadata?.get("dc:description")) ?? text(info.Subject);
        issuedRaw = normalizeEmbeddedPdfDate(
          metadata.metadata?.get("dc:date") ?? info.CreationDate,
        );
        keywords = (text(info.Keywords) ?? "")
          .split(/[,;]/u)
          .map((value) => value.trim())
          .filter(Boolean);
      } catch {
        pdfParsingFailed = true;
      }
      try {
        const pageCount = Math.min(2, document.numPages);
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          try {
            const page = await document.getPage(pageNumber);
            try {
              const content = await page.getTextContent();
              const pageText = content.items
                .flatMap((item) =>
                  Predicate.hasProperty(item, "str") && Predicate.isString(item.str)
                    ? [item.str]
                    : [],
                )
                .join(" ");
              extractedText = `${extractedText} ${pageText}`.slice(0, MAX_EXTRACTED_TEXT_LENGTH);
            } finally {
              page.cleanup();
            }
          } catch {
            pdfParsingFailed = true;
          }
        }
      } catch {
        pdfParsingFailed = true;
      } finally {
        await document.cleanup();
      }
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch {
    // A valid PDF can omit or expose unreadable metadata. The file still remains importable.
    pdfParsingFailed = true;
  }

  const searchable = [title, documentDescription, extractedText].filter(Boolean).join("\n");
  const doi = uniqueDoi(searchable);
  const pmid = uniquePmid(searchable);
  const identifiers: ScientSourceIdentifier[] = [
    ...(doi ? [{ scheme: "doi", value: doi }] : []),
    ...(pmid ? [{ scheme: "pmid", value: pmid }] : []),
  ];
  const fallback = candidateFromEmbeddedPdf({
    sourceKey: input.sourceKey,
    fileName: input.fileName,
    title,
    authors,
    issuedRaw,
    identifiers,
    keywords,
  });

  let candidate: ScientSourceCandidate = {
    ...fallback,
    fieldProvenance: [
      ...fallback.fieldProvenance,
      ...(pdfParsingFailed
        ? [{ field: "metadata", origin: "local-pdf" as const, sourceField: "pdf-parser" }]
        : []),
    ],
  };
  const csl = doi ? await resolveDoi(doi) : null;
  if (csl) {
    candidate = candidateFromCsl({
      sourceKey: input.sourceKey,
      csl,
      fallback: candidate,
    });
  } else if (pmid) {
    const summary = await resolvePubmed(pmid);
    if (summary) candidate = candidateFromPubmed({ pmid, summary, fallback: candidate });
  }
  return enrichScientSourceCandidate(candidate);
}

function candidateFromExistingRecord(record: ScientSourceRecord): ScientSourceCandidate {
  const pdfAttachments = record.attachments.filter((attachment) => attachment.kind === "pdf");
  const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
  return {
    sourceKey: record.sourceId,
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    issuedRaw: record.issuedRaw,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    abstract: record.abstract,
    ...(record.abstractSections ? { abstractSections: record.abstractSections } : {}),
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
    tags: record.tags,
    externalReferences: record.externalReferences,
    fieldProvenance: record.fieldProvenance,
    pdfAvailable: pdfAttachments.length > 0,
    pdfFileName: materialSelection._tag === "Selected" ? materialSelection.material.fileName : null,
    pdfAttachmentCount: pdfAttachments.length,
  };
}

/**
 * Re-runs the import-time metadata resolvers without staging or changing a
 * project record. The caller owns comparison and explicit user acceptance.
 */
export async function refreshExistingSourceCandidate(input: {
  readonly record: ScientSourceRecord;
  readonly pdfMaterial: ScientSourceAttachment | null;
  readonly pdfPath: string | null;
}): Promise<ScientSourceCandidate> {
  const current = candidateFromExistingRecord(input.record);
  let candidate = input.pdfPath
    ? await extractPdfMetadata({
        sourceKey: input.record.sourceId,
        fileName: input.pdfMaterial?.fileName ?? "source.pdf",
        pdfPath: input.pdfPath,
      })
    : current;
  const extractedIdentifierSchemes = new Set(
    candidate.identifiers.map((value) => value.scheme.toLowerCase()),
  );

  const identifiers = deduplicateIdentifiers([
    ...candidate.identifiers,
    ...input.record.identifiers,
  ]);
  const tags = [...new Set([...candidate.tags, ...input.record.tags])];
  candidate = {
    ...candidate,
    identifiers,
    tags,
    externalReferences: input.record.externalReferences,
  };

  const doi = identifiers.find((value) => value.scheme.toLowerCase() === "doi")?.value ?? null;
  const pmid = identifiers.find((value) => value.scheme.toLowerCase() === "pmid")?.value ?? null;
  if (doi && (!input.pdfPath || !extractedIdentifierSchemes.has("doi"))) {
    const csl = await resolveDoi(doi);
    if (csl) {
      candidate = candidateFromCsl({
        sourceKey: input.record.sourceId,
        csl,
        fallback: candidate,
      });
    } else if (pmid) {
      const summary = await resolvePubmed(pmid);
      if (summary) candidate = candidateFromPubmed({ pmid, summary, fallback: candidate });
    }
  } else if (!doi && pmid && (!input.pdfPath || !extractedIdentifierSchemes.has("pmid"))) {
    const summary = await resolvePubmed(pmid);
    if (summary) candidate = candidateFromPubmed({ pmid, summary, fallback: candidate });
  }
  return enrichScientSourceCandidate(candidate);
}

export async function prepareLocalPdfSource(input: {
  readonly root: string;
  readonly sourcePath: string;
  readonly fileName: string;
}): Promise<ScientSourcePreflightItem> {
  const staged = await stageScientSourcePdfUpload(input);
  try {
    const candidate = await extractPdfMetadata({
      sourceKey: staged.sourceKey,
      fileName: staged.pdfFileName,
      pdfPath: staged.absolutePath,
    });
    await writeScientSourceStagedMaterial(input.root, {
      formatVersion: 1,
      sourceKey: staged.sourceKey,
      candidate,
      pdfFileName: staged.pdfFileName,
      pdfRelativePath: staged.pdfRelativePath,
      pdfSha256: staged.pdfSha256,
      byteLength: staged.byteLength,
      createdAt: new Date().toISOString(),
    });
    const existing = await listScientSourceRecords(input.root);
    return {
      candidate,
      duplicate: assessSourceDuplicate({
        candidate,
        existing,
        pdfSha256: staged.pdfSha256,
      }),
      metadataDiagnostics: sourceMetadataDiagnostics(candidate),
    };
  } catch (error) {
    await removeScientSourceStagedMaterial(input.root, staged.sourceKey).catch(() => undefined);
    throw error;
  }
}

/** Prepares a verified project PDF for a single canonical Source mutation. */
export async function prepareProjectPdfSource(input: {
  readonly sourceKey: string;
  readonly sourcePath: string;
  readonly fileName: string;
}) {
  const expectedPdf = await inspectScientSourcePdf(input.sourcePath);
  return {
    candidate: await extractPdfMetadata({
      sourceKey: input.sourceKey,
      fileName: input.fileName,
      pdfPath: input.sourcePath,
    }),
    expectedPdf,
  };
}

export async function getLocalPdfImportMaterial(root: string, sourceKey: string) {
  const material = await readScientSourceStagedMaterial(root, sourceKey);
  return {
    candidate: material.candidate,
    pdfPath: await stagedScientSourcePdfAbsolutePath(root, material),
    expectedPdf: { sha256: material.pdfSha256, byteLength: material.byteLength },
  };
}

export { removeScientSourceStagedMaterial as discardLocalPdfImportMaterial };

export const localPdfSourceInternals = {
  candidateFromEmbeddedPdf,
  candidateFromCsl,
  candidateFromPubmed,
  candidateFromExistingRecord,
  doiCandidates,
  embeddedCreators,
  normalizeEmbeddedPdfDate,
  selectEmbeddedPdfTitle,
  uniqueDoi,
  uniquePmid,
};
