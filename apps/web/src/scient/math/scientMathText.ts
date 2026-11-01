import { createContext } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { remarkScientMathRefinements, type ScientMathRefinementOptions } from "./remarkScientMath";
import { protectScientMathTablePipes } from "./scientMathTablePipes";

export {
  findScientBackslashMathSpans,
  normalizeScientMathDelimiters,
  type ScientBackslashMathDelimiter,
  type ScientBackslashMathSpan,
} from "@scientfactory/conversation/chat-math-delimiters";
import { normalizeScientMathDelimiters } from "@scientfactory/conversation/chat-math-delimiters";

/** The compiler caches this normalization by the message text at its render call site. */
export function scientMathMarkdownText(text: string): string {
  return protectScientMathTablePipes(normalizeScientMathDelimiters(text), text);
}

type ScientRemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

/**
 * Backslash delimiters need original source to recover inline/display intent after the
 * length-preserving rewrite. Reuse the static plugin array for other messages to avoid common-path
 * allocation.
 */
export function scientMathRemarkPlugins(
  basePlugins: ScientRemarkPlugins,
  sourceText: string,
): ScientRemarkPlugins {
  if (!needsAuthoredMathIntent(sourceText)) {
    return basePlugins;
  }
  return basePlugins.map((plugin) =>
    plugin === remarkScientMathRefinements
      ? ([
          remarkScientMathRefinements,
          { sourceText } satisfies ScientMathRefinementOptions,
        ] satisfies ScientRemarkPlugins[number])
      : plugin,
  );
}

function needsAuthoredMathIntent(sourceText: string): boolean {
  return sourceText.includes("\\(") || sourceText.includes("\\[") || sourceText.includes("|");
}

/** Messages without authored math intent retain the shared plugin array. */
export function scientMathRemarkPluginsForMessage(
  basePlugins: ScientRemarkPlugins,
  sourceText: string,
): ScientRemarkPlugins {
  const needsAuthoredIntent = needsAuthoredMathIntent(sourceText);
  return needsAuthoredIntent ? scientMathRemarkPlugins(basePlugins, sourceText) : basePlugins;
}

/**
 * The message as authored, before delimiter normalization. It changes on every streamed
 * token, so it sits apart from the chat Markdown renderer context and only math reads it.
 */
export const ScientAuthoredMathTextContext = createContext("");

/** A rendered Markdown node's source position, as react-markdown reports it. */
interface MarkdownSourcePositionNode {
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
}

/**
 * The authored source of a math node, so Find can index the token the user
 * wrote. Math normalization preserves offsets; without a position the
 * normalized TeX stands in.
 */
export function authoredMathNodeSource(
  node: MarkdownSourcePositionNode | undefined,
  authoredText: string,
  tex: string,
): string {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  return start !== undefined && end !== undefined ? authoredText.slice(start, end) : tex;
}
