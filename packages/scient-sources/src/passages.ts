import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const PositiveInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }));
const Coordinate = Schema.Number.check(
  Schema.isBetween({ minimum: -10_000_000, maximum: 10_000_000 }),
);
const Rectangle = Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]);
const Text = Schema.String.check(Schema.isMaxLength(8_000));

/** Immutable, versioned selection evidence, not a claim of scientific correctness. */
export const ScientPassageCapture = Schema.Struct({
  material: Schema.Struct({
    sha256: Hash,
    byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 * 1024 * 1024 })),
  }),
  extractorVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  profile: Schema.Literal("pdfjs-text-layer-utf16-eol-v1"),
  pages: Schema.Array(
    Schema.Struct({
      page: PositiveInt,
      pageTextHash: Hash,
      viewBox: Rectangle,
      rotation: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 359 })),
      userUnit: Schema.Number.check(Schema.isBetween({ minimum: 0.000001, maximum: 75_000 })),
      start: Offset,
      end: Offset,
      quote: Text.check(Schema.isMinLength(1)),
      prefix: Schema.String.check(Schema.isMaxLength(64)),
      suffix: Schema.String.check(Schema.isMaxLength(64)),
      rectangles: Schema.Array(Rectangle).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
}).check(
  Schema.makeFilter((capture) => {
    let characters = 0;
    let rectangles = 0;
    return capture.pages.every((page, index) => {
      characters += page.quote.length;
      rectangles += page.rectangles.length;
      const bounds = page.viewBox;
      return (
        characters <= 8_000 &&
        rectangles <= 256 &&
        page.end - page.start === page.quote.length &&
        !!page.quote.trim() &&
        (index === 0 || page.page === capture.pages[index - 1]!.page + 1) &&
        bounds[0] < bounds[2] &&
        bounds[1] < bounds[3] &&
        page.rectangles.every(
          (r) =>
            r[0] < r[2] &&
            r[1] < r[3] &&
            r[0] >= bounds[0] - 2 &&
            r[1] >= bounds[1] - 2 &&
            r[2] <= bounds[2] + 2 &&
            r[3] <= bounds[3] + 2,
        )
      );
    });
  }),
);
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
