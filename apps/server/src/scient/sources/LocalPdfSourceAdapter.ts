// @effect-diagnostics nodeBuiltinImport:off -- This adapter reads an environment-local staged PDF.
// @effect-diagnostics globalDate:off -- Staged project metadata uses an interoperable ISO timestamp.
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import {
  assessSourceDuplicate,
  sourceMetadataDiagnostics,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourcePreflightItem,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import {
  listScientSourceRecords,
  readScientSourceStagedMaterial,
  removeScientSourceStagedMaterial,
  stageScientSourcePdfUpload,
  stagedScientSourcePdfAbsolutePath,
  writeScientSourceStagedMaterial,
} from "@scientfactory/scient-sources/store";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const METADATA_TIMEOUT_MS = 5_000;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_LENGTH = 64 * 1024;
const PUBMED_REQUEST_INTERVAL_MS = 350;
let nextPubmedRequestAt = 0;
let pubmedRequestLane: Promise<void> = Promise.resolve();

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
  const datePart = input.csl.issued?.["date-parts"]?.[0];
  const issuedYear = typeof datePart?.[0] === "number" ? datePart[0] : year(input.csl.issued?.raw);
  const issuedRaw =
    text(input.csl.issued?.raw) ?? (issuedYear === null ? null : String(issuedYear));
  const creators = cslCreators(input.csl.author);
  const identifiers = deduplicateIdentifiers([
    ...(text(input.csl.DOI) ? [{ scheme: "doi", value: text(input.csl.DOI)! }] : []),
    ...(text(input.csl.ISBN) ? [{ scheme: "isbn", value: text(input.csl.ISBN)! }] : []),
    ...(typeof input.csl.ISSN !== "string" && input.csl.ISSN
      ? input.csl.ISSN.flatMap((value) => (text(value) ? [{ scheme: "issn", value }] : []))
      : text(input.csl.ISSN)
        ? [{ scheme: "issn", value: text(input.csl.ISSN)! }]
        : []),
    ...input.fallback.identifiers,
  ]);
  const candidate: ScientSourceCandidate = {
    ...input.fallback,
    sourceKey: input.sourceKey,
    type: sourceTypeFromCsl(input.csl.type),
    customType:
      input.csl.type && sourceTypeFromCsl(input.csl.type) === "other" ? input.csl.type : null,
    title: text(input.csl.title) ?? input.fallback.title,
    creators: creators.length > 0 ? creators : input.fallback.creators,
    issuedRaw: issuedRaw ?? input.fallback.issuedRaw,
    issuedYear: issuedYear ?? input.fallback.issuedYear,
    identifiers,
    abstract: text(input.csl.abstract) ?? input.fallback.abstract,
    containerTitle: text(input.csl["container-title"]) ?? input.fallback.containerTitle,
    publisher: text(input.csl.publisher) ?? input.fallback.publisher,
    volume: text(input.csl.volume) ?? input.fallback.volume,
    issue: text(input.csl.issue) ?? input.fallback.issue,
    pages: text(input.csl.page) ?? input.fallback.pages,
    language: text(input.csl.language) ?? input.fallback.language,
    url:
      text(input.csl.URL) ??
      (text(input.csl.DOI) ? `https://doi.org/${text(input.csl.DOI)}` : input.fallback.url),
  };
  return {
    ...candidate,
    fieldProvenance: [
      ...input.fallback.fieldProvenance,
      ...provenance("doi", [
        ["type", "type", text(input.csl.type) !== null],
        ["title", "title", text(input.csl.title) !== null],
        ["creators", "author", creators.length > 0],
        ["issuedRaw", "issued", issuedRaw !== null],
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

function requestJson(
  url: URL,
  headers: Readonly<Record<string, string>>,
  redirects = 0,
): Promise<unknown> {
  if (url.protocol !== "https:") throw new Error("Metadata requests must use HTTPS.");
  if (redirects > 4) throw new Error("The metadata service redirected too many times.");
  return new Promise((resolve, reject) => {
    const request = NodeHttps.get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        void requestJson(new URL(response.headers.location, url), headers, redirects + 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`The metadata service returned HTTP ${status}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > MAX_METADATA_RESPONSE_BYTES) {
          request.destroy(new Error("The metadata service returned too much data."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(METADATA_TIMEOUT_MS, () => {
      request.destroy(new Error("The metadata request timed out."));
    });
    request.on("error", reject);
  });
}

async function resolveDoi(doi: string): Promise<CslMetadata | null> {
  try {
    const encodedDoi = doi.split("/").map(encodeURIComponent).join("/");
    const value = await requestJson(new URL(`https://doi.org/${encodedDoi}`), {
      Accept: "application/vnd.citationstyles.csl+json",
      "User-Agent": "Scient/0.0 (source metadata resolution)",
    });
    return decodeCslMetadata(value);
  } catch {
    return null;
  }
}

async function resolvePubmed(pmid: string): Promise<typeof PubmedSummary.Type | null> {
  try {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = pubmedRequestLane;
    pubmedRequestLane = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    const waitMs = Math.max(0, nextPubmedRequestAt - Date.now());
    if (waitMs > 0) await NodeTimersPromises.setTimeout(waitMs);
    nextPubmedRequestAt = Date.now() + PUBMED_REQUEST_INTERVAL_MS;
    release?.();

    const parameters = new URLSearchParams({
      db: "pubmed",
      id: pmid,
      retmode: "json",
      tool: "scient_desktop",
    });
    const value = await requestJson(
      new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${parameters}`),
      { "User-Agent": "Scient/0.0 (source metadata resolution)" },
    );
    const decoded = decodePubmedResponse(value);
    const summary = decoded.result[pmid];
    return summary === undefined ? null : decodePubmedSummary(summary);
  } catch {
    return null;
  }
}

function uniqueDoi(textValue: string): string | null {
  const values = new Set(
    [...textValue.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu)].map((match) =>
      (match[0] ?? "").replace(/[.,;:)\]}]+$/u, "").toLowerCase(),
    ),
  );
  if (values.size === 1) return [...values][0]!;

  const longestFirst = [...values].toSorted((left, right) => right.length - left.length);
  const longest = longestFirst[0];
  return longest && longestFirst.every((value) => longest === value || longest.startsWith(value))
    ? longest
    : null;
}

function uniquePmid(textValue: string): string | null {
  const values = new Set(
    [...textValue.matchAll(/\bPMID\s*:?\s*(\d{6,9})\b/giu)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    ),
  );
  return values.size === 1 ? [...values][0]! : null;
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
  let subject: string | null = null;
  let keywords: ReadonlyArray<string> = [];
  let issuedRaw: string | null = null;
  let extractedText = "";

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
        const info = decodePdfInfo(metadata.info);
        title = text(metadata.metadata?.get("dc:title")) ?? text(info.Title) ?? fallbackTitle;
        authors = embeddedCreators(metadata.metadata?.get("dc:creator") ?? info.Author);
        subject = text(metadata.metadata?.get("dc:description")) ?? text(info.Subject);
        issuedRaw = text(metadata.metadata?.get("dc:date")) ?? text(info.CreationDate);
        keywords = (text(info.Keywords) ?? "")
          .split(/[,;]/u)
          .map((value) => value.trim())
          .filter(Boolean);
        const pageCount = Math.min(2, document.numPages);
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
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
        }
      } finally {
        await document.cleanup();
      }
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch {
    // A valid PDF can omit or expose unreadable metadata. The file still remains importable.
  }

  const searchable = [title, subject, extractedText].filter(Boolean).join("\n");
  const doi = uniqueDoi(searchable);
  const pmid = uniquePmid(searchable);
  const identifiers: ScientSourceIdentifier[] = [
    ...(doi ? [{ scheme: "doi", value: doi }] : []),
    ...(pmid ? [{ scheme: "pmid", value: pmid }] : []),
  ];
  const fallback: ScientSourceCandidate = {
    sourceKey: input.sourceKey,
    type: "other",
    customType: null,
    title,
    creators: authors,
    issuedRaw,
    issuedYear: year(issuedRaw),
    identifiers,
    abstract: subject,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: doi ? `https://doi.org/${doi}` : pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
    tags: keywords,
    externalReferences: [],
    fieldProvenance: provenance("local-pdf", [
      ["title", "document-info/title", title !== null],
      ["creators", "document-info/author", authors.length > 0],
      ["issuedRaw", "document-info/date", issuedRaw !== null],
      ["abstract", "document-info/subject", subject !== null],
      ["tags", "document-info/keywords", keywords.length > 0],
      ["identifiers", "first-pages", identifiers.length > 0],
    ]),
    pdfAvailable: true,
    pdfFileName: input.fileName,
    pdfAttachmentCount: 1,
  };

  if (doi) {
    const csl = await resolveDoi(doi);
    if (csl)
      return candidateFromCsl({
        sourceKey: input.sourceKey,
        csl,
        fallback,
      });
  }
  if (pmid) {
    const summary = await resolvePubmed(pmid);
    if (summary) return candidateFromPubmed({ pmid, summary, fallback });
  }
  return fallback;
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
  candidateFromCsl,
  candidateFromPubmed,
  embeddedCreators,
  uniqueDoi,
  uniquePmid,
};
