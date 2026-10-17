/**
 * Copying rendered math from chat. A selection that starts or ends inside an
 * equation copies the whole equation, and the HTML flavour carries each
 * equation's TeX source (`data-markdown-copy`) instead of KaTeX's visual and
 * accessibility DOM. Mounted by `markdown-clipboard.ts`.
 */

const MATH_COPY_SELECTOR =
  ".scient-math-inline[data-markdown-copy], .scient-math-display[data-markdown-copy]";

/** A rendered equation is one semantic object, including when a range ends inside it. */
export function mathAwareRange(source: Range): Range {
  const range = source.cloneRange();
  const mathAt = (node: Node) =>
    (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(
      MATH_COPY_SELECTOR,
    );
  const startMath = mathAt(range.startContainer);
  const endMath = mathAt(range.endContainer);
  if (startMath) range.setStartBefore(startMath);
  if (endMath) range.setEndAfter(endMath);
  return range;
}

/**
 * Export portable source once, rather than KaTeX's visual + accessibility DOM.
 * The live document retains its MathML; only the detached copy is changed.
 */
export function replaceRenderedMathWithSource(container: Element): void {
  for (const math of container.querySelectorAll(MATH_COPY_SELECTOR)) {
    const replacement = document.createElement("span");
    replacement.dir = "ltr";
    replacement.textContent = math.getAttribute("data-markdown-copy");
    math.replaceWith(replacement);
  }
}
