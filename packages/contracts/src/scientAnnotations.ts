import { PDF_TARGET_LIMITS, PdfMaterial, PdfTarget } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const PositiveInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const Timestamp = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const SCIENT_ANNOTATIONS_DIRECTORY = ".scient/annotations/v1";
const SCIENT_ANNOTATION_NOTE_LIMIT = 8_000;

export const ScientAnnotationActor = Schema.Literals(["user", "agent"]);
export type ScientAnnotationActor = typeof ScientAnnotationActor.Type;

export const ScientAnnotationId = Schema.String.check(
  Schema.isPattern(/^ann_[A-Za-z0-9_-]{8,64}$/u),
);
export type ScientAnnotationId = typeof ScientAnnotationId.Type;

export const ScientAnnotationNote = Schema.String.check(
  Schema.isMaxLength(SCIENT_ANNOTATION_NOTE_LIMIT),
);

/**
 * Where an annotation sits in its PDF: the text selector of a PDF target. The
 * document identity is left out on purpose; annotations are keyed by the
 * PDF's bytes, so the same file found at another path keeps them.
 */
export const ScientPdfAnnotationAnchor = Schema.Struct({
  extractor: PdfTarget.fields.extractor,
  selector: PdfTarget.fields.selector,
}).check(
  Schema.makeFilter(({ selector }) => {
    let characters = 0;
    return selector.pages.every((page, index, pages) => {
      characters += page.quote.length;
      return (
        characters <= PDF_TARGET_LIMITS.characters &&
        page.end - page.start === page.quote.length &&
        page.quote.trim().length > 0 &&
        (index === 0 || page.page === pages[index - 1]!.page + 1)
      );
    });
  }),
);
export type ScientPdfAnnotationAnchor = typeof ScientPdfAnnotationAnchor.Type;

export const ScientPdfAnnotation = Schema.Struct({
  annotationId: ScientAnnotationId,
  revision: PositiveInt,
  anchor: ScientPdfAnnotationAnchor,
  highlighted: Schema.Boolean,
  note: ScientAnnotationNote,
  createdAt: Timestamp,
  createdBy: ScientAnnotationActor,
  updatedAt: Timestamp,
  updatedBy: ScientAnnotationActor,
  deletedAt: Schema.NullOr(Timestamp),
});
export type ScientPdfAnnotation = typeof ScientPdfAnnotation.Type;

export const ScientAnnotationCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    annotationId: ScientAnnotationId,
    anchor: ScientPdfAnnotationAnchor,
    highlighted: Schema.Boolean,
    note: ScientAnnotationNote,
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    annotationId: ScientAnnotationId,
    expectedRevision: PositiveInt,
    highlighted: Schema.optionalKey(Schema.Boolean),
    note: Schema.optionalKey(ScientAnnotationNote),
  }),
  Schema.Struct({
    action: Schema.Literals(["remove", "restore"]),
    annotationId: ScientAnnotationId,
    expectedRevision: PositiveInt,
  }),
  Schema.Struct({
    action: Schema.Literal("revert"),
    annotationId: ScientAnnotationId,
    expectedRevision: PositiveInt,
    toRevision: PositiveInt,
    /** The version's text and highlight, when two kept versions share its revision. */
    toNote: Schema.optionalKey(ScientAnnotationNote),
    toHighlighted: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type ScientAnnotationCommand = typeof ScientAnnotationCommand.Type;

export const ScientAnnotationOutcome = Schema.Literals([
  "created",
  "updated",
  "removed",
  "restored",
  "unchanged",
  "stale",
  "not-found",
  "empty",
  "material-changed",
  "limit-reached",
]);
export type ScientAnnotationOutcome = typeof ScientAnnotationOutcome.Type;

export const ScientAnnotationMutationResult = Schema.Struct({
  outcome: ScientAnnotationOutcome,
  annotation: Schema.NullOr(ScientPdfAnnotation),
});
export type ScientAnnotationMutationResult = typeof ScientAnnotationMutationResult.Type;

/** Another computer's version of a live annotation, brought by a project package. */
export const ScientAnnotationAlternative = Schema.Struct({
  annotationId: ScientAnnotationId,
  revision: PositiveInt,
  highlighted: Schema.Boolean,
  note: ScientAnnotationNote,
  updatedAt: Timestamp,
  importedAt: Timestamp,
});
export type ScientAnnotationAlternative = typeof ScientAnnotationAlternative.Type;

export const ScientAnnotationsDocumentRequest = Schema.Struct({
  root: NonEmptyString,
  relativePath: NonEmptyString,
});
export type ScientAnnotationsDocumentRequest = typeof ScientAnnotationsDocumentRequest.Type;

export const ScientAnnotationsDocumentResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    material: PdfMaterial,
    annotations: Schema.Array(ScientPdfAnnotation),
    /** Versions another computer kept of these annotations; "Use this version" reverts to one. */
    alternatives: Schema.optionalKey(Schema.Array(ScientAnnotationAlternative)),
    /** Library sources with these bytes attached, for citing a quote. */
    sources: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          sourceId: NonEmptyString,
          title: Schema.NullOr(Schema.String),
          citationKey: Schema.optionalKey(NonEmptyString),
        }),
      ),
    ),
  }),
  /** Not a Scient project, or not a PDF Scient can read. */
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type ScientAnnotationsDocumentResult = typeof ScientAnnotationsDocumentResult.Type;

export const ScientAnnotationsSourceRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});
export type ScientAnnotationsSourceRequest = typeof ScientAnnotationsSourceRequest.Type;

export const ScientAnnotationsSourceResult = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      attachmentId: NonEmptyString,
      material: PdfMaterial,
      annotations: Schema.Array(ScientPdfAnnotation),
    }),
  ),
});
export type ScientAnnotationsSourceResult = typeof ScientAnnotationsSourceResult.Type;

export const ScientAnnotationMutationRequest = Schema.Struct({
  root: NonEmptyString,
  /** The PDF the reader shows. Needed to create: a create is refused when its bytes are no longer `material`. */
  relativePath: Schema.optionalKey(NonEmptyString),
  material: PdfMaterial,
  command: ScientAnnotationCommand,
});
export type ScientAnnotationMutationRequest = typeof ScientAnnotationMutationRequest.Type;

/** The live annotations, in reading order. */
export function liveScientAnnotations(
  annotations: ReadonlyArray<ScientPdfAnnotation>,
): ReadonlyArray<ScientPdfAnnotation> {
  return annotations
    .filter((annotation) => annotation.deletedAt === null)
    .sort((left, right) => {
      const a = left.anchor.selector.pages[0]!;
      const b = right.anchor.selector.pages[0]!;
      return a.page - b.page || a.start - b.start;
    });
}

/** The quoted text; a page break reads as a line break, so words never run together. */
export function scientAnnotationQuote(annotation: Pick<ScientPdfAnnotation, "anchor">): string {
  return annotation.anchor.selector.pages.reduce(
    (text, page) =>
      text === "" || /\s$/u.test(text) || /^\s/u.test(page.quote)
        ? text + page.quote
        : `${text}\n${page.quote}`,
    "",
  );
}
