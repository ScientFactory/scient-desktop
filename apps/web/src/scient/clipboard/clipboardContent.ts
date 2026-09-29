/**
 * Turns chat controls and cards in a detached clipboard fragment into plain
 * content before the T3 sanitizer removes buttons and graphics, so the rich
 * flavour of a right-to-left copy carries everything its Markdown carries.
 *
 * - A chip rendered as a control (mentions, file and context references)
 *   becomes the content of its Markdown copy: code, link text, or text.
 * - A details block becomes a bold summary paragraph followed by its body.
 * - A rendered diagram or chart card becomes a code block with its source.
 * - Display math becomes its own left-to-right paragraph of `$$` source.
 */

/** Mirrors what the T3 clipboard sanitizer removes. */
const DROPPED_CONTROL_SELECTOR = 'button, svg, [aria-hidden="true"], .select-none, .sr-only';
/** The sanitizer keeps file-link chips and their visible label. */
const KEPT_CHIP_SELECTOR = ".chat-markdown-file-link";
const FENCE = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?\1[ \t]*$/u;
const INLINE_CODE = /^(`+)[ ]?([\s\S]*?)[ ]?\1$/u;
const INLINE_LINK = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)$/u;
/** Chat's copy source for display math: `$$`, the TeX, and `$$` on their own lines. */
const DISPLAY_MATH_COPY = /^\$\$\n[\s\S]*\n\$\$\s*$/u;

function isWebUrl(href: string): boolean {
  return /^(?:https?:|mailto:)/iu.test(href);
}

/** Inline content equivalent to a chip's Markdown copy. */
function markdownCopyContent(copy: string, document: Document): Node {
  const source = copy.trim();
  const code = INLINE_CODE.exec(source);
  if (code) {
    const element = document.createElement("code");
    element.textContent = code[2] ?? "";
    return element;
  }
  const link = INLINE_LINK.exec(source);
  if (link) {
    const label = link[1] || link[2] || "";
    const href = link[2] ?? "";
    // Local, context, and citation destinations do not resolve outside Scient.
    if (!isWebUrl(href)) return document.createTextNode(label);
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.textContent = label;
    return anchor;
  }
  return document.createTextNode(source);
}

function summaryParagraph(summary: string, document: Document): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = summary.trim() || "Details";
  paragraph.append(strong);
  return paragraph;
}

/** The chat's collapsible details, and native details from a Markdown rendering. */
function materializeDetails(container: Element): void {
  const document = container.ownerDocument;
  for (const details of container.querySelectorAll("[data-markdown-details]")) {
    if (!container.contains(details)) continue;
    const summary = details.querySelector("[data-markdown-details-summary]")?.textContent ?? "";
    const content = details.querySelector("[data-markdown-details-content]");
    details.replaceWith(summaryParagraph(summary, document), ...(content?.childNodes ?? []));
  }
  for (const details of container.querySelectorAll("details")) {
    if (!container.contains(details)) continue;
    const summary = details.querySelector(":scope > summary");
    const summaryText = summary?.textContent ?? "";
    summary?.remove();
    details.replaceWith(summaryParagraph(summaryText, document), ...details.childNodes);
  }
}

function materializeVisualCards(container: Element): void {
  const document = container.ownerDocument;
  for (const card of container.querySelectorAll("[data-scient-visual-card][data-markdown-copy]")) {
    const source = card.getAttribute("data-markdown-copy") ?? "";
    const fence = FENCE.exec(source.trim());
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const language = fence?.[2]?.trim().split(/\s+/u)[0];
    if (language) code.className = `language-${language}`;
    code.textContent = fence ? `${fence[3] ?? ""}\n` : source.trim();
    pre.append(code);
    card.replaceWith(pre);
  }
}

function materializeDisplayMath(container: Element): void {
  const document = container.ownerDocument;
  for (const math of container.querySelectorAll("[data-markdown-copy]")) {
    const source = math.getAttribute("data-markdown-copy") ?? "";
    if (!DISPLAY_MATH_COPY.test(source)) continue;
    const paragraph = document.createElement("p");
    paragraph.setAttribute("dir", "ltr");
    paragraph.textContent = source.trim();
    math.replaceWith(paragraph);
  }
}

function materializeControlChips(container: Element): void {
  const document = container.ownerDocument;
  for (const chip of container.querySelectorAll("[data-markdown-copy]")) {
    if (!container.contains(chip) || chip.closest(KEPT_CHIP_SELECTOR)) continue;
    const control = chip.closest(DROPPED_CONTROL_SELECTOR);
    if (!control || !container.contains(control)) continue;
    const copies =
      control === chip ? [chip] : [...control.querySelectorAll("[data-markdown-copy]")];
    control.replaceWith(
      ...copies.map((element) =>
        markdownCopyContent(element.getAttribute("data-markdown-copy") ?? "", document),
      ),
    );
  }
}

/** Materializes controls and cards in a detached clipboard fragment, in place. */
export function materializeClipboardContent(container: Element): void {
  materializeDetails(container);
  materializeDisplayMath(container);
  materializeVisualCards(container);
  materializeControlChips(container);
}
