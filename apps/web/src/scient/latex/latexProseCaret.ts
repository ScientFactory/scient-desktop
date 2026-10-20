/** Read the browser's caret hit before a prose preview becomes a native field. */
export function latexProseCaretOffset(element: HTMLElement, x: number, y: number): number {
  const doc = element.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  const hit = position ? null : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? hit?.startContainer;
  const offset = position?.offset ?? hit?.startOffset;
  if (node && offset !== undefined && element.contains(node)) {
    const prefix = doc.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(node, offset);
    const contents = prefix.cloneContents();
    for (const reference of contents.querySelectorAll<HTMLElement>("[data-latex-prose-text]"))
      reference.textContent = reference.dataset.latexProseText ?? reference.textContent;
    for (const lineBreak of contents.querySelectorAll("br")) lineBreak.replaceWith(" ");
    return contents.textContent?.length ?? 0;
  }

  // Some engines cannot hit-test noneditable text. Its actual glyph rectangles
  // still give the nearest boundary, including wrapped and right-to-left titles.
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let current = walker.nextNode();
  let textOffset = 0;
  let nearest = 0;
  let distance = Infinity;
  while (current) {
    const text = current.textContent ?? "";
    const reference = current.parentElement?.closest<HTMLElement>("[data-latex-prose-text]");
    const direction = getComputedStyle(current.parentElement ?? element).direction;
    for (let index = 0; index < text.length; index++) {
      range.setStart(current, index);
      range.setEnd(current, index + 1);
      for (const rect of range.getClientRects()) {
        for (const [edge, boundary] of [
          [direction === "rtl" ? rect.right : rect.left, index],
          [direction === "rtl" ? rect.left : rect.right, index + 1],
        ] as const) {
          const dy = Math.max(rect.top - y, 0, y - rect.bottom);
          const next = (edge - x) ** 2 + dy ** 2;
          if (next < distance) {
            distance = next;
            nearest = textOffset + (reference ? 0 : boundary);
          }
        }
      }
    }
    textOffset += reference?.dataset.latexProseText?.length ?? text.length;
    current = walker.nextNode();
  }
  return nearest;
}
