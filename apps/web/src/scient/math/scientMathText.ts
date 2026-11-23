import type { PluggableList } from "unified";

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

type ScientRemarkPlugins = PluggableList;

/**
 * Backslash delimiters need original source to recover inline/display intent after the
 * length-preserving rewrite. Reuse the static plugin array for other messages to avoid common-path
 * allocation.
 */
function scientMathRemarkPlugins(
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
