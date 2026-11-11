// @effect-diagnostics nodeBuiltinImport:off -- This owned Promise-based Sources module reads project PDFs through the store boundary.
// @effect-diagnostics globalDate:off -- Stored text carries an interoperable ISO extraction time.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  fullTextHasText,
  fullTextPassage,
  locateFullTextQuote,
  parseFullTextQuery,
  searchFullText,
  SCIENT_SOURCE_FULL_TEXT_LIMITS,
  SCIENT_SOURCE_FULL_TEXT_PROFILE,
  type FullTextRange,
  type ScientSourceExtractedFullText,
  type ScientSourceFullText,
  type ScientSourceFullTextPage,
} from "@scientfactory/scient-sources/full-text";
import {
  listScientSourceFullTextHashes,
  readScientSourceFullText,
  removeScientSourceFullText,
  scientSourceFullTextByteLength,
  writeScientSourceFullText,
} from "@scientfactory/scient-sources/full-text-store";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import {
  canonicalizeScientSourceRoot,
  listScientSourceRecords,
  readScientSourceAttachmentPdf,
  readScientSourcePdfBytes,
  readScientSourceRecord,
  SCIENT_SOURCE_FILES_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import type { ScientSourceAttachment, ScientSourceRecord } from "@scientfactory/scient-sources";
import * as Predicate from "effect/Predicate";

import { makeSourceFullTextCache } from "./SourceFullTextCache.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_FAILURE_BYTES = 4_096;
const MAX_PDF_BYTES = 512 * 1024 * 1024;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfJs: Promise<PdfJs> | null = null;
const loadPdfJs = () => (pdfJs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

async function sourceFullTextExtractorVersion(): Promise<string> {
  return (await loadPdfJs()).version;
}

/** Same profile as the reader's text layer: raw item strings, a newline after `hasEOL` items. */
function pageText(items: ReadonlyArray<unknown>): string {
  return items
    .map((item) =>
      Predicate.hasProperty(item, "str") && Predicate.isString(item.str)
        ? item.str + (Predicate.hasProperty(item, "hasEOL") && item.hasEOL === true ? "\n" : "")
        : "",
    )
    .join("");
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface PdfMaterialIdentity {
  readonly sha256: string;
  readonly byteLength: number;
}

async function failedText(
  material: PdfMaterialIdentity,
  reason: "unreadable" | "too-large",
): Promise<ScientSourceFullText> {
  return {
    formatVersion: 1,
    outcome: "failed",
    sha256: material.sha256,
    byteLength: material.byteLength,
    extractor: { name: "pdfjs", version: await sourceFullTextExtractorVersion() },
    failedAt: new Date().toISOString(),
    reason,
  };
}

/**
 * Reads the text of every page of PDF bytes already checked against their
 * hash. A page that cannot be read is kept empty and marks the result
 * incomplete, so one damaged page does not hide the rest.
 */
export async function extractSourcePdfFullText(
  input: PdfMaterialIdentity & { readonly data: Uint8Array },
): Promise<ScientSourceFullText> {
  const { getDocument, version } = await loadPdfJs();
  const extractor = { name: "pdfjs" as const, version };
  if (input.byteLength > MAX_PDF_BYTES) return failedText(input, "too-large");
  const task = getDocument({
    data: input.data,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    try {
      const pages: ScientSourceFullTextPage[] = [];
      let complete = document.numPages <= SCIENT_SOURCE_FULL_TEXT_LIMITS.pages;
      let characters = 0;
      const pageCount = Math.min(document.numPages, SCIENT_SOURCE_FULL_TEXT_LIMITS.pages);
      for (let number = 1; number <= pageCount; number += 1) {
        await yieldToEventLoop();
        try {
          const page = await document.getPage(number);
          try {
            const content = await page.getTextContent({
              includeMarkedContent: true,
              disableNormalization: true,
            });
            let text = pageText(content.items);
            if (characters + text.length > SCIENT_SOURCE_FULL_TEXT_LIMITS.characters) {
              text = "";
              complete = false;
            }
            characters += text.length;
            const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
            pages.push({
              page: number,
              text,
              viewBox: [x1, y1, x2, y2],
              rotation: page.rotate,
              userUnit: page.userUnit,
            });
          } finally {
            page.cleanup();
          }
        } catch {
          complete = false;
          pages.push({ page: number, text: "", viewBox: [0, 0, 0, 0], rotation: 0, userUnit: 1 });
        }
      }
      return {
        formatVersion: 1,
        outcome: "extracted",
        sha256: input.sha256,
        byteLength: input.byteLength,
        profile: SCIENT_SOURCE_FULL_TEXT_PROFILE,
        extractor,
        extractedAt: new Date().toISOString(),
        pageCount: document.numPages,
        complete,
        pages,
      };
    } finally {
      await document.cleanup();
    }
  } catch {
    return failedText(input, "unreadable");
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** Extracts a PDF file's text after reading its bytes once and checking them against the expected hash. */
export async function extractSourcePdfFileFullText(
  input: PdfMaterialIdentity & { readonly pdfPath: string },
): Promise<ScientSourceFullText> {
  if (input.byteLength > MAX_PDF_BYTES) return failedText(input, "too-large");
  const data = await readScientSourcePdfBytes(input.pdfPath, input).catch(() => null);
  return data ? extractSourcePdfFullText({ ...input, data }) : failedText(input, "unreadable");
}

async function extractMaterialText(
  root: string,
  material: LibraryMaterial,
): Promise<ScientSourceFullText> {
  if (material.byteLength > MAX_PDF_BYTES) return failedText(material, "too-large");
  const data = await readScientSourceAttachmentPdf(root, material.attachment).catch(() => null);
  return data
    ? extractSourcePdfFullText({ ...material, data })
    : failedText(material, "unreadable");
}

interface LibraryMaterial {
  readonly sha256: string;
  readonly byteLength: number;
  readonly attachment: ScientSourceAttachment;
  readonly sources: ReadonlyArray<{
    readonly record: ScientSourceRecord;
    readonly attachmentId: string;
  }>;
}

function pdfAttachments(record: ScientSourceRecord): ReadonlyArray<ScientSourceAttachment> {
  return record.attachments.filter(
    (attachment) =>
      attachment.kind === "pdf" &&
      attachment.mediaType === "application/pdf" &&
      SHA256_PATTERN.test(attachment.sha256),
  );
}

function libraryMaterials(
  records: ReadonlyArray<ScientSourceRecord>,
): Map<string, LibraryMaterial> {
  const materials = new Map<string, LibraryMaterial>();
  for (const record of records) {
    for (const attachment of pdfAttachments(record)) {
      const existing = materials.get(attachment.sha256);
      const source = { record, attachmentId: attachment.attachmentId };
      materials.set(attachment.sha256, {
        sha256: attachment.sha256,
        byteLength: attachment.byteLength,
        attachment: existing?.attachment ?? attachment,
        sources: [...(existing?.sources ?? []), source],
      });
    }
  }
  return materials;
}

// One PDF is parsed at a time across all projects: extraction is CPU-bound and
// shares the server's event loop with interactive requests.
let extractionLane: Promise<unknown> = Promise.resolve();
const extractionsInFlight = new Map<string, Promise<ScientSourceFullText>>();

function inLane<A>(run: () => Promise<A>): Promise<A> {
  const next = extractionLane.catch(() => undefined).then(run);
  extractionLane = next.catch(() => undefined);
  return next;
}

// Stored text never changes for a hash, so extracted text and its folded pages
// are cached by hash across projects.
const textCache = makeSourceFullTextCache();
const cacheText = (text: ScientSourceExtractedFullText) => textCache.add(text);

const searchDocumentFor = (text: ScientSourceExtractedFullText) => cacheText(text).document;

async function readStoredText(root: string, sha256: string): Promise<ScientSourceFullText | null> {
  const cached = textCache.get(sha256);
  if (cached) return cached.text;
  const text = await readScientSourceFullText(root, sha256);
  if (text?.outcome === "extracted") cacheText(text);
  return text;
}

async function needsExtraction(text: ScientSourceFullText | null): Promise<boolean> {
  if (text === null) return true;
  // A failure is retried once the extractor changes; extracted text stays valid.
  return (
    text.outcome === "failed" && text.extractor.version !== (await sourceFullTextExtractorVersion())
  );
}

/** The stored text for one material, extracting it first when it is missing. */
async function ensureMaterialText(
  root: string,
  material: LibraryMaterial,
): Promise<ScientSourceFullText> {
  const key = `${root}\0${material.sha256}`;
  const inFlight = extractionsInFlight.get(key);
  if (inFlight) return inFlight;
  const run = (async () => {
    const stored = await readStoredText(root, material.sha256);
    if (stored && !(await needsExtraction(stored))) return stored;
    return inLane(async () => {
      const again = await readStoredText(root, material.sha256);
      if (again && !(await needsExtraction(again))) return again;
      const text = await extractMaterialText(root, material);
      await writeScientSourceFullText(root, text);
      if (text.outcome === "extracted") cacheText(text);
      return text;
    });
  })();
  extractionsInFlight.set(key, run);
  try {
    return await run;
  } finally {
    extractionsInFlight.delete(key);
  }
}

async function pdfFileExists(root: string, sha256: string): Promise<boolean> {
  try {
    const stats = await NodeFSP.lstat(
      NodePath.join(root, SCIENT_SOURCE_FILES_DIRECTORY, sha256.slice(0, 2), `${sha256}.pdf`),
    );
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Extracts every library PDF that has no stored text, then drops text whose PDF is gone. */
export async function indexSourceFullText(root: string): Promise<void> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const materials = libraryMaterials(await listScientSourceRecords(resolvedRoot));
  for (const material of materials.values()) {
    // Only a missing file or a small one (a recorded failure) can need work, so a
    // pass over an indexed library reads no text.
    const stored = textCache.has(material.sha256)
      ? MAX_FAILURE_BYTES + 1
      : await scientSourceFullTextByteLength(resolvedRoot, material.sha256).catch(() => null);
    if (stored !== null && stored > MAX_FAILURE_BYTES) continue;
    await ensureMaterialText(resolvedRoot, material).catch(() => undefined);
  }
  for (const sha256 of await listScientSourceFullTextHashes(resolvedRoot)) {
    if (!materials.has(sha256) && !(await pdfFileExists(resolvedRoot, sha256))) {
      await removeScientSourceFullText(resolvedRoot, sha256).catch(() => undefined);
    }
  }
}

const indexingPasses = new Map<string, Promise<void>>();
const passRequested = new Set<string>();

/** Starts a background indexing pass, or queues one more after the running pass. */
export function scheduleSourceFullTextIndexing(root: string): Promise<void> {
  const running = indexingPasses.get(root);
  if (running) {
    passRequested.add(root);
    return running;
  }
  const pass = (async () => {
    do {
      passRequested.delete(root);
      await indexSourceFullText(root).catch(() => undefined);
    } while (passRequested.has(root));
  })().finally(() => indexingPasses.delete(root));
  indexingPasses.set(root, pass);
  return pass;
}

export interface SourceFullTextStatus {
  /** Distinct PDFs in the library. */
  readonly pdfs: number;
  readonly searchable: number;
  /** Not read yet; a background pass is running. */
  readonly pending: number;
  /** Read, but no text layer (often a scan). */
  readonly withoutText: number;
  readonly unreadable: number;
}

async function storedTexts(root: string, materials: Map<string, LibraryMaterial>) {
  const texts = new Map<string, ScientSourceFullText | null>();
  for (const sha256 of materials.keys()) {
    texts.set(sha256, await readStoredText(root, sha256));
  }
  const values = [...texts.values()];
  const status: SourceFullTextStatus = {
    pdfs: materials.size,
    searchable: values.filter((text) => text?.outcome === "extracted" && fullTextHasText(text))
      .length,
    pending: values.filter((text) => text === null).length,
    withoutText: values.filter((text) => text?.outcome === "extracted" && !fullTextHasText(text))
      .length,
    unreadable: values.filter((text) => text?.outcome === "failed").length,
  };
  return { texts, status };
}

export async function getSourceFullTextStatus(root: string): Promise<SourceFullTextStatus> {
  const resolvedRoot = await canonicalizeScientSourceRoot(root);
  const materials = libraryMaterials(await listScientSourceRecords(resolvedRoot));
  const { status } = await storedTexts(resolvedRoot, materials);
  if (status.pending > 0) void scheduleSourceFullTextIndexing(resolvedRoot);
  return status;
}

export interface SourceFullTextSearchHit {
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly fileName: string;
  readonly title: string | null;
  readonly page: number;
  /** Offsets of the match in the page's stored text. */
  readonly start: number;
  readonly end: number;
  readonly passage: string;
  readonly matchedTerms: ReadonlyArray<string>;
  /** The match as a reader text selector, so a reader can find and show it. */
  readonly selector: {
    readonly extractorVersion: string;
    readonly viewBox: readonly [number, number, number, number];
    readonly rotation: number;
    readonly userUnit: number;
    readonly pageTextHash: string;
    readonly quote: string;
    readonly prefix: string;
    readonly suffix: string;
  };
}

const textHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

export async function searchSourceFullText(input: {
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly sourceIds?: ReadonlyArray<string>;
}): Promise<{
  readonly hits: ReadonlyArray<SourceFullTextSearchHit>;
  readonly status: SourceFullTextStatus;
}> {
  const root = await canonicalizeScientSourceRoot(input.root);
  const records = await listScientSourceRecords(root);
  const wanted = input.sourceIds ? new Set(input.sourceIds) : null;
  const scoped = wanted ? records.filter((record) => wanted.has(record.sourceId)) : records;
  const materials = libraryMaterials(scoped);
  const { texts, status } = await storedTexts(root, materials);
  if (status.pending > 0) void scheduleSourceFullTextIndexing(root);
  const extracted = [...texts.values()].filter(
    (text): text is ScientSourceExtractedFullText => text?.outcome === "extracted",
  );
  const hits = searchFullText(extracted.map(searchDocumentFor), parseFullTextQuery(input.query), {
    limit: input.limit,
    perDocument: 3,
  });
  return {
    status,
    hits: hits.flatMap((hit) => {
      const material = materials.get(hit.key);
      const text = texts.get(hit.key);
      const page =
        text?.outcome === "extracted"
          ? text.pages.find((entry) => entry.page === hit.page)
          : undefined;
      const source = material?.sources[0];
      if (!material || !page || text?.outcome !== "extracted" || !source) return [];
      const passage = fullTextPassage(page.text, hit);
      const { context } = SCIENT_SOURCE_FULL_TEXT_LIMITS;
      return [
        {
          sourceId: source.record.sourceId,
          attachmentId: source.attachmentId,
          fileName: material.attachment.fileName,
          title: source.record.title,
          page: hit.page,
          start: passage.start,
          end: passage.end,
          passage: passage.passage,
          matchedTerms: hit.matchedTerms,
          selector: {
            extractorVersion: text.extractor.version,
            viewBox: page.viewBox,
            rotation: page.rotation,
            userUnit: page.userUnit,
            pageTextHash: textHash(page.text),
            quote: page.text.slice(passage.start, passage.end),
            prefix: page.text.slice(Math.max(0, passage.start - context), passage.start),
            suffix: page.text.slice(passage.end, passage.end + context),
          },
        },
      ];
    }),
  };
}

export type SourceTextReadResult =
  | {
      readonly outcome: "read";
      readonly attachmentId: string;
      readonly pageCount: number;
      readonly complete: boolean;
      readonly pages: ReadonlyArray<{ readonly page: number; readonly text: string }>;
      readonly nextPage: number | null;
    }
  | { readonly outcome: "no-text" | "unreadable"; readonly attachmentId: string }
  | { readonly outcome: "no-pdf" | "source-not-found" }
  | {
      readonly outcome: "choose-pdf";
      readonly attachments: ReadonlyArray<{
        readonly attachmentId: string;
        readonly fileName: string;
      }>;
    };

/** Pages of one source PDF's text, extracting it now if the background pass has not reached it. */
export async function readSourceText(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId?: string;
  readonly fromPage: number;
  readonly maxCharacters: number;
}): Promise<SourceTextReadResult> {
  const root = await canonicalizeScientSourceRoot(input.root);
  const record = await readScientSourceRecord(root, input.sourceId);
  if (!record) return { outcome: "source-not-found" };
  const attachments = pdfAttachments(record);
  const selection = selectScientSourceMaterial({
    materials: attachments,
    ...(input.attachmentId ? { requestedAttachmentId: input.attachmentId } : {}),
  });
  if (selection._tag === "SeveralMaterials") {
    return {
      outcome: "choose-pdf",
      attachments: selection.materials.map(({ attachmentId, fileName }) => ({
        attachmentId,
        fileName,
      })),
    };
  }
  if (selection._tag !== "Selected") return { outcome: "no-pdf" };
  const attachment = selection.material;
  const material = libraryMaterials([record]).get(attachment.sha256)!;
  const text = await ensureMaterialText(root, material);
  if (text.outcome === "failed")
    return { outcome: "unreadable", attachmentId: attachment.attachmentId };
  if (!fullTextHasText(text)) return { outcome: "no-text", attachmentId: attachment.attachmentId };
  const pages: { page: number; text: string }[] = [];
  let characters = 0;
  let nextPage: number | null = null;
  for (const page of text.pages) {
    if (page.page < input.fromPage) continue;
    if (pages.length > 0 && characters + page.text.length > input.maxCharacters) {
      nextPage = page.page;
      break;
    }
    // A page is never cut: one longer than the budget comes back whole, alone.
    pages.push({ page: page.page, text: page.text });
    characters += page.text.length;
  }
  return {
    outcome: "read",
    attachmentId: attachment.attachmentId,
    pageCount: text.pageCount,
    complete: text.complete,
    pages,
    nextPage,
  };
}

export type SourceQuoteCheck =
  | {
      readonly outcome: "exact" | "normalized";
      readonly sourceId: string;
      readonly attachmentId: string;
      readonly ranges: ReadonlyArray<FullTextRange>;
      readonly text: string;
      readonly prefix: string;
      readonly suffix: string;
    }
  | { readonly outcome: "ambiguous"; readonly sourceIds: ReadonlyArray<string> }
  | {
      readonly outcome: "not-found";
      readonly closest: ReadonlyArray<{
        readonly sourceId: string;
        readonly page: number;
        readonly passage: string;
      }>;
    }
  | { readonly outcome: "not-indexed"; readonly pending: number }
  | { readonly outcome: "no-text" | "source-not-found" };

/**
 * Checks quotes against stored text. With a source, its PDFs are read now if
 * needed; without one, the whole library is searched and a quote found in
 * several sources is ambiguous.
 */
export async function checkSourceQuotes(input: {
  readonly root: string;
  readonly quotes: ReadonlyArray<{ readonly quote: string; readonly sourceId?: string }>;
}): Promise<ReadonlyArray<SourceQuoteCheck>> {
  const root = await canonicalizeScientSourceRoot(input.root);
  const records = await listScientSourceRecords(root);
  const results: SourceQuoteCheck[] = [];
  for (const { quote, sourceId } of input.quotes) {
    const scoped =
      sourceId === undefined ? records : records.filter((record) => record.sourceId === sourceId);
    if (sourceId !== undefined && scoped.length === 0) {
      results.push({ outcome: "source-not-found" });
      continue;
    }
    const materials = libraryMaterials(scoped);
    const texts = new Map<string, ScientSourceFullText | null>();
    for (const material of materials.values()) {
      texts.set(
        material.sha256,
        sourceId === undefined
          ? await readStoredText(root, material.sha256)
          : await ensureMaterialText(root, material).catch(() => null),
      );
    }
    const extracted = [...texts.values()].filter(
      (text): text is ScientSourceExtractedFullText =>
        text?.outcome === "extracted" && fullTextHasText(text),
    );
    const located = extracted.flatMap((text) => {
      const location = locateFullTextQuote(text.pages, quote);
      return location._tag === "NotFound" ? [] : [{ text, location }];
    });
    const sourcesOf = (sha256: string) => materials.get(sha256)?.sources ?? [];
    const only = located.length === 1 ? located[0]! : null;
    if (only && only.location._tag === "Found") {
      const source = sourcesOf(only.text.sha256)[0]!;
      results.push({
        outcome: only.location.match,
        sourceId: source.record.sourceId,
        attachmentId: source.attachmentId,
        ranges: only.location.ranges,
        text: only.location.text,
        prefix: only.location.prefix,
        suffix: only.location.suffix,
      });
      continue;
    }
    if (located.length > 0) {
      results.push({
        outcome: "ambiguous",
        sourceIds: [
          ...new Set(
            located.flatMap(({ text }) =>
              sourcesOf(text.sha256).map((source) => source.record.sourceId),
            ),
          ),
        ],
      });
      continue;
    }
    const pending = [...texts.values()].filter((text) => text === null).length;
    if (pending > 0 && sourceId === undefined) {
      void scheduleSourceFullTextIndexing(root);
      results.push({ outcome: "not-indexed", pending });
      continue;
    }
    if (extracted.length === 0) {
      results.push({ outcome: "no-text" });
      continue;
    }
    const closest = searchFullText(extracted.map(searchDocumentFor), parseFullTextQuery(quote), {
      limit: 2,
      perDocument: 1,
    }).flatMap((hit) => {
      const text = extracted.find((entry) => entry.sha256 === hit.key);
      const page = text?.pages.find((entry) => entry.page === hit.page);
      const source = sourcesOf(hit.key)[0];
      return page && source
        ? [
            {
              sourceId: source.record.sourceId,
              page: hit.page,
              passage: fullTextPassage(page.text, hit).passage,
            },
          ]
        : [];
    });
    results.push({ outcome: "not-found", closest });
  }
  return results;
}
