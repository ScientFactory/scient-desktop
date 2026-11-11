// @effect-diagnostics nodeBuiltinImport:off -- Annotation material identity is the sha256 of a project PDF read through the Sources PDF boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PdfMaterial } from "@scientfactory/document-artifacts";
import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import type {
  ScientLibraryLocation,
  ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import { listScientProjectPinnedWorks } from "@scientfactory/scient-sources/project-pins";
import {
  SCIENT_SOURCES_DIRECTORY,
  inspectScientSourcePdf,
  listScientSourceRecords,
  readScientSourceRecord,
  resolveScientSourceInputPdf,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";
import { readScientSourceFullText } from "@scientfactory/scient-sources/full-text-store";
import {
  liveScientAnnotations,
  scientAnnotationQuote,
  type ScientAnnotationActor,
  type ScientAnnotationCommand,
  type ScientAnnotationMutationRequest,
  type ScientAnnotationMutationResult,
  type ScientAnnotationsDocumentResult,
  type ScientAnnotationsSourceResult,
  type ScientPdfAnnotation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  annotationHistory,
  annotationProjectRoot,
  listScientAnnotationFiles,
  mutateScientAnnotations,
  readScientAnnotationFile,
  type AnnotationHistoryEntry,
  type ScientAnnotationFile,
  type ScientAnnotationHome,
} from "./annotationStore.ts";
import { resolveLibrarySourceId } from "../sources/LibraryProjectSources.ts";
import { extractSourcePdfFileFullText } from "../sources/SourceFullText.ts";
import {
  canonicalScientSourceLocation,
  resolveScientLibraryStoreAt,
  scientSourceStorePdfPath,
  type ScientSourcesAccess,
  type ScientSourcesLibraryStore,
} from "../sources/SourcesBackend.ts";
import { anchorPdfQuote, type PdfPageText } from "./pdfQuoteAnchor.ts";

export class ScientAnnotationsError extends Schema.TaggedError<ScientAnnotationsError>()(
  "ScientAnnotationsError",
  {
    reason: Schema.Literals(["project-unavailable", "pdf-unavailable", "operation-failed"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "project-unavailable":
        return "This folder is not a Scient project.";
      case "pdf-unavailable":
        return "The PDF could not be read.";
      case "operation-failed":
        return "The annotation operation could not be completed.";
    }
  }
}

const attempt = <A>(reason: ScientAnnotationsError["reason"], run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ScientAnnotationsError({ reason, cause }) });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Where a project's annotations live. `library` is set only in library mode on a moved project
 * whose library exists: highlights on a library PDF are kept there, all others in the project.
 */
interface AnnotationScope {
  readonly canonicalRoot: string;
  readonly library: {
    readonly store: ScientSourcesLibraryStore;
    readonly home: ScientLibraryLocation;
  } | null;
}

/** A read resolves without creating the library or starting the move; a write may move first. */
const annotationScope = Effect.fn("ScientAnnotations.scope")(function* (
  root: string,
  access: ScientSourcesAccess,
) {
  const canonicalRoot = yield* attempt("operation-failed", () => annotationProjectRoot(root));
  const store = yield* resolveScientLibraryStoreAt(canonicalRoot, access).pipe(
    Effect.mapError((cause) => new ScientAnnotationsError({ reason: "operation-failed", cause })),
  );
  if (!store?.exists) return { canonicalRoot, library: null } satisfies AnnotationScope;
  const home = yield* attempt("operation-failed", () =>
    canonicalScientSourceLocation(store.library),
  );
  return { canonicalRoot, library: { store, home } } satisfies AnnotationScope;
});

/** A library PDF is one whose bytes the library keeps; the hash alone decides, never a path. */
async function isLibraryPdf(home: ScientLibraryLocation, sha256: string): Promise<boolean> {
  return NodeFSP.lstat(scientSourceStorePdfPath(home, sha256)).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

async function annotationHome(
  scope: AnnotationScope,
  sha256: string,
): Promise<ScientAnnotationHome> {
  return scope.library && (await isLibraryPdf(scope.library.home, sha256))
    ? scope.library.home
    : scope.canonicalRoot;
}

/** Library records this project pins, under its project keys; snapshots have no PDFs. */
async function pinnedLibraryRecords(
  scope: AnnotationScope,
): Promise<ReadonlyArray<ScientSourceRecord>> {
  if (!scope.library) return [];
  const works = await listScientProjectPinnedWorks({
    projectRoot: scope.canonicalRoot,
    library: scope.library.home,
  });
  return works.flatMap((work) => (work.from === "library" ? [work.record] : []));
}

/** The records that name PDFs here: the project's own, or its pinned library records. */
async function scopeRecords(scope: AnnotationScope): Promise<ReadonlyArray<ScientSourceRecord>> {
  return scope.library
    ? pinnedLibraryRecords(scope).catch(() => [])
    : listScientSourceRecords(scope.canonicalRoot).catch(() => []);
}

/**
 * This project's annotation files: the project folder's, then the library's for the PDFs its
 * pins hold. A project file for a library PDF (left while the move cleans up) yields to the library's.
 */
async function scopeAnnotationFiles(scope: AnnotationScope) {
  const project = await listScientAnnotationFiles(scope.canonicalRoot);
  if (!scope.library) return project;
  const hashes = new Set(
    (await pinnedLibraryRecords(scope)).flatMap((record) =>
      record.attachments.flatMap((attachment) =>
        attachment.kind === "pdf" ? [attachment.sha256] : [],
      ),
    ),
  );
  const library = await listScientAnnotationFiles(scope.library.home, hashes);
  const inLibrary = new Set(library.files.map((file) => file.material.sha256));
  const own: ScientAnnotationFile[] = [];
  for (const file of project.files) {
    if (inLibrary.has(file.material.sha256)) continue;
    if (!(await isLibraryPdf(scope.library.home, file.material.sha256))) own.push(file);
  }
  return {
    files: [...own, ...library.files],
    unreadable: [...project.unreadable, ...library.unreadable],
  };
}

const materialCache = new Map<string, { readonly stamp: string; readonly material: PdfMaterial }>();
const MATERIAL_CACHE_LIMIT = 256;

/** The PDF's bytes identity, recomputed only when the file changes on disk. */
async function pdfMaterial(absolutePath: string): Promise<PdfMaterial> {
  const stats = await NodeFSP.stat(absolutePath, { bigint: true });
  const stamp = [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  const cached = materialCache.get(absolutePath);
  if (cached?.stamp === stamp) return cached.material;
  const inspected = await inspectScientSourcePdf(absolutePath);
  const material = { sha256: inspected.sha256, byteLength: inspected.byteLength };
  materialCache.delete(absolutePath);
  materialCache.set(absolutePath, { stamp, material });
  if (materialCache.size > MATERIAL_CACHE_LIMIT) {
    materialCache.delete(materialCache.keys().next().value!);
  }
  return material;
}

interface ProjectPdf {
  readonly absolutePath: string;
  /** The project path the reader names, kept as a hint; null for a PDF in the library. */
  readonly relativePath: string | null;
  readonly material: PdfMaterial;
}

/** The reader names a Source PDF by its v1 store path; after the move its bytes are the library's. */
const SOURCE_STORE_PDF = /^\.scient\/sources\/(files\/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})\.pdf)$/u;

async function projectPdf(canonicalRoot: string, relativePath: string): Promise<ProjectPdf> {
  const resolved = await resolveScientSourceInputPdf(canonicalRoot, relativePath);
  return {
    absolutePath: resolved.absolutePath,
    relativePath: NodePath.relative(canonicalRoot, resolved.absolutePath)
      .split(NodePath.sep)
      .join("/"),
    material: await pdfMaterial(resolved.absolutePath),
  };
}

/**
 * A PDF the reader shows, by project path. On a moved project a Source PDF's old store path
 * reads the library's copy of those bytes, when the library has them.
 */
async function readerPdf(scope: AnnotationScope, relativePath: string): Promise<ProjectPdf> {
  const match = scope.library ? SOURCE_STORE_PDF.exec(relativePath) : null;
  try {
    return await projectPdf(scope.canonicalRoot, relativePath);
  } catch (error) {
    if (!match || !scope.library || !(await isLibraryPdf(scope.library.home, match[2]!))) {
      throw error;
    }
  }
  const absolutePath = scientSourceStorePdfPath(scope.library.home, match[2]!);
  return { absolutePath, relativePath: null, material: await pdfMaterial(absolutePath) };
}

async function sourcePdf(
  scope: AnnotationScope,
  sourceId: string,
  attachmentId: string | undefined,
): Promise<ProjectPdf | null> {
  const store: ScientSourceStoreLocation = scope.library?.home ?? scope.canonicalRoot;
  const id = scope.library ? await resolveLibrarySourceId(scope.library.store, sourceId) : sourceId;
  const record = id ? await readScientSourceRecord(store, id) : null;
  if (!record) return null;
  const pdfs = record.attachments.filter((attachment) => attachment.kind === "pdf");
  const attachment =
    attachmentId === undefined
      ? pdfs.length === 1
        ? pdfs[0]
        : undefined
      : pdfs.find((candidate) => candidate.attachmentId === attachmentId);
  if (!attachment) return null;
  const absolutePath = sourceAttachmentAbsolutePath(store, attachment);
  return {
    absolutePath,
    relativePath: scope.library ? null : `${SCIENT_SOURCES_DIRECTORY}/${attachment.relativePath}`,
    material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
  };
}

/** Page texts in the reader's profile: the stored Sources full text when complete, else read now. */
async function pdfPageTexts(
  textStore: ScientSourceStoreLocation,
  pdf: ProjectPdf,
): Promise<{
  readonly extractorVersion: string;
  readonly pages: ReadonlyArray<PdfPageText>;
} | null> {
  const stored = await readScientSourceFullText(textStore, pdf.material.sha256).catch(() => null);
  const text =
    stored?.outcome === "extracted" && stored.complete
      ? stored
      : await extractSourcePdfFileFullText({
          pdfPath: pdf.absolutePath,
          sha256: pdf.material.sha256,
          byteLength: pdf.material.byteLength,
        });
  if (text.outcome !== "extracted") return null;
  return { extractorVersion: text.extractor.version, pages: text.pages };
}

export interface AnnotatedPdfSummary {
  readonly sha256: string;
  readonly paths: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly title: string | null;
    readonly citationKey?: string;
  }>;
}

export interface AnnotationListing {
  readonly pdfs: ReadonlyArray<
    AnnotatedPdfSummary & {
      readonly annotations: ReadonlyArray<ScientPdfAnnotation>;
    }
  >;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly unreadableFiles: ReadonlyArray<string>;
}

export type AnnotationPdfReference =
  | { readonly relativePath: string }
  | { readonly sourceId: string; readonly attachmentId?: string };

export type QuoteAnnotationResult =
  | {
      readonly outcome: ScientAnnotationMutationResult["outcome"];
      readonly annotation: ScientPdfAnnotation | null;
      readonly pdf: AnnotatedPdfSummary;
    }
  | { readonly outcome: "pdf-not-found" }
  | { readonly outcome: "quote-not-found" }
  | { readonly outcome: "quote-too-long" }
  | { readonly outcome: "quote-ambiguous"; readonly pages: ReadonlyArray<number> };

export interface AnnotationByIdResult {
  readonly result: ScientAnnotationMutationResult;
  readonly history: ReadonlyArray<AnnotationHistoryEntry>;
}

export class ScientAnnotations extends Context.Service<
  ScientAnnotations,
  {
    readonly forDocument: (input: {
      readonly root: string;
      readonly relativePath: string;
    }) => Effect.Effect<ScientAnnotationsDocumentResult>;
    readonly forSource: (input: {
      readonly root: string;
      readonly sourceId: string;
    }) => Effect.Effect<ScientAnnotationsSourceResult, ScientAnnotationsError>;
    readonly mutate: (
      request: ScientAnnotationMutationRequest,
      actor: ScientAnnotationActor,
    ) => Effect.Effect<ScientAnnotationMutationResult, ScientAnnotationsError>;
    readonly mutateById: (input: {
      readonly root: string;
      readonly command: Exclude<ScientAnnotationCommand, { readonly action: "create" }>;
      readonly actor: ScientAnnotationActor;
    }) => Effect.Effect<AnnotationByIdResult, ScientAnnotationsError>;
    readonly list: (input: {
      readonly root: string;
      readonly pdf?: AnnotationPdfReference;
      readonly query?: string;
      readonly includeRemoved?: boolean;
      readonly offset?: number;
      readonly limit?: number;
    }) => Effect.Effect<AnnotationListing | null, ScientAnnotationsError>;
    readonly annotateQuote: (input: {
      readonly root: string;
      readonly pdf: AnnotationPdfReference;
      readonly quote: string;
      readonly page?: number;
      readonly note: string;
      readonly highlighted: boolean;
      readonly actor: ScientAnnotationActor;
    }) => Effect.Effect<QuoteAnnotationResult, ScientAnnotationsError>;
  }
>()("t3/scient/annotations/ScientAnnotations") {}

function samePlace(left: ScientPdfAnnotation, right: ScientPdfAnnotation["anchor"]): boolean {
  const a = left.anchor.selector.pages;
  const b = right.selector.pages;
  return (
    a.length === b.length &&
    a.every(
      (page, index) =>
        page.page === b[index]!.page &&
        page.start === b[index]!.start &&
        page.end === b[index]!.end,
    )
  );
}

async function summarize(
  scope: AnnotationScope,
  files: ReadonlyArray<ScientAnnotationFile>,
): Promise<Map<string, AnnotatedPdfSummary>> {
  const records = await scopeRecords(scope);
  const summaries = new Map<string, AnnotatedPdfSummary>();
  for (const file of files) {
    summaries.set(file.material.sha256, {
      sha256: file.material.sha256,
      paths: file.paths,
      sources: records.flatMap((record) =>
        record.attachments
          .filter((attachment) => attachment.sha256 === file.material.sha256)
          .map((attachment) => ({
            sourceId: record.sourceId,
            attachmentId: attachment.attachmentId,
            title: record.title,
            ...(record.citationKey ? { citationKey: record.citationKey } : {}),
          })),
      ),
    });
  }
  return summaries;
}

export const layer = Layer.succeed(ScientAnnotations, {
  forDocument: Effect.fn("ScientAnnotations.forDocument")(function* (input) {
    const read = yield* annotationScope(input.root, "read").pipe(
      Effect.flatMap((scope) =>
        attempt("pdf-unavailable", async () => {
          const pdf = await readerPdf(scope, input.relativePath);
          const file = await readScientAnnotationFile(
            await annotationHome(scope, pdf.material.sha256),
            pdf.material.sha256,
          );
          const records = await scopeRecords(scope);
          return {
            material: pdf.material,
            annotations: file?.annotations ?? [],
            sources: records
              .filter((record) =>
                record.attachments.some((attachment) => attachment.sha256 === pdf.material.sha256),
              )
              .map((record) => ({
                sourceId: record.sourceId,
                title: record.title,
                ...(record.citationKey ? { citationKey: record.citationKey } : {}),
              })),
          };
        }),
      ),
      Effect.option,
    );
    if (read._tag === "None") return { status: "unavailable" } as const;
    return {
      status: "available",
      material: read.value.material,
      annotations: liveScientAnnotations(read.value.annotations),
      sources: read.value.sources,
    } as const;
  }),

  forSource: Effect.fn("ScientAnnotations.forSource")(function* (input) {
    const scope = yield* annotationScope(input.root, "read");
    return yield* attempt("operation-failed", async () => {
      const store: ScientSourceStoreLocation = scope.library?.home ?? scope.canonicalRoot;
      const sourceId = scope.library
        ? await resolveLibrarySourceId(scope.library.store, input.sourceId)
        : input.sourceId;
      const record = sourceId ? await readScientSourceRecord(store, sourceId) : null;
      if (!record) return { attachments: [] };
      const attachments = [];
      for (const attachment of record.attachments) {
        if (attachment.kind !== "pdf") continue;
        const file = await readScientAnnotationFile(
          await annotationHome(scope, attachment.sha256),
          attachment.sha256,
        );
        attachments.push({
          attachmentId: attachment.attachmentId,
          material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
          annotations: liveScientAnnotations(file?.annotations ?? []),
        });
      }
      return { attachments };
    });
  }),

  mutate: Effect.fn("ScientAnnotations.mutate")(function* (request, actor) {
    const now = yield* nowIso;
    const scope = yield* annotationScope(request.root, "write");
    return yield* attempt("operation-failed", async () => {
      let relativePath: string | null = null;
      if (request.command.action === "create") {
        if (request.relativePath === undefined) throw new Error("A create names its PDF.");
        const pdf = await readerPdf(scope, request.relativePath);
        if (
          pdf.material.sha256 !== request.material.sha256 ||
          pdf.material.byteLength !== request.material.byteLength
        ) {
          return { outcome: "material-changed", annotation: null } as const;
        }
        relativePath = pdf.relativePath;
      }
      return mutateScientAnnotations({
        canonicalRoot: await annotationHome(scope, request.material.sha256),
        material: request.material,
        relativePath,
        command: request.command,
        actor,
        now,
      });
    });
  }),

  mutateById: Effect.fn("ScientAnnotations.mutateById")(function* (input) {
    const now = yield* nowIso;
    const scope = yield* annotationScope(input.root, "write");
    return yield* attempt("operation-failed", async () => {
      const { files } = await scopeAnnotationFiles(scope);
      const file = files.find((candidate) =>
        candidate.annotations.some(
          (annotation) => annotation.annotationId === input.command.annotationId,
        ),
      );
      if (!file) {
        return { result: { outcome: "not-found", annotation: null }, history: [] } as const;
      }
      const home = await annotationHome(scope, file.material.sha256);
      const result = await mutateScientAnnotations({
        canonicalRoot: home,
        material: file.material,
        relativePath: null,
        command: input.command,
        actor: input.actor,
        now,
      });
      const after = await readScientAnnotationFile(home, file.material.sha256);
      return {
        result,
        history: after ? annotationHistory(after, input.command.annotationId) : [],
      };
    });
  }),

  list: Effect.fn("ScientAnnotations.list")(function* (input) {
    const scope = yield* annotationScope(input.root, "read");
    return yield* attempt("operation-failed", async () => {
      let only: string | null = null;
      if (input.pdf) {
        const pdf =
          "relativePath" in input.pdf
            ? await readerPdf(scope, input.pdf.relativePath).catch(() => null)
            : await sourcePdf(scope, input.pdf.sourceId, input.pdf.attachmentId);
        if (!pdf) return null;
        only = pdf.material.sha256;
      }
      const listing = await scopeAnnotationFiles(scope);
      const files = listing.files.filter((file) => only === null || file.material.sha256 === only);
      const query = input.query?.trim().toLowerCase() ?? "";
      const matching = files.flatMap((file) =>
        (input.includeRemoved ? file.annotations : liveScientAnnotations(file.annotations)).flatMap(
          (annotation) =>
            query.length === 0 ||
            `${scientAnnotationQuote(annotation)}\n${annotation.note}`.toLowerCase().includes(query)
              ? [{ sha256: file.material.sha256, annotation }]
              : [],
        ),
      );
      const offset = Math.max(0, input.offset ?? 0);
      const limit = Math.min(100, Math.max(1, input.limit ?? 50));
      const page = matching.slice(offset, offset + limit);
      const summaries = await summarize(
        scope,
        files.filter((file) => page.some((entry) => entry.sha256 === file.material.sha256)),
      );
      const pdfs = [...summaries.values()].map((summary) => ({
        ...summary,
        annotations: page
          .filter((entry) => entry.sha256 === summary.sha256)
          .map((entry) => entry.annotation),
      }));
      return {
        pdfs,
        total: matching.length,
        nextOffset: offset + page.length < matching.length ? offset + page.length : null,
        unreadableFiles: listing.unreadable,
      };
    });
  }),

  annotateQuote: Effect.fn("ScientAnnotations.annotateQuote")(function* (input) {
    const now = yield* nowIso;
    const scope = yield* annotationScope(input.root, "write");
    return yield* attempt("operation-failed", async (): Promise<QuoteAnnotationResult> => {
      const pdf =
        "relativePath" in input.pdf
          ? await readerPdf(scope, input.pdf.relativePath).catch(() => null)
          : await sourcePdf(scope, input.pdf.sourceId, input.pdf.attachmentId);
      if (!pdf) return { outcome: "pdf-not-found" };
      const home = await annotationHome(scope, pdf.material.sha256);
      const text = await pdfPageTexts(home, pdf);
      if (!text) return { outcome: "quote-not-found" };
      const anchoring = anchorPdfQuote(text.pages, input.quote, text.extractorVersion, input.page);
      switch (anchoring._tag) {
        case "NotFound":
          return { outcome: "quote-not-found" };
        case "TooLong":
          return { outcome: "quote-too-long" };
        case "Ambiguous":
          return { outcome: "quote-ambiguous", pages: anchoring.pages };
        case "Found":
          break;
      }
      const existing = await readScientAnnotationFile(home, pdf.material.sha256);
      const summary = async (): Promise<AnnotatedPdfSummary> => {
        const file = await readScientAnnotationFile(home, pdf.material.sha256);
        const summaries = await summarize(scope, file ? [file] : []);
        return (
          summaries.get(pdf.material.sha256) ?? {
            sha256: pdf.material.sha256,
            paths: pdf.relativePath === null ? [] : [pdf.relativePath],
            sources: [],
          }
        );
      };
      const same = existing?.annotations.find(
        (annotation) => annotation.deletedAt === null && samePlace(annotation, anchoring.anchor),
      );
      const write = (command: ScientAnnotationCommand) =>
        mutateScientAnnotations({
          canonicalRoot: home,
          material: pdf.material,
          relativePath: pdf.relativePath,
          command,
          actor: input.actor,
          now,
        });
      if (same) {
        const result = await write({
          action: "update",
          annotationId: same.annotationId,
          expectedRevision: same.revision,
          highlighted: same.highlighted || input.highlighted,
          ...(input.note.trim().length > 0 ? { note: input.note } : {}),
        });
        return { ...result, pdf: await summary() };
      }
      const annotationId = `ann_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const result = await write({
        action: "create",
        annotationId,
        anchor: anchoring.anchor,
        highlighted: input.highlighted,
        note: input.note,
      });
      return { ...result, pdf: await summary() };
    });
  }),
});
