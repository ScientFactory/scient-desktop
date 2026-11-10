import * as Schema from "effect/Schema";

export const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const PositiveInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }));
const Coordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: -10_000_000, maximum: 10_000_000 }),
);
const Rectangle = Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]);
const Text = Schema.String.check(Schema.isMaxLength(8_000));

/** Immutable, versioned selection evidence, not a claim of scientific correctness. */
export const PdfTextCapture = Schema.Struct({
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
      rotation: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 359 })),
      userUnit: Schema.Finite.check(Schema.isBetween({ minimum: 0.000001, maximum: 75_000 })),
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
export type PdfTextCapture = typeof PdfTextCapture.Type;

/** No OCR or invented quotation is needed to point at a figure, scan, or equation. */
export const PdfAreaCapture = Schema.Struct({
  material: PdfTextCapture.fields.material,
  profile: Schema.Literal("pdf-native-area-v1"),
  pages: Schema.Array(
    Schema.Struct({
      page: PositiveInt,
      viewBox: Rectangle,
      rotation: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 359 })),
      userUnit: Schema.Finite.check(Schema.isBetween({ minimum: 0.000001, maximum: 75_000 })),
      rectangles: Schema.Array(Rectangle).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
}).check(
  Schema.makeFilter(({ pages }) =>
    pages.every(
      (page, i) =>
        (i === 0 || page.page === pages[i - 1]!.page + 1) &&
        page.viewBox[0] < page.viewBox[2] &&
        page.viewBox[1] < page.viewBox[3] &&
        page.rectangles.every(
          (r) =>
            r[0] < r[2] &&
            r[1] < r[3] &&
            r[0] >= page.viewBox[0] &&
            r[1] >= page.viewBox[1] &&
            r[2] <= page.viewBox[2] &&
            r[3] <= page.viewBox[3],
        ) &&
        pages.reduce((n, p) => n + p.rectangles.length, 0) <= 256,
    ),
  ),
);
export type PdfAreaCapture = typeof PdfAreaCapture.Type;
export const AnnotationCapture = Schema.Union([PdfTextCapture, PdfAreaCapture]);
export type AnnotationCapture = typeof AnnotationCapture.Type;

const Note = Schema.String.check(Schema.isMaxLength(8_000));
const Timestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value)),
  ),
);
const Principal = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const ProjectAnnotationOwner = Schema.Struct({
  kind: Schema.Literal("project"),
  projectId: Id,
});
export const AnnotationRecord = Schema.Struct({
  formatVersion: Schema.Literal(1),
  annotationId: Id,
  revision: PositiveInt,
  owner: ProjectAnnotationOwner,
  region: Schema.Struct({
    regionId: Id,
    resourceId: Id,
    capture: AnnotationCapture,
  }),
  note: Note,
  bodyFormat: Schema.Literal("plain-text"),
  highlighted: Schema.Boolean,
  // A correction is an attributed interpretation, never a replacement for captured raw text.
  correctedText: Schema.NullOr(Schema.Struct({ text: Note, author: Principal })),
  importedFrom: Schema.optionalKey(
    Schema.Struct({
      sourceId: Id,
      attachmentId: Id,
      sourceSnapshotHash: Hash,
      legacyRevision: PositiveInt,
    }),
  ),
  authorship: Schema.Struct({
    kind: Schema.Literals(["user", "imported"]),
    principal: Principal,
  }),
  review: Schema.Struct({
    state: Schema.Literals(["accepted", "imported"]),
    principal: Principal,
  }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletedAt: Schema.NullOr(Timestamp),
}).check(Schema.makeFilter((r) => r.deletedAt !== null || r.highlighted || !!r.note.trim()));
export type AnnotationRecord = typeof AnnotationRecord.Type;

const CommandIdentity = { operationId: Id, annotationId: Id };
export const AnnotationCommand = Schema.Union([
  Schema.Struct({
    ...CommandIdentity,
    action: Schema.Literal("create"),
    resourceId: Id,
    capture: AnnotationCapture,
    note: Note,
    highlighted: Schema.Boolean,
  }),
  Schema.Struct({
    ...CommandIdentity,
    action: Schema.Literal("edit"),
    expectedRevision: PositiveInt,
    note: Note,
    highlighted: Schema.Boolean,
    correctedText: Schema.optionalKey(Schema.NullOr(Note)),
  }),
  Schema.Struct({
    ...CommandIdentity,
    action: Schema.Literals(["remove", "restore"]),
    expectedRevision: PositiveInt,
  }),
]);
export type AnnotationCommand = typeof AnnotationCommand.Type;

/** One immutable publication carries the record and its operation result. */
export const AnnotationCommit = Schema.Struct({
  formatVersion: Schema.Literal(1),
  command: Schema.Union([
    AnnotationCommand,
    Schema.Struct({
      action: Schema.Literal("import"),
      operationId: Id,
      annotationId: Id,
      sourceSnapshotHash: Hash,
    }),
  ]),
  record: AnnotationRecord,
  operation: Schema.Struct({
    operationId: Id,
    requestHash: Hash,
    principal: Principal,
    workspaceBinding: Hash,
    // The fingerprint, not the credential or bearer token.
    generation: Hash,
    committedAt: Timestamp,
    previousRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  }),
});
export type AnnotationCommit = typeof AnnotationCommit.Type;

export const DocumentResource = Schema.Struct({
  formatVersion: Schema.Literal(1),
  resourceId: Id,
  owner: ProjectAnnotationOwner,
  locator: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
export type DocumentResource = typeof DocumentResource.Type;

export const AnnotationMutation = Schema.Struct({
  outcome: Schema.Literals(["committed", "replayed", "conflict", "not-found"]),
  record: Schema.NullOr(AnnotationRecord),
});
export type AnnotationMutation = typeof AnnotationMutation.Type;
