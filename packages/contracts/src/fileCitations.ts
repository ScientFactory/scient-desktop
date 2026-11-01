import { PdfTarget } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";
import { AssistantCitation } from "./assistantCitations.ts";
import { EnvironmentId, ThreadId, NonNegativeInt } from "./baseSchemas.ts";

const Offset = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => [...value].every((character) => character.charCodeAt(0) >= 32)),
);
const WorkspaceRoot = Path.check(
  Schema.makeFilter(
    (value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\"),
  ),
);
const ComputeId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

/** A captured document quote, not a request to read a file or an assistant message. */
export const FileCitation = Schema.Struct({
  kind: Schema.Literal("file"),
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  cwd: WorkspaceRoot,
  path: Path,
  revision: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  origin: Schema.Literals(["saved", "draft"]),
  /** Exact UTF-16 source selections, distinct from rendered Markdown positions. */
  sourceSelection: Schema.optional(Schema.Literal(true)),
  /** Absent on existing Markdown citations. Math model positions are never source offsets. */
  latex: Schema.optional(
    Schema.Struct({
      rootRelativePath: Path,
      sourceHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
    }),
  ),
  // Source anchors in UTF-16 units. Unsupported fine mappings use enclosing
  // blocks; these are never MathLive positions or rendered-character offsets.
  sourceStart: Offset,
  sourceEnd: Offset,
  startLine: Offset.check(Schema.isGreaterThan(0)),
  endLine: Offset.check(Schema.isGreaterThan(0)),
  // Source selections: raw offsets. Rendered Markdown: ProseMirror positions.
  // Rendered LaTeX: offsets in the captured quote, never MathLive positions.
  from: Offset,
  to: Offset,
  text: AssistantCitation.fields.text,
  comment: AssistantCitation.fields.comment,
  prefix: AssistantCitation.fields.prefix,
  suffix: AssistantCitation.fields.suffix,
}).check(
  Schema.makeFilter(
    (value) =>
      value.sourceEnd > value.sourceStart &&
      value.to > value.from &&
      value.endLine >= value.startLine &&
      value.text.trim().length > 0,
  ),
);
export type FileCitation = typeof FileCitation.Type;

/**
 * A quote from a PDF: where it is (the shared PDF target, which a saved
 * annotation will reuse) and the user's optional comment. The quoted text is
 * the target's own; it is not copied a second time.
 */
export const PdfCitation = Schema.Struct({
  kind: Schema.Literal("pdf"),
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  target: PdfTarget,
  comment: AssistantCitation.fields.comment,
});
export type PdfCitation = typeof PdfCitation.Type;

/**
 * Text quoted from a run or a notebook cell, or the run or cell itself. Its place is what lets the
 * agent read the rest and a click return to it; positions are in the rendered text, as for an
 * assistant quote, and go only as far as finding the quote again.
 */
export const ComputeCitation = Schema.Struct({
  kind: Schema.Literal("compute"),
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  cwd: WorkspaceRoot,
  place: Schema.Union([
    Schema.TaggedStruct("run", {
      sessionId: ComputeId,
      executionId: ComputeId,
      /** The script or notebook it ran from; a Console's runs have none. */
      path: Schema.NullOr(Path),
    }),
    Schema.TaggedStruct("cell", {
      path: Path,
      cellId: ComputeId,
      number: Offset.check(Schema.isGreaterThan(0)),
    }),
    /** A file run with no session, such as C or Java. */
    Schema.TaggedStruct("file-run", { runId: ComputeId, path: Path }),
  ]),
  text: AssistantCitation.fields.text,
  comment: AssistantCitation.fields.comment,
  start: AssistantCitation.fields.start,
  end: AssistantCitation.fields.end,
  prefix: AssistantCitation.fields.prefix,
  suffix: AssistantCitation.fields.suffix,
}).check(Schema.makeFilter((value) => value.end > value.start && value.text.trim().length > 0));
export type ComputeCitation = typeof ComputeCitation.Type;

export type ComposerCitation = AssistantCitation | FileCitation | PdfCitation | ComputeCitation;

export function isFileCitation(citation: ComposerCitation): citation is FileCitation {
  return "kind" in citation && citation.kind === "file";
}

export function isPdfCitation(citation: ComposerCitation): citation is PdfCitation {
  return "kind" in citation && citation.kind === "pdf";
}

export function isComputeCitation(citation: ComposerCitation): citation is ComputeCitation {
  return "kind" in citation && citation.kind === "compute";
}

/** The quoted text of a PDF citation, across its pages. */
export function pdfCitationText(citation: PdfCitation): string {
  return citation.target.selector.pages.map((page) => page.quote).join("");
}
