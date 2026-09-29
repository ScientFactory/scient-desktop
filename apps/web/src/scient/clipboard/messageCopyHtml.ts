/**
 * Rich `text/html` for the Copy message button when a message contains
 * right-to-left text, so a paste into Word, Google Docs, or Pages keeps each
 * paragraph's direction. Other messages keep their Markdown-only copy.
 *
 * The HTML is rendered from the message's Markdown, the same text the plain
 * flavour carries, with chat's own Markdown pipeline (`chatMarkdownPipeline`)
 * and direction transform. The live
 * row is not the source: it may be unmounted by the virtualized timeline, and
 * a collapsed details block has no body in the DOM. When the row is mounted,
 * its displayed direction is reused as the message direction.
 */
import { codexArtifactTemplatePresentationLabel } from "@t3tools/client-runtime/codex-artifact-templates";
import { artifactTemplateFromHastProperties } from "@t3tools/client-runtime/codex-markdown-directives";
import { Children, createElement, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";

import {
  chatMarkdownAlertLabel,
  chatMarkdownCodeBoxDirection,
  chatMarkdownPipeline,
} from "~/components/ChatMarkdown";
import { getClientSettings } from "~/hooks/useSettings";
import { renderedMarkdownClipboardHtml } from "../../markdown-clipboard";
import { resolveMarkdownDirection, type FixedContentDirection } from "../bidi/contentDirection";
import { rehypeScientBidi } from "../bidi/rehypeScientBidi";
import { isScientMathCodeClassName } from "../math/remarkScientMath";
import { mathMarkdownCopySource } from "../math/ScientMath";
import { hasStrongRtl } from "./clipboardDirection";
import { MESSAGE_COPY_ATTRIBUTE } from "./messageCopyMarker";

const MESSAGE_ROW_SELECTOR = '[data-timeline-row-kind="message"][data-message-id]';
const MEDIA_SELECTOR = "audio, canvas, embed, iframe, object, picture > source, video";

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

function childrenText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");
}

/**
 * The elements chat renders in place of Markdown nodes, where the clipboard
 * needs the same shape: code boxes carry chat's direction for their fence
 * metadata, math carries chat's copy source, alerts carry chat's title, and
 * artifact templates name themselves as chat's copy does.
 */
function clipboardComponents(direction: FixedContentDirection): Components {
  const mathSpan = (tex: string, displayMode: boolean) =>
    createElement("span", {
      className: displayMode ? "scient-math-display" : "scient-math-inline",
      dir: "ltr",
      "data-markdown-copy": mathMarkdownCopySource(tex, displayMode),
    });
  return {
    code: ({ node: _node, className, children, ...props }) =>
      isScientMathCodeClassName(className)
        ? mathSpan(childrenText(children), false)
        : createElement("code", { ...props, className }, children),
    pre: ({ node, children, ...props }) => {
      const onlyChild = Children.toArray(children)[0];
      const code = onlyChild as { props?: ComponentProps<"code"> } | undefined;
      if (isScientMathCodeClassName(code?.props?.className)) {
        return mathSpan(childrenText(code?.props?.children).replace(/\n$/u, ""), true);
      }
      const boxDirection = chatMarkdownCodeBoxDirection(node, children, direction);
      const pre = createElement("pre", props, children);
      return boxDirection === null
        ? pre
        : createElement("div", { "data-copy-text-direction": boxDirection }, pre);
    },
    // Chat shows an alert as a titled note rather than a quote.
    blockquote: ({ node: _node, children, ...props }) => {
      const label = chatMarkdownAlertLabel((props as Record<string, unknown>)["data-alert"]);
      return label === null
        ? createElement("blockquote", props, children)
        : createElement("div", { role: "note" }, createElement("p", null, label), children);
    },
    div: ({ node, children, ...props }) => {
      const template = artifactTemplateFromHastProperties(node?.properties);
      if (!template) return createElement("div", props, children);
      const label = codexArtifactTemplatePresentationLabel(template.artifactKind);
      return createElement("p", null, `${template.displayName} (${label})`);
    },
  };
}

/**
 * Renders Markdown with chat's pipeline into an inert document: nothing in it
 * loads, runs, or reaches the visible timeline. Image sources are dropped.
 */
function renderMarkdown(
  markdown: string,
  profile: MessageMarkdownProfile,
  direction: FixedContentDirection,
  requestedDirection: ReturnType<typeof getClientSettings>["contentDirection"],
): Element {
  const pipeline = chatMarkdownPipeline({ text: markdown, ...profile });
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
            remarkPlugins: pipeline.remarkPlugins,
            rehypePlugins: [
              ...pipeline.rehypePlugins,
              [rehypeScientBidi, { direction, requestedDirection }],
            ],
            skipHtml: false,
            components: clipboardComponents(direction),
            urlTransform: (url, key) => (key === "src" ? "" : defaultUrlTransform(url)),
          },
          pipeline.text,
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
