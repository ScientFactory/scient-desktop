import type { Options as ReactMarkdownOptions } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";
import { remarkNormalizeListItemIndentation } from "@t3tools/shared/markdownListIndentation";
import { remarkKeepWindowsPathDestinations } from "@t3tools/shared/markdownPipeline";
import { remarkScientMath, remarkScientMathRefinements } from "../math/remarkScientMath";
import { remarkScientSingleDollarMath } from "../math/scientSingleDollarMath";

type RemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

/**
 * Document Markdown joins single line breaks; chat preserves them. Keep shared grammar/plugin order
 * aligned with chat's parity test. Document pages parse both profiles as document because chat
 * bundles already encode hard breaks explicitly.
 */
export type ScientMarkdownProfile = "document" | "chat";

export const SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS: RemarkPlugins = [
  remarkGfm,
  remarkScientMath,
  remarkScientSingleDollarMath,
  remarkScientMathRefinements,
  remarkKeepWindowsPathDestinations,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
];

const PROFILE_LINE_BREAK_PLUGINS = {
  document: [],
  chat: [remarkBreaks],
} satisfies Record<ScientMarkdownProfile, RemarkPlugins>;

/** The complete remark plugin list for one profile, outside chat's own directives. */
export function scientMarkdownRemarkPlugins(profile: ScientMarkdownProfile): RemarkPlugins {
  return [...SCIENT_MARKDOWN_GRAMMAR_REMARK_PLUGINS, ...PROFILE_LINE_BREAK_PLUGINS[profile]];
}
