import type { PluggableList } from "unified";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS as SHARED_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS as SHARED_REMARK_PLUGINS_WITH_BREAKS,
} from "@t3tools/shared/markdownPipeline";
import { remarkScientMath, remarkScientMathRefinements } from "../math/remarkScientMath";
import { remarkScientSingleDollarMath } from "../math/scientSingleDollarMath";

/**
 * Chat's Markdown grammar with Scient's math, as remark reads it. Chat renders with Words
 * (markdown/wordsHast.ts); this grammar decides which of its text is math
 * (math/scientMathRanges.ts), for chat, the composer and documents alike.
 */
function withScientMath(plugins: PluggableList): PluggableList {
  return [
    ...plugins.slice(0, 1),
    remarkScientMath,
    remarkScientSingleDollarMath,
    remarkScientMathRefinements,
    ...plugins.slice(1),
  ];
}

export const CHAT_MARKDOWN_REMARK_PLUGINS = withScientMath(SHARED_REMARK_PLUGINS);
export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = withScientMath(
  SHARED_REMARK_PLUGINS_WITH_BREAKS,
);
