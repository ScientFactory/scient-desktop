/**
 * Rich `text/html` for the Copy message button when a message contains
 * right-to-left text, so a paste into Word, Google Docs, or Pages keeps each
 * paragraph's direction. Other messages keep their Markdown-only copy.
 */
import { renderedMarkdownClipboardHtml } from "../../markdown-clipboard";
import { hasStrongRtl } from "./clipboardDirection";

/** Marks the button's HTML so Scient's own editors can keep pasting its Markdown. */
const MESSAGE_COPY_ATTRIBUTE = "data-scient-message-copy";
const MESSAGE_COPY_PATTERN = new RegExp(`<div\\s[^>]*\\b${MESSAGE_COPY_ATTRIBUTE}\\b`, "u");
const MESSAGE_ROW_SELECTOR = '[data-timeline-row-kind="message"][data-message-id]';
/** Signed media URLs are credentials for this app's server; rich paste gets the alt text. */
const MEDIA_SELECTOR = "audio, canvas, embed, iframe, object, picture > source, video";

export function isScientMessageCopyHtml(html: string): boolean {
  return MESSAGE_COPY_PATTERN.test(html);
}

function isMessageRow(element: Element, messageId: string): boolean {
  return (
    element.matches(MESSAGE_ROW_SELECTOR) && element.getAttribute("data-message-id") === messageId
  );
}

/**
 * The rendered Markdown of a timeline message. The button can sit in the
 * message's own row or in a separate metadata row, so the search widens from
 * the button until a scope holds that message's row.
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

function replaceMediaWithText(root: Element): void {
  for (const image of root.querySelectorAll("img")) {
    const alt = image.getAttribute("alt")?.trim() ?? "";
    if (alt) image.replaceWith(root.ownerDocument.createTextNode(alt));
    else image.remove();
  }
  for (const media of root.querySelectorAll(MEDIA_SELECTOR)) media.remove();
}

/**
 * Builds the rich flavour from the message as rendered, through the same
 * sanitizer and direction marks as a selection copy. Returns null, keeping
 * today's plain copy, when the Markdown has no right-to-left text or the
 * message is not rendered.
 */
export function messageCopyHtml(input: {
  readonly anchor: Element;
  readonly messageId: string;
  readonly markdown: string;
}): string | null {
  if (!hasStrongRtl(input.markdown)) return null;
  const rendered = findRenderedMessage(input.anchor, input.messageId);
  if (!rendered) return null;
  // A shallow clone keeps the message's resolved direction; its content moves
  // into a marked wrapper. The live message is only read.
  const detached = rendered.cloneNode(false) as Element;
  const wrapper = rendered.ownerDocument.createElement("div");
  wrapper.setAttribute(MESSAGE_COPY_ATTRIBUTE, "");
  for (const child of rendered.childNodes) wrapper.append(child.cloneNode(true));
  detached.append(wrapper);
  replaceMediaWithText(wrapper);
  return renderedMarkdownClipboardHtml(detached);
}
