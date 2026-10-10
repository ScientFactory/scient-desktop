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
 * Scient's two Markdown profiles.
 *
 * - `document`: authored Markdown. A single line break joins lines.
 * - `chat`: chat's message text, where single line breaks are kept.
 *
 * Both share CommonMark with GitHub tables, task lists, and alerts;
 * `$…$`/`$$…$$` math; fenced code; and Mermaid fences. Chat's own renderer
 * lists the same plugins in the same order, with chat-only directives between
 * the shared grammar and the line-break plugin (see `scientMarkdownProfiles`
 * parity test). The document page parses both bundle profiles as `document`
 * because a chat bundle already writes its hard breaks explicitly.
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
