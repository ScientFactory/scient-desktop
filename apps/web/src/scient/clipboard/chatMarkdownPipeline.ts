/**
 * Chat's Markdown reading, without its React components, for the Copy message
 * button's rich flavour (`messageCopyHtml.ts`). The pipeline is the one
 * `ChatMarkdown` mounts; the node readers are `ChatMarkdown`'s own, exported
 * through a marked seam, so the copy and the rendered message cannot drift.
 */
import type { ReactNode } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import {
  extractCodeBlock,
  extractFenceLanguage,
  extractPreCodeMeta,
  GITHUB_ALERT_PRESENTATIONS,
  nodeToPlainText,
} from "~/components/ChatMarkdown";
import { chatCodeBoxDirection } from "../bidi/chatCodeBoxDirection";
import type { ContentDirection } from "../bidi/contentDirection";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "../markdown/scientMarkdownPipeline";
import { isScientMathCodeClassName } from "../math/remarkScientMath";
import { normalizeScientMathDelimiters, scientMathRemarkPlugins } from "../math/scientMathText";

/**
 * Chat's math text normalization and remark and rehype steps for one message,
 * without its React components. Direction runs after these, as in `ChatMarkdown`.
 */
export function chatMarkdownPipeline(input: {
  readonly text: string;
  readonly lineBreaks: boolean;
  readonly parseRawHtml: boolean;
}): {
  readonly text: string;
  readonly remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  readonly rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
} {
  return {
    text: normalizeScientMathDelimiters(input.text),
    remarkPlugins: scientMathRemarkPlugins(
      input.lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS,
      input.text,
    ),
    rehypePlugins: input.parseRawHtml
      ? CHAT_MARKDOWN_REHYPE_PLUGINS
      : CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
  };
}

/** Chat's plain text of rendered Markdown children, as its math renderers read TeX. */
export function chatMarkdownNodeText(node: ReactNode): string {
  return nodeToPlainText(node);
}

/** The title chat shows for a GitHub alert kind, or null when it is not an alert. */
export function chatMarkdownAlertLabel(kind: unknown): string | null {
  return GITHUB_ALERT_PRESENTATIONS[String(kind ?? "")]?.label ?? null;
}

/**
 * `chatCodeBoxDirection` for a rendered `pre` node of a completed message;
 * null when it is not a fenced code block or is display math.
 */
export function chatMarkdownCodeBoxDirection(
  node: unknown,
  children: ReactNode,
  conversationDirection: ContentDirection,
): "auto" | "rtl" | "ltr" | null {
  const codeBlock = extractCodeBlock(children);
  if (!codeBlock || isScientMathCodeClassName(codeBlock.className)) return null;
  return chatCodeBoxDirection({
    code: codeBlock.code,
    language: extractFenceLanguage(codeBlock.className),
    fenceMeta: extractPreCodeMeta(node),
    conversationDirection,
    isStreaming: false,
  });
}
