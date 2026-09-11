import * as Schema from "effect/Schema";
import { AssistantCitation } from "./assistantCitations.ts";
import { EnvironmentId, ThreadId, NonNegativeInt } from "./baseSchemas.ts";

const Offset = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => [...value].every((character) => character.charCodeAt(0) >= 32)),
);

/** A captured Markdown quote, not a request to read a file or an assistant message. */
export const FileCitation = Schema.Struct({
  kind: Schema.Literal("file"),
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  cwd: Path.check(
    Schema.makeFilter(
      (value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\"),
    ),
  ),
  path: Path,
  revision: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  origin: Schema.Literals(["saved", "draft"]),
  // The enclosing Markdown source blocks, in UTF-16 units. Not an exact
  // character mapping of rendered text back through Markdown delimiters.
  sourceStart: Offset,
  sourceEnd: Offset,
  startLine: Offset.check(Schema.isGreaterThan(0)),
  endLine: Offset.check(Schema.isGreaterThan(0)),
  // ProseMirror document positions are valid only for this exact revision.
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
export type ComposerCitation = AssistantCitation | FileCitation;

export function isFileCitation(citation: ComposerCitation): citation is FileCitation {
  return "kind" in citation && citation.kind === "file";
}
