// @effect-diagnostics nodeBuiltinImport:off -- This adapter reads an environment-local staged PDF.
// @effect-diagnostics globalDate:off -- Staged project metadata uses an interoperable ISO timestamp.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  normalizePersistentIdentifier,
  SCIENT_SOURCE_FILE_NAME_TITLE,
  sourceMetadataDiagnostics,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceAttachment,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourcePreflightItem,
  type ScientSourceRecord,
} from "@scientfactory/scient-sources";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import type { ScientSourceStoreLocation } from "@scientfactory/scient-sources/library-root";
import {
  assessScientSourceIntake,
  inspectScientSourcePdf,
  readScientSourceStagedMaterial,
  removeScientSourceStagedMaterial,
  stageScientSourcePdfUpload,
  stagedScientSourcePdfAbsolutePath,
  writeScientSourceStagedMaterial,
} from "@scientfactory/scient-sources/store";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  applyResolvedSourceMetadata,
  resolveSourceIdentifier,
  type ResolveSourceIdentifier,
} from "./SourceIdentifierResolver.ts";
import { enrichScientSourceCandidate } from "./SourceMetadataEnricher.ts";

const MAX_EXTRACTED_TEXT_LENGTH = 64 * 1024;

const PdfInfo = Schema.Struct({
  Title: Schema.optionalKey(Schema.Unknown),
  Author: Schema.optionalKey(Schema.Unknown),
  Subject: Schema.optionalKey(Schema.Unknown),
  Keywords: Schema.optionalKey(Schema.Unknown),
});

const decodePdfInfo = Schema.decodeUnknownSync(PdfInfo);

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

// pdf.js lowercases XMP element names. Creation, modification and Dublin Core dates describe the
// file, not the publication, so only PRISM's publisher-set dates count.
const XMP_PUBLICATION_DATE_KEYS = ["prism:coverdate", "prism:publicationdate"] as const;

function embeddedPublicationDate(xmp: { get(name: string): unknown } | null): string | null {
  for (const key of XMP_PUBLICATION_DATE_KEYS) {
    const date = normalizeEmbeddedPdfDate(xmp?.get(key));
    if (date) return /^(\d{4}(?:-\d{2}){0,2})T/u.exec(date)?.[1] ?? date;
  }
  return null;
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

/**
 * The deposit a PDF arXiv served names in the stamp it prints up its first page's margin:
 * `arXiv:1706.03762v7 [cs.CL] 2 Aug 2023` (`arXiv:hep-th/9901001v1 6 Jan 1999` for an old ID),
 * with its version. `margin` is page 1's vertical text only: a stamp quoted in a page's body is
 * horizontal, and an ID cited has no category or date beside it. Two different stamps name none.
 */
function arxivStamp(margin: string): string | null {
  const ids = new Set(
    [
      ...margin.matchAll(
        /\barXiv:\s?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)\s+(?:\[[a-z-]+(?:\.[A-Za-z-]+)?\]|\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/gu,
      ),
    ].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Text drawn turned a quarter (its matrix maps the line's direction onto the page's height). */
const isVertical = (transform: unknown) =>
  Array.isArray(transform) && Math.abs(Number(transform[1])) > Math.abs(Number(transform[0]));

function candidateFromEmbeddedPdf(input: {
  readonly sourceKey: string;
  readonly fileName: string;
  readonly title: string | null;
  /** The PDF names no title, so `title` is its file name until its details are found. */
  readonly titleFromFileName?: boolean;
  readonly authors: ReadonlyArray<ScientSourceCreator>;
  readonly issuedRaw: string | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly keywords: ReadonlyArray<string>;
}): ScientSourceCandidate {
  const doi = input.identifiers.find((identifier) => identifier.scheme === "doi")?.value ?? null;
  const pmid = input.identifiers.find((identifier) => identifier.scheme === "pmid")?.value ?? null;
  const arxiv =
    input.identifiers.find((identifier) => identifier.scheme === "arxiv")?.value ?? null;
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
    url: doi
      ? `https://doi.org/${doi}`
      : pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
        : arxiv
          ? `https://arxiv.org/abs/${arxiv}`
          : null,
    tags: input.keywords,
    externalReferences: [],
    fieldProvenance: provenance("local-pdf", [
      [
        "title",
        input.titleFromFileName ? SCIENT_SOURCE_FILE_NAME_TITLE : "document-info/title",
        input.title !== null,
      ],
      ["creators", "document-info/author", input.authors.length > 0],
      ["issuedRaw", "xmp/prism-date", input.issuedRaw !== null],
      ["tags", "document-info/keywords", input.keywords.length > 0],
      ["identifiers", "first-pages", input.identifiers.length > 0],
    ]),
    pdfAvailable: true,
    pdfFileName: input.fileName,
    pdfAttachmentCount: 1,
  };
}

/** What a PDF says of itself, and the identifiers it names to look the work up by. No network. */
async function readPdfEvidence(input: {
  readonly sourceKey: string;
  readonly fileName: string;
  readonly pdfPath: string;
}): Promise<{
  readonly candidate: ScientSourceCandidate;
  readonly lookups: ReadonlyArray<ScientSourceIdentifier>;
}> {
  const fallbackTitle = text(
    NodePath.basename(input.fileName, NodePath.extname(input.fileName)).replace(/[_-]+/gu, " "),
  );
  let title: string | null = fallbackTitle;
  let authors: ReadonlyArray<ScientSourceCreator> = [];
  let documentDescription: string | null = null;
  let keywords: ReadonlyArray<string> = [];
  let issuedRaw: string | null = null;
  let extractedText = "";
  let firstPageMargin = "";
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
        issuedRaw = embeddedPublicationDate(metadata.metadata);
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
              if (pageNumber === 1) {
                firstPageMargin = content.items
                  .flatMap((item) =>
                    Predicate.hasProperty(item, "str") &&
                    Predicate.isString(item.str) &&
                    Predicate.hasProperty(item, "transform") &&
                    isVertical(item.transform)
                      ? [item.str]
                      : [],
                  )
                  .join(" ");
              }
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
  const arxiv = arxivStamp(firstPageMargin);
  // A PDF from arXiv is that deposit: a DOI in its text is a published version's or a citation's.
  const doi = arxiv ? null : uniqueDoi(searchable);
  const pmid = arxiv ? null : uniquePmid(searchable);
  const identifiers: ScientSourceIdentifier[] = [
    ...(arxiv ? [{ scheme: "arxiv", value: arxiv }] : []),
    ...(doi ? [{ scheme: "doi", value: doi }] : []),
    ...(pmid ? [{ scheme: "pmid", value: pmid }] : []),
  ];
  const fallback = candidateFromEmbeddedPdf({
    sourceKey: input.sourceKey,
    fileName: input.fileName,
    title,
    titleFromFileName: title !== null && title === fallbackTitle,
    authors,
    issuedRaw,
    identifiers,
    keywords,
  });

  return {
    candidate: {
      ...fallback,
      fieldProvenance: [
        ...fallback.fieldProvenance,
        ...(pdfParsingFailed
          ? [{ field: "metadata", origin: "local-pdf" as const, sourceField: "pdf-parser" }]
          : []),
      ],
    },
    // A DOI read from text may carry what follows it; its shorter spelling is tried too.
    lookups: [
      ...(arxiv ? [{ scheme: "arxiv", value: arxiv }] : []),
      ...(doi ? doiCandidates(doi).map((value) => ({ scheme: "doi", value })) : []),
      ...(pmid ? [{ scheme: "pmid", value: pmid }] : []),
    ],
  };
}

const lookUp: ResolveSourceIdentifier = (identifiers) => resolveSourceIdentifier(identifiers);

/**
 * The work's own record from its registry, by the first of these identifiers a registry has,
 * through the resolver every intake uses. The candidate as it is when none is found.
 */
async function withRegistryRecord(
  candidate: ScientSourceCandidate,
  lookups: ReadonlyArray<ScientSourceIdentifier>,
  resolve: ResolveSourceIdentifier,
): Promise<ScientSourceCandidate> {
  for (const identifier of lookups) {
    const resolution = await resolve([identifier]);
    if (resolution?.status !== "found") continue;
    // A DOI read from text is taken only when the registry answers for that very DOI.
    const asked = normalizePersistentIdentifier(identifier.scheme, identifier.value);
    if (
      identifier.scheme === "doi" &&
      !resolution.metadata.identifiers.some(
        (entry) => normalizePersistentIdentifier(entry.scheme, entry.value) === asked,
      )
    ) {
      continue;
    }
    // The registry's DOI stands for the spelling the text gave.
    const rest =
      identifier.scheme === "doi"
        ? candidate.identifiers.filter((entry) => entry.scheme.toLowerCase() !== "doi")
        : candidate.identifiers;
    return applyResolvedSourceMetadata({ ...candidate, identifiers: rest }, resolution);
  }
  return candidate;
}

async function extractPdfMetadata(
  input: {
    readonly sourceKey: string;
    readonly fileName: string;
    readonly pdfPath: string;
  },
  resolve: ResolveSourceIdentifier = lookUp,
): Promise<ScientSourceCandidate> {
  const { candidate, lookups } = await readPdfEvidence(input);
  return enrichScientSourceCandidate(await withRegistryRecord(candidate, lookups, resolve));
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
export async function refreshExistingSourceCandidate(
  input: {
    readonly record: ScientSourceRecord;
    readonly pdfMaterial: ScientSourceAttachment | null;
    readonly pdfPath: string | null;
  },
  resolve: ResolveSourceIdentifier = lookUp,
): Promise<ScientSourceCandidate> {
  const read = input.pdfPath
    ? await readPdfEvidence({
        sourceKey: input.record.sourceId,
        fileName: input.pdfMaterial?.fileName ?? "source.pdf",
        pdfPath: input.pdfPath,
      })
    : { candidate: candidateFromExistingRecord(input.record), lookups: [] };
  const candidate: ScientSourceCandidate = {
    ...read.candidate,
    identifiers: deduplicateIdentifiers([
      ...read.candidate.identifiers,
      ...input.record.identifiers,
    ]),
    tags: [...new Set([...read.candidate.tags, ...input.record.tags])],
    externalReferences: input.record.externalReferences,
  };
  // What the PDF names first; then the record's own DOI, PMID and arXiv ID.
  const recorded = ["doi", "pmid", "arxiv"].flatMap((scheme) =>
    input.record.identifiers.filter((identifier) => identifier.scheme.toLowerCase() === scheme),
  );
  return enrichScientSourceCandidate(
    await withRegistryRecord(candidate, [...read.lookups, ...recorded], resolve),
  );
}

export async function prepareLocalPdfSource(input: {
  readonly root: ScientSourceStoreLocation;
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
    // Judged as the final import judges it, with the Library's current decisions.
    return {
      candidate,
      duplicate: await assessScientSourceIntake({
        root: input.root,
        candidate,
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

export async function getLocalPdfImportMaterial(
  root: ScientSourceStoreLocation,
  sourceKey: string,
) {
  const material = await readScientSourceStagedMaterial(root, sourceKey);
  return {
    candidate: material.candidate,
    pdfPath: await stagedScientSourcePdfAbsolutePath(root, material),
    expectedPdf: { sha256: material.pdfSha256, byteLength: material.byteLength },
  };
}

export { removeScientSourceStagedMaterial as discardLocalPdfImportMaterial };

export const localPdfSourceInternals = {
  arxivStamp,
  candidateFromEmbeddedPdf,
  candidateFromExistingRecord,
  doiCandidates,
  embeddedCreators,
  embeddedPublicationDate,
  extractPdfMetadata,
  normalizeEmbeddedPdfDate,
  selectEmbeddedPdfTitle,
  uniqueDoi,
  uniquePmid,
};
