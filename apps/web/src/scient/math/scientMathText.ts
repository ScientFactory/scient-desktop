import { useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { remarkScientMathRefinements, type ScientMathRefinementOptions } from "./remarkScientMath";

export {
  findScientBackslashMathSpans,
  normalizeScientMathDelimiters,
  type ScientBackslashMathDelimiter,
  type ScientBackslashMathSpan,
} from "@scientfactory/conversation/chat-math-delimiters";
import { normalizeScientMathDelimiters } from "@scientfactory/conversation/chat-math-delimiters";

/** Memoized per message text, since streaming re-renders the same string repeatedly. */
export function useScientMathMarkdownText(text: string): string {
  return useMemo(() => normalizeScientMathDelimiters(text), [text]);
}

type ScientRemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

/**
 * The remark plugins for one message. When the message uses backslash math
 * delimiters, the refinement plugin needs the original text to recover each
 * pair's inline-versus-display intent (the length-preserving rewrite turns
 * both into `$$`); every other message keeps the shared static array, so the
 * common path allocates nothing.
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
  return sourceText.includes("\\(") || sourceText.includes("\\[");
}

/** `scientMathRemarkPlugins`, memoized for a rendered message. */
export function useScientMathRemarkPlugins(
  basePlugins: ScientRemarkPlugins,
  sourceText: string,
): ScientRemarkPlugins {
  const needsAuthoredIntent = needsAuthoredMathIntent(sourceText);
  return useMemo(
    () => (needsAuthoredIntent ? scientMathRemarkPlugins(basePlugins, sourceText) : basePlugins),
    [basePlugins, needsAuthoredIntent, sourceText],
  );
}
