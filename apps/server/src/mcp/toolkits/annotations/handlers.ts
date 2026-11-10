import {
  scientAnnotationQuote,
  type ScientAnnotationCommand,
  type ScientPdfAnnotation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import {
  ScientAnnotations,
  type AnnotationByIdResult,
  type AnnotationPdfReference,
} from "../../../scient/annotations/ScientAnnotations.ts";
import {
  ScientAnnotationsToolError,
  ScientAnnotationsToolkit,
  type ScientAnnotationAgentView,
} from "./tools.ts";

const QUOTE_LIMIT = 2_000;

const toolError = (code: ScientAnnotationsToolError["code"], message: string) =>
  new ScientAnnotationsToolError({ code, message });

// Store errors can carry absolute paths; model-visible output stays path-free.
const operationFailed = Effect.mapError(() =>
  toolError("operation-failed", "The annotation operation could not be completed."),
);

const projectRoot = Effect.fn("ScientAnnotationsToolkit.projectRoot")(function* () {
  const workspace = yield* consumeAgentWorkspace().pipe(
    Effect.mapError((error) => toolError(error.code, error.message)),
  );
  return workspace.binding.canonicalRoot;
});

function annotationAgentView(annotation: ScientPdfAnnotation): ScientAnnotationAgentView {
  const quote = scientAnnotationQuote(annotation);
  return {
    annotationId: annotation.annotationId,
    revision: annotation.revision,
    pages: annotation.anchor.selector.pages.map((page) => page.page),
    quote: quote.slice(0, QUOTE_LIMIT),
    quoteTruncated: quote.length > QUOTE_LIMIT,
    note: annotation.note,
    highlighted: annotation.highlighted,
    createdBy: annotation.createdBy,
    updatedBy: annotation.updatedBy,
    updatedAt: annotation.updatedAt,
    removed: annotation.deletedAt !== null,
  };
}

function pdfReference(input: {
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly pdfRelativePath?: string;
}) {
  if (input.sourceId !== undefined && input.pdfRelativePath !== undefined) {
    return Effect.fail(toolError("invalid-input", "Give either sourceId or pdfRelativePath."));
  }
  if (input.attachmentId !== undefined && input.sourceId === undefined) {
    return Effect.fail(toolError("invalid-input", "attachmentId needs its sourceId."));
  }
  const reference: AnnotationPdfReference | undefined =
    input.pdfRelativePath !== undefined
      ? { relativePath: input.pdfRelativePath }
      : input.sourceId !== undefined
        ? {
            sourceId: input.sourceId,
            ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
          }
        : undefined;
  return Effect.succeed(reference);
}

function mutationView({ result, history }: AnnotationByIdResult) {
  const outcome = result.outcome === "material-changed" ? "stale" : result.outcome;
  return {
    outcome,
    annotation: result.annotation ? annotationAgentView(result.annotation) : null,
    earlierRevisions: history
      .map(({ revision, note, highlighted, updatedBy, updatedAt }) => ({
        revision,
        note,
        highlighted,
        updatedBy,
        updatedAt,
      }))
      .reverse(),
  };
}

const mutateById = Effect.fn("ScientAnnotationsToolkit.mutateById")(function* (
  command: Exclude<ScientAnnotationCommand, { readonly action: "create" }>,
) {
  const root = yield* projectRoot();
  const annotations = yield* ScientAnnotations;
  return mutationView(
    yield* annotations.mutateById({ root, command, actor: "agent" }).pipe(operationFailed),
  );
});

export const readAnnotationsForInvocation = Effect.fn("ScientAnnotationsToolkit.read")(
  function* (input: {
    readonly sourceId?: string;
    readonly attachmentId?: string;
    readonly pdfRelativePath?: string;
    readonly query?: string;
    readonly includeRemoved?: boolean;
    readonly offset?: number;
    readonly limit?: number;
  }) {
    const root = yield* projectRoot();
    const pdf = yield* pdfReference(input);
    const annotations = yield* ScientAnnotations;
    const listing = yield* annotations
      .list({
        root,
        ...(pdf === undefined ? {} : { pdf }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.includeRemoved === undefined ? {} : { includeRemoved: input.includeRemoved }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        limit: Math.min(50, input.limit ?? 25),
      })
      .pipe(operationFailed);
    if (!listing) {
      return {
        outcome: "pdf-not-found" as const,
        pdfs: [],
        total: 0,
        nextOffset: null,
        unreadableFiles: 0,
      };
    }
    return {
      outcome: "listed" as const,
      pdfs: listing.pdfs.map((entry) => ({
        sha256: entry.sha256,
        paths: entry.paths,
        sources: entry.sources,
        annotations: entry.annotations.map(annotationAgentView),
      })),
      total: listing.total,
      nextOffset: listing.nextOffset,
      unreadableFiles: listing.unreadableFiles.length,
    };
  },
);

export const addAnnotationForInvocation = Effect.fn("ScientAnnotationsToolkit.add")(
  function* (input: {
    readonly sourceId?: string;
    readonly attachmentId?: string;
    readonly pdfRelativePath?: string;
    readonly quote: string;
    readonly page?: number;
    readonly note?: string;
    readonly highlight?: boolean;
  }) {
    const root = yield* projectRoot();
    const pdf = yield* pdfReference(input);
    if (!pdf) {
      return yield* toolError("invalid-input", "Give the sourceId or pdfRelativePath to annotate.");
    }
    const annotations = yield* ScientAnnotations;
    const result = yield* annotations
      .annotateQuote({
        root,
        pdf,
        quote: input.quote,
        ...(input.page === undefined ? {} : { page: input.page }),
        note: input.note ?? "",
        highlighted: input.highlight ?? true,
        actor: "agent",
      })
      .pipe(operationFailed);
    if (!("pdf" in result)) {
      return {
        outcome: result.outcome,
        annotation: null,
        pdf: null,
        ...("pages" in result ? { pages: result.pages } : {}),
      };
    }
    return {
      outcome:
        result.outcome === "material-changed" ||
        result.outcome === "stale" ||
        result.outcome === "not-found" ||
        result.outcome === "removed" ||
        result.outcome === "restored"
          ? ("unchanged" as const)
          : result.outcome,
      annotation: result.annotation ? annotationAgentView(result.annotation) : null,
      pdf: result.pdf,
    };
  },
);

export const updateAnnotationForInvocation = Effect.fn("ScientAnnotationsToolkit.update")(
  function* (input: {
    readonly annotationId: string;
    readonly expectedRevision: number;
    readonly note?: string;
    readonly highlighted?: boolean;
  }) {
    return yield* mutateById({
      action: "update",
      annotationId: input.annotationId,
      expectedRevision: input.expectedRevision,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.highlighted === undefined ? {} : { highlighted: input.highlighted }),
    });
  },
);

export const removeAnnotationForInvocation = Effect.fn("ScientAnnotationsToolkit.remove")(
  function* (input: { readonly annotationId: string; readonly expectedRevision: number }) {
    return yield* mutateById({ action: "remove", ...input });
  },
);

export const restoreAnnotationForInvocation = Effect.fn("ScientAnnotationsToolkit.restore")(
  function* (input: {
    readonly annotationId: string;
    readonly expectedRevision: number;
    readonly toRevision?: number;
  }) {
    return yield* mutateById(
      input.toRevision === undefined
        ? {
            action: "restore",
            annotationId: input.annotationId,
            expectedRevision: input.expectedRevision,
          }
        : {
            action: "revert",
            annotationId: input.annotationId,
            expectedRevision: input.expectedRevision,
            toRevision: input.toRevision,
          },
    );
  },
);

const handlers = {
  scient_annotations_read: readAnnotationsForInvocation,
  scient_annotations_add: addAnnotationForInvocation,
  scient_annotations_update: updateAnnotationForInvocation,
  scient_annotations_remove: removeAnnotationForInvocation,
  scient_annotations_restore: restoreAnnotationForInvocation,
} satisfies Parameters<typeof ScientAnnotationsToolkit.toLayer>[0];

export const ScientAnnotationsToolkitHandlersLive = ScientAnnotationsToolkit.toLayer(handlers);
