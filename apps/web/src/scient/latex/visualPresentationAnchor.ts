import { visualCharacters } from "@t3tools/shared/latexVisual";
import type { PdfPresentationAnchor } from "../pdf/pdfPresentation";

/** Keep a visible source-backed line stationary, not the advancing caret's X.
 * Ambiguous or not-yet-rendered text falls back to the unchanged scroll offset.
 */
export function captureVisualPresentationAnchor(
  container: HTMLElement,
  previousText: string,
  nextText: string,
): PdfPresentationAnchor | null {
  const previous = visualCharacters(previousText).text;
  const next = visualCharacters(nextText).text;
  const bounds = container.getBoundingClientRect();
  let index = -1;
  let screenTop = 0;
  let originalPage = 1;
  for (const span of container.querySelectorAll<HTMLElement>(".textLayer span")) {
    const text = visualCharacters(span.textContent ?? "").text;
    if (text.length < 3) continue;
    const start = previous.indexOf(text);
    const rect = span.getBoundingClientRect();
    if (
      start < 0 ||
      previous.indexOf(text, start + 1) >= 0 ||
      rect.top < bounds.top ||
      rect.bottom > bounds.bottom
    )
      continue;
    index = start;
    screenTop = rect.top;
    originalPage = Number(
      span.closest<HTMLElement>(".page[data-page-number]")?.dataset.pageNumber ?? 1,
    );
    break;
  }
  if (index < 0) return null;
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  // Transform this logical source position through the minimal edit, keeping
  // positions inside a replaced region at that region's start.
  const position =
    index <= prefix
      ? index
      : index >= previous.length - suffix
        ? index + next.length - previous.length
        : prefix;
  return {
    key: `${position}:${screenTop}:${next}`,
    screenTop,
    locatePage: async (document, signal) => {
      // Bounded nearby reflow only. Ambiguity or more distant restructuring
      // preserves the viewport rather than guessing a different source region.
      const needle = next.slice(position, position + 32);
      if (needle.length < 8) return null;
      const matches: number[] = [];
      for (
        let page = Math.max(1, originalPage - 2);
        page <= Math.min(document.numPages, originalPage + 2);
        page++
      ) {
        if (signal.aborted) return null;
        const contents = await (await document.getPage(page)).getTextContent();
        if (signal.aborted) return null;
        const text = visualCharacters(
          contents.items.map((item) => ("str" in item ? item.str : "")).join(""),
        ).text;
        const index = text.indexOf(needle);
        if (index < 0) continue;
        if (text.indexOf(needle, index + 1) >= 0) return null;
        matches.push(page);
      }
      return matches.length === 1 ? matches[0]! : null;
    },
    locate: (staged) => {
      const hits: number[] = [];
      for (const span of staged.querySelectorAll<HTMLElement>(".textLayer span")) {
        const node = span.firstChild;
        if (!(node instanceof Text) || span.childNodes.length !== 1) continue;
        const text = visualCharacters(node.data);
        if (text.text.length < 3) continue;
        const start = next.indexOf(text.text);
        if (
          start < 0 ||
          next.indexOf(text.text, start + 1) >= 0 ||
          position < start ||
          position >= start + text.text.length
        )
          continue;
        const offset = text.offsets[position - start]!;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(node.length, offset + 1));
        hits.push(range.getBoundingClientRect().top);
      }
      return hits.length === 1 ? hits[0]! : null;
    },
  };
}
