import { DEFAULT_CONTENT_DIRECTION, type ContentDirection } from "@t3tools/contracts/settings";

export { DEFAULT_CONTENT_DIRECTION } from "@t3tools/contracts/settings";
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

/** Fences whose contents are copyable prose rather than source code. */
const PLAIN_TEXT_FENCE_LANGUAGES = new Set(["text", "plaintext", "txt"]);

export function isFixedContentDirection(direction: ContentDirection): direction is "rtl" | "ltr" {
  return direction !== "auto";
}

export function isPlainTextFence(language: string, fenceTitle: string | null): boolean {
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

function countStrongScripts(text: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;

  for (const character of text) {
    if (RTL_STRONG_CHARACTER.test(character)) rtl += 1;
    else if (LTR_STRONG_CHARACTER.test(character)) ltr += 1;
  }

  return { rtl, ltr };
}

function stripMarkdownTechnicalContent(markdown: string): string {
  return markdown
    .replace(MARKDOWN_CODE_BLOCK, " ")
    .replace(MARKDOWN_INLINE_CODE, " ")
    .replace(MARKDOWN_LINK_DESTINATION, "]")
    .replace(MARKDOWN_AUTOLINK, " ");
}

/** Returns the strongest direction signal in Markdown prose, if one exists. */
export function resolveMarkdownDirectionHint(markdown: string): FixedContentDirection | null {
  const { rtl, ltr } = countStrongScripts(stripMarkdownTechnicalContent(markdown));
  if (rtl === 0 && ltr === 0) return null;
  return rtl >= ltr ? "rtl" : "ltr";
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
): FixedContentDirection {
  if (isFixedContentDirection(requestedDirection)) {
    return requestedDirection;
  }

  return resolveMarkdownDirectionHint(markdown) ?? "ltr";
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
    return resolveMarkdownDirection(input.markdown, "auto");
  }
  return (
    input.frozenDirection ??
    input.messageDirectionHint ??
    resolveMarkdownDirectionHint(input.markdown) ??
    "ltr"
  );
}

/**
 * Gives a prose block an explicit local direction only when it is unambiguous.
 * Mixed blocks inherit the message base so leading English tokens cannot flip
 * an otherwise Hebrew sentence, list item, or table cell.
 */
export function resolveProseBlockDirection(
  text: string,
  baseDirection: FixedContentDirection,
): FixedContentDirection {
  const { rtl, ltr } = countStrongScripts(text);
  if (rtl > 0 && ltr === 0) return "rtl";
  if (ltr > 0 && rtl === 0) return "ltr";
  return baseDirection;
}

/**
 * Resolves a direction for a structural group such as one complete list.
 * Any RTL prose makes the group RTL; otherwise any LTR prose makes it LTR.
 * This deliberately does not classify each child independently.
 */
export function resolveAggregateDirection(
  text: string,
  fallbackDirection: FixedContentDirection,
): FixedContentDirection {
  const { rtl, ltr } = countStrongScripts(text);
  if (rtl > 0) return "rtl";
  if (ltr > 0) return "ltr";
  return fallbackDirection;
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
