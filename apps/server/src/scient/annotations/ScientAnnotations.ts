// @effect-diagnostics nodeBuiltinImport:off -- Annotation material identity is the sha256 of a project PDF read through the Sources PDF boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PdfMaterial } from "@scientfactory/document-artifacts";
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
} from "./annotationStore.ts";
import { extractSourcePdfFileFullText } from "../sources/SourceFullText.ts";
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
  readonly relativePath: string;
  readonly material: PdfMaterial;
}

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

async function sourcePdf(
  canonicalRoot: string,
  sourceId: string,
  attachmentId: string | undefined,
): Promise<ProjectPdf | null> {
  const record = await readScientSourceRecord(canonicalRoot, sourceId);
  if (!record) return null;
  const pdfs = record.attachments.filter((attachment) => attachment.kind === "pdf");
  const attachment =
    attachmentId === undefined
      ? pdfs.length === 1
        ? pdfs[0]
        : undefined
      : pdfs.find((candidate) => candidate.attachmentId === attachmentId);
  if (!attachment) return null;
  const absolutePath = sourceAttachmentAbsolutePath(canonicalRoot, attachment);
  return {
    absolutePath,
    relativePath: `${SCIENT_SOURCES_DIRECTORY}/${attachment.relativePath}`,
    material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
  };
}

/** Page texts in the reader's profile: the stored Sources full text when complete, else read now. */
async function pdfPageTexts(
  canonicalRoot: string,
  pdf: ProjectPdf,
): Promise<{
  readonly extractorVersion: string;
  readonly pages: ReadonlyArray<PdfPageText>;
} | null> {
  const stored = await readScientSourceFullText(canonicalRoot, pdf.material.sha256).catch(
    () => null,
  );
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
  canonicalRoot: string,
  files: ReadonlyArray<ScientAnnotationFile>,
): Promise<Map<string, AnnotatedPdfSummary>> {
  const records = await listScientSourceRecords(canonicalRoot).catch(() => []);
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
    const read = yield* attempt("pdf-unavailable", async () => {
      const canonicalRoot = await annotationProjectRoot(input.root);
      const pdf = await projectPdf(canonicalRoot, input.relativePath);
      const file = await readScientAnnotationFile(canonicalRoot, pdf.material.sha256);
      const records = await listScientSourceRecords(canonicalRoot).catch(() => []);
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
    }).pipe(Effect.option);
    if (read._tag === "None") return { status: "unavailable" } as const;
    return {
      status: "available",
      material: read.value.material,
      annotations: liveScientAnnotations(read.value.annotations),
      sources: read.value.sources,
    } as const;
  }),

  forSource: Effect.fn("ScientAnnotations.forSource")(function* (input) {
    return yield* attempt("operation-failed", async () => {
      const canonicalRoot = await annotationProjectRoot(input.root);
      const record = await readScientSourceRecord(canonicalRoot, input.sourceId);
      if (!record) return { attachments: [] };
      const attachments = [];
      for (const attachment of record.attachments) {
        if (attachment.kind !== "pdf") continue;
        const file = await readScientAnnotationFile(canonicalRoot, attachment.sha256);
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
    return yield* attempt("operation-failed", async () => {
      const canonicalRoot = await annotationProjectRoot(request.root);
      let relativePath: string | null = null;
      if (request.command.action === "create") {
        if (request.relativePath === undefined) throw new Error("A create names its PDF.");
        const pdf = await projectPdf(canonicalRoot, request.relativePath);
        if (
          pdf.material.sha256 !== request.material.sha256 ||
          pdf.material.byteLength !== request.material.byteLength
        ) {
          return { outcome: "material-changed", annotation: null } as const;
        }
        relativePath = pdf.relativePath;
      }
      return mutateScientAnnotations({
        canonicalRoot,
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
    return yield* attempt("operation-failed", async () => {
      const canonicalRoot = await annotationProjectRoot(input.root);
      const { files } = await listScientAnnotationFiles(canonicalRoot);
      const file = files.find((candidate) =>
        candidate.annotations.some(
          (annotation) => annotation.annotationId === input.command.annotationId,
        ),
      );
      if (!file) {
        return { result: { outcome: "not-found", annotation: null }, history: [] } as const;
      }
      const result = await mutateScientAnnotations({
        canonicalRoot,
        material: file.material,
        relativePath: null,
        command: input.command,
        actor: input.actor,
        now,
      });
      const after = await readScientAnnotationFile(canonicalRoot, file.material.sha256);
      return {
        result,
        history: after ? annotationHistory(after, input.command.annotationId) : [],
      };
    });
  }),

  list: Effect.fn("ScientAnnotations.list")(function* (input) {
    return yield* attempt("operation-failed", async () => {
      const canonicalRoot = await annotationProjectRoot(input.root);
      let only: string | null = null;
      if (input.pdf) {
        const pdf =
          "relativePath" in input.pdf
            ? await projectPdf(canonicalRoot, input.pdf.relativePath).catch(() => null)
            : await sourcePdf(canonicalRoot, input.pdf.sourceId, input.pdf.attachmentId);
        if (!pdf) return null;
        only = pdf.material.sha256;
      }
      const listing = await listScientAnnotationFiles(canonicalRoot);
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
        canonicalRoot,
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
    return yield* attempt("operation-failed", async (): Promise<QuoteAnnotationResult> => {
      const canonicalRoot = await annotationProjectRoot(input.root);
      const pdf =
        "relativePath" in input.pdf
          ? await projectPdf(canonicalRoot, input.pdf.relativePath).catch(() => null)
          : await sourcePdf(canonicalRoot, input.pdf.sourceId, input.pdf.attachmentId);
      if (!pdf) return { outcome: "pdf-not-found" };
      const text = await pdfPageTexts(canonicalRoot, pdf);
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
      const existing = await readScientAnnotationFile(canonicalRoot, pdf.material.sha256);
      const summary = async (): Promise<AnnotatedPdfSummary> => {
        const file = await readScientAnnotationFile(canonicalRoot, pdf.material.sha256);
        const summaries = await summarize(canonicalRoot, file ? [file] : []);
        return (
          summaries.get(pdf.material.sha256) ?? {
            sha256: pdf.material.sha256,
            paths: [pdf.relativePath],
            sources: [],
          }
        );
      };
      const same = existing?.annotations.find(
        (annotation) => annotation.deletedAt === null && samePlace(annotation, anchoring.anchor),
      );
      const write = (command: ScientAnnotationCommand) =>
        mutateScientAnnotations({
          canonicalRoot,
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
