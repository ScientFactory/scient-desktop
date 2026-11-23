/**
 * Chat's Markdown reading for Copy message's rich flavour (`messageCopyHtml.ts`): the tree
 * `ChatMarkdown` renders and `ChatMarkdown`'s own node readers, so copy and chat cannot drift.
 */
import type { Root } from "hast";
import type { ReactNode } from "react";

import {
  extractCodeBlock,
  extractFenceLanguage,
  extractPreCodeMeta,
  GITHUB_ALERT_PRESENTATIONS,
  nodeToPlainText,
} from "~/components/ChatMarkdown";
import { wordsHast, type MarkdownExtensions } from "~/markdown/wordsHast";
import { chatCodeBoxDirection } from "../bidi/chatCodeBoxDirection";
import type { ContentDirection, FixedContentDirection } from "../bidi/contentDirection";
import { isScientMathCodeClassName } from "../math/scientWordsMath";

const NO_EXTENSIONS: MarkdownExtensions = {};

/**
 * Chat's sanitized tree for one message, with chat's math and the message's
 * direction, as `ChatMarkdown` builds it.
 */
export function chatMarkdownHast(input: {
  readonly text: string;
  readonly lineBreaks: boolean;
  readonly parseRawHtml: boolean;
  readonly direction: FixedContentDirection;
  readonly requestedDirection: ContentDirection;
}): Root {
  return wordsHast(input.text, {
    math: true,
    breaks: input.lineBreaks,
    escapeHtml: !input.parseRawHtml,
    insights: false,
    extensions: NO_EXTENSIONS,
    scient: {
      math: true,
      contentDirection: input.direction,
      requestedContentDirection: input.requestedDirection,
    },
  });
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
