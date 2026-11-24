import type { Options as ReactMarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";

import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";
import { remarkNormalizeListItemIndentation } from "@t3tools/shared/markdownListIndentation";
import {
  remarkKeepAutolinkSuffixes,
  remarkKeepWindowsPathDestinations,
} from "@t3tools/shared/markdownPipeline";
import { remarkScientMath, remarkScientMathRefinements } from "../math/remarkScientMath";
import { remarkScientSingleDollarMath } from "../math/scientSingleDollarMath";

type RemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

/**
 * The document page's Markdown grammar (chat renders with Words). Single line breaks join, as in
 * documents; a chat bundle already writes its hard breaks explicitly.
 */
export const SCIENT_DOCUMENT_REMARK_PLUGINS: RemarkPlugins = [
  remarkGfm,
  remarkScientMath,
  remarkScientSingleDollarMath,
  remarkScientMathRefinements,
  remarkKeepAutolinkSuffixes,
  remarkKeepWindowsPathDestinations,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
];
