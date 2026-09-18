import { DEFAULT_CONTENT_DIRECTION, type ContentDirection } from "@t3tools/contracts/settings";

export type { ContentDirection } from "@t3tools/contracts/settings";
export type FixedContentDirection = Exclude<ContentDirection, "auto">;

const RTL_STRONG_CHARACTER =
  /(?:\p{Script_Extensions=Arabic}|\p{Script_Extensions=Hebrew}|\p{Script_Extensions=Syriac}|\p{Script_Extensions=Thaana}|\p{Script_Extensions=Nko}|\p{Script_Extensions=Adlam})/u;
const LTR_STRONG_CHARACTER =
  /(?:\p{Script_Extensions=Latin}|\p{Script_Extensions=Greek}|\p{Script_Extensions=Cyrillic}|\p{Script_Extensions=Armenian}|\p{Script_Extensions=Georgian}|\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul})/u;

const MARKDOWN_CODE_BLOCK = /(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g;
const MARKDOWN_INLINE_CODE = /`[^`\n]*`/g;
const MARKDOWN_LINK_DESTINATION = /\]\([^)]*\)/g;
const MARKDOWN_AUTOLINK = /<(?:https?:\/\/|mailto:)[^>]+>/gi;
const MARKDOWN_DISPLAY_MATH = /\$\$[\s\S]*?(?:\$\$|$)/g;
const MARKDOWN_BRACKET_MATH = /\\\[[\s\S]*?(?:\\\]|$)/g;
const MARKDOWN_PAREN_MATH = /\\\([\s\S]*?(?:\\\)|$)/g;
const MARKDOWN_INLINE_MATH = /(?<!\\)\$(?!\$)(?:\\.|[^$\n]){1,1000}(?<!\\)\$/g;
const TABLE_LITERAL_TEX = /\$(?=[^$\n]*\\[A-Za-z]{2,})[^$\n]{1,1000}\$/g;
const TABLE_TEX_COMMAND = /\\[A-Za-z]{2,}(?:\s*\{[^{}\n]*\})?/g;
const TABLE_TECHNICAL_IDENTIFIER =
  /(?<![\p{L}\p{N}])(?:[A-Z]{2,5}[+-]?|[A-Za-z]+\d+[A-Za-z0-9+-]*|\d+[A-Za-z]+[A-Za-z0-9+-]*)(?![\p{L}\p{N}])/gu;
const CONTEXTUAL_PROSE_MAX_RTL_PERCENT_FOR_LTR = 30;
const CONTEXTUAL_PROSE_MIN_RTL_PERCENT_FOR_RTL = 45;
const MIXED_TABLE_CELL_LTR_THRESHOLD_PERCENT = 70;

const RTL_FLOW_ARROW_REPLACEMENTS: Readonly<Record<string, string>> = {
  "→": "←",
  "⇒": "⇐",
  "⟶": "⟵",
  "⟹": "⟸",
};
const STANDALONE_RTL_FLOW_ARROW = /(^|\s)(→|⇒|⟶|⟹)(?=\s|$)/gu;
const ASCII_TECHNICAL_TOKEN = /[A-Za-z0-9][A-Za-z0-9_./:+-]*$/u;
const ASCII_TECHNICAL_TOKEN_START = /^[A-Za-z0-9][A-Za-z0-9_./:+-]*/u;

/** Fences whose contents are copyable prose rather than source code. */
const PLAIN_TEXT_FENCE_LANGUAGES = new Set(["text", "plaintext", "txt"]);

export interface RtlFlowArrowSpan {
  readonly end: number;
  readonly replacement: string;
  readonly start: number;
}

function isFixedContentDirection(direction: ContentDirection): direction is "rtl" | "ltr" {
  return direction !== "auto";
}

function isPlainTextFence(language: string, fenceTitle: string | null): boolean {
  return fenceTitle === null && PLAIN_TEXT_FENCE_LANGUAGES.has(language.toLowerCase());
}

/** Reads an explicit direction marker from fenced-code metadata, when present. */
export function resolveFenceDirection(meta: string | null | undefined): ContentDirection | null {
  if (!meta) return null;
  const match = /(?:^|\s)dir=(auto|rtl|ltr)(?=\s|$)/i.exec(meta);
  return (match?.[1]?.toLowerCase() as ContentDirection | undefined) ?? null;
}

function containsStrongRtl(text: string): boolean {
  return RTL_STRONG_CHARACTER.test(text);
}

function containsStrongLtr(text: string): boolean {
  return LTR_STRONG_CHARACTER.test(text);
}

export interface StrongScriptCounts {
  readonly rtl: number;
  readonly ltr: number;
}

export type DirectionEvidence = FixedContentDirection | "ambiguous";

export function countStrongScripts(text: string): StrongScriptCounts {
  let rtl = 0;
  let ltr = 0;

  for (const character of text) {
    if (RTL_STRONG_CHARACTER.test(character)) rtl += 1;
    else if (LTR_STRONG_CHARACTER.test(character)) ltr += 1;
  }

  return { rtl, ltr };
}

/**
 * Counts prose that can reliably describe a table's reading order. Scientific
 * identifiers and literal TeX are cell content, not evidence that the table's
 * column structure is LTR. Individual cells still use the unfiltered counter.
 */
export function countTableStrongScripts(text: string): StrongScriptCounts {
  return countStrongScripts(
    text
      .replace(TABLE_LITERAL_TEX, " ")
      .replace(TABLE_TEX_COMMAND, " ")
      .replace(TABLE_TECHNICAL_IDENTIFIER, " "),
  );
}

function resolveStrongScriptDirection(counts: StrongScriptCounts): FixedContentDirection | null {
  if (counts.rtl === 0 && counts.ltr === 0) return null;
  return counts.rtl >= counts.ltr ? "rtl" : "ltr";
}

function stripMarkdownTechnicalContent(markdown: string): string {
  return markdown
    .replace(MARKDOWN_CODE_BLOCK, " ")
    .replace(MARKDOWN_INLINE_CODE, " ")
    .replace(MARKDOWN_DISPLAY_MATH, " ")
    .replace(MARKDOWN_BRACKET_MATH, " ")
    .replace(MARKDOWN_PAREN_MATH, " ")
    .replace(MARKDOWN_INLINE_MATH, (literal) => {
      const content = literal.slice(1, -1);
      return !/\s/u.test(content) || /[\\_^=+*/<>→←⇒⇐⟶⟵⟹⟸]/u.test(content) ? " " : literal;
    })
    .replace(MARKDOWN_LINK_DESTINATION, "]")
    .replace(MARKDOWN_AUTOLINK, " ");
}

function markdownProseBlockCounts(prose: string): StrongScriptCounts[] {
  return prose
    .split(/\n\s*\n+/u)
    .map((block) =>
      /^\s*\|?.+\|.+\|?\s*$/mu.test(block) &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/mu.test(block)
        ? countTableStrongScripts(block)
        : countStrongScripts(block),
    )
    .filter((counts) => counts.rtl > 0 || counts.ltr > 0);
}

/** Returns the strongest direction signal in Markdown prose, if one exists. */
export function resolveMarkdownDirectionHint(markdown: string): FixedContentDirection | null {
  return resolveStrongScriptDirection(countStrongScripts(stripMarkdownTechnicalContent(markdown)));
}

/**
 * Resolves one stable base direction for a complete Markdown message.
 *
 * Automatic mode is intentionally resolved here instead of delegated to
 * `dir="auto"` on every rendered element. The browser's auto mode chooses a
 * direction independently for each block, so a Hebrew list beginning with an
 * English abbreviation can otherwise become an LTR list inside an RTL reply.
 */
export function resolveMarkdownDirection(
  markdown: string,
  requestedDirection: ContentDirection,
  fallbackDirection: FixedContentDirection = "ltr",
): FixedContentDirection {
  if (isFixedContentDirection(requestedDirection)) {
    return requestedDirection;
  }

  const prose = stripMarkdownTechnicalContent(markdown);
  const blockCounts = markdownProseBlockCounts(prose);
  const aggregateCounts = blockCounts.reduce(
    (total, counts) => ({ ltr: total.ltr + counts.ltr, rtl: total.rtl + counts.rtl }),
    { ltr: 0, rtl: 0 },
  );
  return resolveStructuredDirectionFromCounts(blockCounts, aggregateCounts, fallbackDirection);
}

/**
 * Resolves the message base during a streaming response.
 *
 * Automatic mode uses a stable seed for the lifetime of one assistant
 * message. The preceding user message is preferred because the first model
 * token is often an English label or acronym. Completed messages are resolved
 * from their full text, preserving the normal dominant-language rule.
 */
export function resolveStreamingMarkdownDirection(input: {
  readonly markdown: string;
  readonly requestedDirection: ContentDirection;
  readonly messageDirectionHint?: FixedContentDirection | null | undefined;
  readonly frozenDirection?: FixedContentDirection | null | undefined;
  readonly isStreaming: boolean;
}): FixedContentDirection {
  if (isFixedContentDirection(input.requestedDirection)) {
    return input.requestedDirection;
  }
  if (!input.isStreaming) {
    return resolveMarkdownDirection(
      input.markdown,
      "auto",
      input.frozenDirection ?? input.messageDirectionHint ?? "ltr",
    );
  }
  return (
    input.frozenDirection ??
    input.messageDirectionHint ??
    resolveMarkdownDirectionHint(input.markdown) ??
    "ltr"
  );
}

/**
 * Resolves a paragraph or complete list against its surrounding message.
 * Locally decisive prose wins; a mixture between 30% and 45% RTL follows the
 * message so short terms from the other script cannot reverse a coherent block.
 */
export function resolveProseBlockDirection(
  text: string,
  baseDirection: FixedContentDirection,
): FixedContentDirection {
  return resolveProseBlockDirectionFromCounts(countStrongScripts(text), baseDirection);
}

export function resolveProseBlockDirectionFromCounts(
  counts: StrongScriptCounts,
  baseDirection: FixedContentDirection,
): FixedContentDirection {
  const evidence = resolveProseDirectionEvidenceFromCounts(counts);
  return evidence === "ambiguous" ? baseDirection : evidence;
}

/** Classifies one prose region without silently choosing its surrounding flow. */
function resolveProseDirectionEvidenceFromCounts(counts: StrongScriptCounts): DirectionEvidence {
  const { rtl, ltr } = counts;
  const total = rtl + ltr;
  if (total === 0) return "ambiguous";
  if (rtl * 100 >= total * CONTEXTUAL_PROSE_MIN_RTL_PERCENT_FOR_RTL) return "rtl";
  if (rtl * 100 <= total * CONTEXTUAL_PROSE_MAX_RTL_PERCENT_FOR_LTR) return "ltr";
  return "ambiguous";
}

/**
 * Resolves a complete document from both its language balance and its semantic
 * blocks. A decisive whole-document signal wins. When the aggregate falls in
 * the mixed band, paragraphs/lists/sections vote once each instead of letting
 * one long identifier-heavy block dominate the entire document.
 */
export function resolveStructuredDirectionFromCounts(
  blockCounts: ReadonlyArray<StrongScriptCounts>,
  aggregateCounts: StrongScriptCounts,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  const aggregateEvidence = resolveProseDirectionEvidenceFromCounts(aggregateCounts);
  if (aggregateEvidence !== "ambiguous") return aggregateEvidence;

  let rtlBlocks = 0;
  let ltrBlocks = 0;
  let firstDecisiveDirection: FixedContentDirection | null = null;
  for (const counts of blockCounts) {
    const evidence = resolveProseDirectionEvidenceFromCounts(counts);
    if (evidence === "ambiguous") continue;
    firstDecisiveDirection ??= evidence;
    if (evidence === "rtl") rtlBlocks += 1;
    else ltrBlocks += 1;
  }
  if (rtlBlocks > ltrBlocks) return "rtl";
  if (ltrBlocks > rtlBlocks) return "ltr";
  return firstDecisiveDirection ?? fallbackDirection;
}

/** Resolves a heading from the section it labels, then from its own prose. */
export function resolveHeadingSectionDirectionFromCounts(
  headingCounts: StrongScriptCounts,
  sectionCounts: StrongScriptCounts,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  const headingDirection = resolveProseBlockDirectionFromCounts(headingCounts, fallbackDirection);
  return resolveProseBlockDirectionFromCounts(sectionCounts, headingDirection);
}

/**
 * Resolves a direction for a structural group such as one complete list.
 * The same contextual classifier is used for prose blocks, but the complete
 * group is counted once so its children never receive competing directions.
 */
export function resolveAggregateDirection(
  text: string,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  return resolveAggregateDirectionFromCounts(countStrongScripts(text), fallbackDirection);
}

export function resolveAggregateDirectionFromCounts(
  counts: StrongScriptCounts,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  return resolveProseBlockDirectionFromCounts(counts, fallbackDirection);
}

/**
 * Resolves a structural direction from the dominant script across a complete
 * region. Unlike list direction, a minority-language cell must not reverse an
 * otherwise dominant table. A tie has no dominant script and keeps the
 * surrounding direction.
 */
export function resolveDominantDirection(
  text: string,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  return resolveDominantDirectionFromCounts(countStrongScripts(text), fallbackDirection);
}

export function resolveDominantDirectionFromCounts(
  counts: StrongScriptCounts,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  if (counts.rtl > counts.ltr) return "rtl";
  if (counts.ltr > counts.rtl) return "ltr";
  return fallbackDirection;
}

/**
 * Resolves text flow inside one table cell independently from table layout.
 * A mixed cell becomes LTR only when at least 70% of its strong characters are
 * LTR; otherwise RTL wins. Pure-script cells keep their script direction, and
 * neutral cells inherit the table's automatic content direction.
 */
export function resolveTableCellDirection(
  text: string,
  automaticTableDirection: FixedContentDirection,
): FixedContentDirection {
  return resolveTableCellDirectionFromCounts(countStrongScripts(text), automaticTableDirection);
}

export function resolveTableCellDirectionFromCounts(
  counts: StrongScriptCounts,
  automaticTableDirection: FixedContentDirection,
): FixedContentDirection {
  if (counts.rtl > 0 && counts.ltr > 0) {
    const total = counts.rtl + counts.ltr;
    return counts.ltr * 100 >= total * MIXED_TABLE_CELL_LTR_THRESHOLD_PERCENT ? "ltr" : "rtl";
  }
  return resolveDominantDirectionFromCounts(counts, automaticTableDirection);
}

/**
 * Resolves one visual alignment direction for a complete table column.
 * Ordinary prose is authoritative when present. Identifier-only columns use
 * their raw script as a fallback, while neutral columns follow the table.
 * Cell-level `dir` remains separate so mixed punctuation keeps its local flow.
 */
export function resolveTableColumnDirectionFromCounts(
  proseCounts: StrongScriptCounts,
  rawCounts: StrongScriptCounts,
  tableDirection: FixedContentDirection,
): FixedContentDirection {
  if (proseCounts.rtl > 0 || proseCounts.ltr > 0) {
    return resolveDominantDirectionFromCounts(proseCounts, tableDirection);
  }
  return resolveDominantDirectionFromCounts(rawCounts, tableDirection);
}

/**
 * Normalizes only obvious right-flow arrows in a message whose base direction
 * is RTL. The renderer additionally excludes technical and non-prose nodes.
 *
 * Arrow glyphs are not Unicode-mirrored by `dir="rtl"`, but arrows also carry
 * scientific meaning. Requiring whitespace boundaries and nearby RTL text
 * keeps this presentation fallback conservative; callers must still exclude
 * code, links, and other technical content before invoking it.
 */
export function findRtlFlowArrowSpans(text: string): ReadonlyArray<RtlFlowArrowSpan> {
  if (!containsStrongRtl(text)) return [];

  const spans: RtlFlowArrowSpan[] = [];
  for (const match of text.matchAll(STANDALONE_RTL_FLOW_ARROW)) {
    const prefix = match[1] ?? "";
    const arrow = match[2] ?? "";
    const arrowOffset = match.index + prefix.length;
    const beforeArrow = text.slice(0, arrowOffset);
    const afterArrow = text.slice(arrowOffset + arrow.length);
    const leftToken = ASCII_TECHNICAL_TOKEN.exec(beforeArrow.trimEnd())?.[0];
    const rightToken = ASCII_TECHNICAL_TOKEN_START.exec(afterArrow.trimStart())?.[0];

    // A Latin/number token on both sides is much more likely to be a
    // formula, reaction, or identifier relationship than a prose flow.
    if (leftToken && rightToken) continue;

    // Do not reinterpret an arrow inside simple inline math delimiters.
    const before = text.slice(0, arrowOffset);
    let dollarOpen = false;
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] === "$" && before[index - 1] !== "\\") {
        dollarOpen = !dollarOpen;
      }
    }
    if (
      dollarOpen ||
      before.lastIndexOf("\\(") > before.lastIndexOf("\\)") ||
      before.lastIndexOf("\\[") > before.lastIndexOf("\\]")
    ) {
      continue;
    }

    spans.push({
      end: arrowOffset + arrow.length,
      replacement: RTL_FLOW_ARROW_REPLACEMENTS[arrow] ?? arrow,
      start: arrowOffset,
    });
  }
  return spans;
}

export function normalizeRtlFlowArrows(text: string): string {
  const spans = findRtlFlowArrowSpans(text);
  if (spans.length === 0) return text;
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    output += text.slice(cursor, span.start);
    output += span.replacement;
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

/**
 * Resolves the direction of an unlabelled/plain-text copy box.
 *
 * This deliberately has a much narrower job than message direction. It does
 * not inspect adjacent messages, strip paths, score words, or retain a
 * streaming history. Source-code fences always remain LTR; plain text uses
 * its own content when unambiguous and the conversation mode only for mixed
 * content.
 */
export function resolvePlainTextBoxDirection(input: {
  readonly code: string;
  readonly language: string;
  readonly fenceTitle: string | null;
  readonly fenceDirection?: ContentDirection | null;
  readonly conversationDirection: ContentDirection;
  readonly isStreaming: boolean;
}): "auto" | "rtl" | "ltr" {
  if (!isPlainTextFence(input.language, input.fenceTitle)) {
    return "ltr";
  }

  if (input.fenceDirection !== undefined && input.fenceDirection !== null) {
    return input.fenceDirection;
  }

  // While text is arriving, a fixed conversation mode gives the block a
  // stable initial direction. The completed block is resolved once from its
  // final contents below; it never runs a per-token direction history.
  if (input.isStreaming && isFixedContentDirection(input.conversationDirection)) {
    return input.conversationDirection;
  }

  const hasRtl = containsStrongRtl(input.code);
  const hasLtr = containsStrongLtr(input.code);
  if (hasRtl && !hasLtr) return "rtl";
  if (!hasRtl && hasLtr) return "ltr";
  if (!hasRtl && !hasLtr) return "ltr";
  return input.conversationDirection === DEFAULT_CONTENT_DIRECTION
    ? "auto"
    : input.conversationDirection;
}
