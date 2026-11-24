import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readDocxPackage, writeDocxPackage } from "./docxPackage.ts";
import {
  MAIN_PART,
  applyTrackedReplacement,
  encodePart,
  partText,
  refuseUnsupportedInput,
  verifyTrackedReplacement,
  type DocxInventory,
  type TrackedReplacementRequest,
} from "./docxTrackedReplacement.ts";
import { OfficeRenderer } from "./OfficeRenderer.ts";
import { isOoxmlShapeError } from "./ooxmlXml.ts";
import { checkPdfPlacement, readPdfLayout } from "./pdfLayout.ts";

export const MAX_DOCX_JOB_INPUT_BYTES = 32 * 1024 * 1024;

export const DocxJobCheck = Schema.Struct({ id: Schema.String, passed: Schema.Boolean });

export class DocxJobError extends Schema.TaggedError<DocxJobError>()("DocxJobError", {
  code: Schema.Literals([
    "unsupported-input",
    "unsupported-edit",
    "render-failed",
    "integrity-failed",
  ]),
  reason: Schema.String,
  checks: Schema.optional(Schema.Array(DocxJobCheck)),
}) {
  override get message(): string {
    return `The Word job stopped: ${this.code} (${this.reason}).`;
  }
}

export interface DocxJobResult {
  readonly candidateDocx: Uint8Array;
  readonly candidatePdf: Uint8Array;
  readonly sourcePdf: Uint8Array;
  readonly deletionId: string;
  readonly insertionId: string;
  readonly checks: ReadonlyArray<typeof DocxJobCheck.Type>;
  readonly inventory: DocxInventory;
  readonly pageCount: number;
  readonly editPage: number;
  readonly fonts: {
    readonly source: ReadonlyArray<string>;
    readonly candidate: ReadonlyArray<string>;
  };
  readonly producer: string | null;
  readonly warnings: ReadonlyArray<string>;
}

const jobError = (
  code: DocxJobError["code"],
  reason: string,
  checks?: ReadonlyArray<typeof DocxJobCheck.Type>,
) => new DocxJobError({ code, reason, ...(checks === undefined ? {} : { checks }) });

/**
 * The typed operation: a tracked replacement in a new copy of `sourceBytes`, rendered with the
 * source by the worker, and returned only when the package proof and both PDFs pass. The source
 * bytes are only read; nothing here touches the workspace.
 */
export const runDocxTrackedReplacement = Effect.fn("DocxTrackedReplacement.run")(function* (
  sourceBytes: Uint8Array,
  request: TrackedReplacementRequest,
) {
  if (sourceBytes.byteLength > MAX_DOCX_JOB_INPUT_BYTES)
    return yield* jobError("unsupported-input", "too-large");
  const renderer = yield* OfficeRenderer;
  const entries = yield* readDocxPackage(sourceBytes).pipe(
    Effect.mapError((cause) => jobError("unsupported-input", cause.problem)),
  );
  const shape = yield* Effect.try({
    try: () => {
      const refusal = refuseUnsupportedInput(entries);
      return refusal === null
        ? { xml: partText(entries, MAIN_PART)!, styles: partText(entries, "word/styles.xml") }
        : { refusal };
    },
    catch: (cause) =>
      jobError("unsupported-input", isOoxmlShapeError(cause) ? "malformed-part" : "unreadable"),
  });
  if ("refusal" in shape) return yield* jobError("unsupported-input", shape.refusal);
  const edit = applyTrackedReplacement(shape.xml, request, shape.styles);
  if (edit._tag === "refused") return yield* jobError("unsupported-edit", edit.reason);

  const candidateDocx = yield* writeDocxPackage(
    entries.map((entry) =>
      entry.name === MAIN_PART ? { ...entry, bytes: encodePart(edit.xml) } : entry,
    ),
  ).pipe(Effect.mapError(() => jobError("integrity-failed", "package-write")));
  const written = yield* readDocxPackage(candidateDocx).pipe(
    Effect.mapError(() => jobError("integrity-failed", "package-reread")),
  );
  const docx = yield* Effect.try({
    try: () => verifyTrackedReplacement(entries, written, request),
    catch: () => jobError("integrity-failed", "verification-error"),
  });
  if (!docx.passed || docx.candidate === null)
    return yield* jobError("integrity-failed", "docx-checks", docx.checks);

  const rendered = yield* renderer
    .render([
      { name: "source.docx", bytes: sourceBytes },
      { name: "candidate.docx", bytes: candidateDocx },
    ])
    .pipe(Effect.mapError((cause) => jobError("render-failed", cause.reason)));
  const sourcePdf = rendered.get("source.docx");
  const candidatePdf = rendered.get("candidate.docx");
  if (sourcePdf === undefined || candidatePdf === undefined)
    return yield* jobError("render-failed", "missing-output");
  const [sourceLayout, candidateLayout] = yield* Effect.all([
    readPdfLayout(sourcePdf),
    readPdfLayout(candidatePdf),
  ]).pipe(Effect.mapError(() => jobError("integrity-failed", "pdf-unreadable", docx.checks)));
  const placement = checkPdfPlacement(sourceLayout, candidateLayout, request.find, request.replace);
  const checks = [...docx.checks, ...placement.checks].map(({ id, passed }) => ({ id, passed }));
  if (!placement.passed || placement.editPage === null)
    return yield* jobError("integrity-failed", "pdf-checks", checks);
  return {
    candidateDocx,
    candidatePdf,
    sourcePdf,
    deletionId: edit.deletionId,
    insertionId: edit.insertionId,
    checks,
    inventory: docx.candidate,
    pageCount: placement.pageCount,
    editPage: placement.editPage,
    fonts: { source: sourceLayout.fonts, candidate: candidateLayout.fonts },
    producer: candidateLayout.producer,
    // PDF text checks cannot establish how directional boundaries were drawn.
    warnings: edit.neutralAtRightToLeftEdge ? ["bidi-neutral-at-edge"] : [],
  } satisfies DocxJobResult;
});
