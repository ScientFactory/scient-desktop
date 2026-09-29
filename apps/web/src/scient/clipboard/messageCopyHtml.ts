/**
 * Rich `text/html` for the Copy message button when a message contains
 * right-to-left text, so a paste into Word, Google Docs, or Pages keeps each
 * paragraph's direction. Other messages keep their Markdown-only copy.
 *
 * The HTML is rendered from the message's Markdown, the same text the plain
 * flavour carries, with the chat's Markdown and direction pipeline. The live
 * row is not the source: it may be unmounted by the virtualized timeline, and
 * a collapsed details block has no body in the DOM. When the row is mounted,
 * its displayed direction is reused as the message direction.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { defaultUrlTransform, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { getClientSettings } from "~/hooks/useSettings";
import { renderedMarkdownClipboardHtml } from "../../markdown-clipboard";
import { resolveMarkdownDirection, type FixedContentDirection } from "../bidi/contentDirection";
import { rehypeScientBidi } from "../bidi/rehypeScientBidi";
import { remarkScientMath } from "../math/remarkScientMath";
import { remarkScientSingleDollarMath } from "../math/scientSingleDollarMath";
import { hasStrongRtl } from "./clipboardDirection";

/** Marks the button's HTML so Scient's own editors can keep pasting its Markdown. */
const MESSAGE_COPY_ATTRIBUTE = "data-scient-message-copy";
const MESSAGE_COPY_PATTERN = new RegExp(`<div\\s[^>]*\\b${MESSAGE_COPY_ATTRIBUTE}\\b`, "u");
const MESSAGE_ROW_SELECTOR = '[data-timeline-row-kind="message"][data-message-id]';
const MEDIA_SELECTOR = "audio, canvas, embed, iframe, object, picture > source, video";
/** The chat's raw HTML handling for assistant messages, with the stricter default schema. */
const RAW_HTML_REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, defaultSchema]] satisfies NonNullable<
  Options["rehypePlugins"]
>;

export function isScientMessageCopyHtml(html: string): boolean {
  return MESSAGE_COPY_PATTERN.test(html);
}

function isMessageRow(element: Element, messageId: string): boolean {
  return (
    element.matches(MESSAGE_ROW_SELECTOR) && element.getAttribute("data-message-id") === messageId
  );
}

/**
 * The rendered Markdown of a timeline message, when it is mounted. The button
 * can sit in the message's own row or in a separate metadata row, so the
 * search widens from the button until a scope holds that message's row.
 */
function findRenderedMessage(anchor: Element, messageId: string): Element | null {
  for (let scope: Element | null = anchor; scope; scope = scope.parentElement) {
    const row = isMessageRow(scope, messageId)
      ? scope
      : [...scope.querySelectorAll(MESSAGE_ROW_SELECTOR)].find((candidate) =>
          isMessageRow(candidate, messageId),
        );
    if (row) {
      return (
        row.querySelector("[data-user-message-body] .chat-markdown") ??
        row.querySelector(".chat-markdown")
      );
    }
  }
  return null;
}

function fixedDirection(value: string | null | undefined): FixedContentDirection | null {
  return value === "rtl" || value === "ltr" ? value : null;
}

interface MessageMarkdownProfile {
  /** Single newlines are line breaks, as in user messages. */
  readonly lineBreaks: boolean;
  /** Raw HTML is parsed and sanitized, as in assistant messages. */
  readonly parseRawHtml: boolean;
}

/**
 * Renders Markdown into an inert document: nothing in it loads, runs, or
 * reaches the visible timeline. Image sources are dropped before rendering.
 */
function renderMarkdown(
  markdown: string,
  profile: MessageMarkdownProfile,
  direction: FixedContentDirection,
  requestedDirection: ReturnType<typeof getClientSettings>["contentDirection"],
): Element {
  const inert = document.implementation.createHTMLDocument("");
  const host = inert.createElement("div");
  inert.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        createElement(
          ReactMarkdown,
          {
            remarkPlugins: [
              remarkGfm,
              remarkScientMath,
              remarkScientSingleDollarMath,
              ...(profile.lineBreaks ? [remarkBreaks] : []),
            ],
            rehypePlugins: [
              ...(profile.parseRawHtml ? RAW_HTML_REHYPE_PLUGINS : []),
              [rehypeScientBidi, { direction, requestedDirection }],
            ],
            skipHtml: false,
            urlTransform: (url, key) => (key === "src" ? "" : defaultUrlTransform(url)),
          },
          markdown,
        ),
      ),
    );
    const content = inert.createElement("div");
    content.innerHTML = host.innerHTML;
    return content;
  } finally {
    root.unmount();
  }
}

/** Replaces what only renders inside Scient with portable equivalents. */
function toPortableContent(content: Element): void {
  const document = content.ownerDocument;
  for (const math of content.querySelectorAll("code.language-math")) {
    const tex = math.textContent ?? "";
    const pre = math.parentElement?.tagName === "PRE" ? math.parentElement : null;
    if (pre) pre.textContent = `$$\n${tex.replace(/\n$/u, "")}\n$$\n`;
    else math.textContent = `$${tex}$`;
  }
  for (const image of content.querySelectorAll("img")) {
    const alt = image.getAttribute("alt")?.trim() ?? "";
    if (alt) image.replaceWith(document.createTextNode(alt));
    else image.remove();
  }
  for (const media of content.querySelectorAll(MEDIA_SELECTOR)) media.remove();
  // Local file, context, and citation links do not resolve outside Scient.
  for (const anchor of content.querySelectorAll("a")) {
    if (!/^(?:https?:|mailto:)/iu.test(anchor.getAttribute("href") ?? "")) {
      anchor.replaceWith(...anchor.childNodes);
    }
  }
}

/**
 * Builds the rich flavour through the same sanitizer and direction marks as
 * a selection copy. Returns null, keeping today's plain copy, when the
 * Markdown has no right-to-left text.
 */
export function messageCopyHtml(input: {
  readonly anchor: Element;
  readonly messageId: string;
  readonly markdown: string;
  readonly lineBreaks: boolean;
  readonly parseRawHtml: boolean;
}): string | null {
  if (!hasStrongRtl(input.markdown)) return null;
  const requestedDirection = getClientSettings().contentDirection;
  const direction =
    fixedDirection(findRenderedMessage(input.anchor, input.messageId)?.getAttribute("dir")) ??
    resolveMarkdownDirection(input.markdown, requestedDirection);
  const content = renderMarkdown(input.markdown, input, direction, requestedDirection);
  toPortableContent(content);
  const detached = document.createElement("div");
  detached.setAttribute("dir", direction);
  const wrapper = document.createElement("div");
  wrapper.setAttribute(MESSAGE_COPY_ATTRIBUTE, "");
  wrapper.append(...content.childNodes);
  detached.append(wrapper);
  return renderedMarkdownClipboardHtml(detached);
}
