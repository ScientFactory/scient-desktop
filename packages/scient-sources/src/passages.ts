import { PdfTextCapture } from "@scientfactory/annotations";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const PositiveInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));

/** Legacy Sources decoder; the canonical selector is document-owned. */
export const ScientPassageCapture = PdfTextCapture;
export type ScientPassageCapture = typeof ScientPassageCapture.Type;

export const ScientPassageNote = Schema.String.check(Schema.isMaxLength(8_000));
export const ScientSavedPassage = Schema.Struct({
  formatVersion: Schema.Literal(1),
  passageId: Id,
  attachmentId: Id,
  revision: PositiveInt,
  capture: ScientPassageCapture,
  note: ScientPassageNote,
  highlighted: Schema.optionalKey(Schema.Boolean),
  actor: Schema.Literal("user"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
export type ScientSavedPassage = typeof ScientSavedPassage.Type;

export const ScientPassageCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("save"),
    passageId: Id,
    attachmentId: Id,
    capture: ScientPassageCapture,
    note: ScientPassageNote,
    highlighted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    passageId: Id,
    expectedRevision: PositiveInt,
    note: ScientPassageNote,
  }),
  Schema.Struct({ action: Schema.Literal("remove"), passageId: Id, expectedRevision: PositiveInt }),
]);
export type ScientPassageCommand = typeof ScientPassageCommand.Type;

export const ScientPassageMutationResult = Schema.Struct({
  outcome: Schema.Literals([
    "saved",
    "updated",
    "removed",
    "unchanged",
    "stale",
    "not-found",
    "material-changed",
    "limit-reached",
  ]),
  passage: Schema.NullOr(ScientSavedPassage),
});
export type ScientPassageMutationResult = typeof ScientPassageMutationResult.Type;

export function activeSourcePassages(record: {
  readonly savedPassages?: ReadonlyArray<ScientSavedPassage>;
}): ReadonlyArray<ScientSavedPassage> {
  return (record.savedPassages ?? []).filter((passage) => passage.deletedAt === null);
}

/** Plain Markdown with durable identifiers; no invented universal project-link scheme. */
export function savedPassageMarkdown(
  passage: ScientSavedPassage,
  citation: string,
  sourceId: string,
): string {
  const quote = passage.capture.pages.map((page) => page.quote).join("\n\n");
  const pages = passage.capture.pages.map((page) => page.page).join(", ");
  return `${quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join(
      "\n",
    )}\n\n${passage.note ? `Note (researcher interpretation):\n${passage.note}\n\n` : ""}${citation} · PDF page ${pages}\n\nSource: ${sourceId} · Passage: ${passage.passageId} · Material SHA-256: ${passage.capture.material.sha256}`;
}
