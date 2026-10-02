import { useLayoutEffect, useRef } from "react";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { LATEX_CANVAS_TEXT_MARKS } from "./latexTextFormatting";

/** Small read-only prose projections share the source parser and never inject HTML. */
export function appendLatexProsePreview(element: HTMLElement, source: string) {
  const projection = projectLatexVisualDocument(source);
  const content = projection.content.content?.[0]?.content;
  if (
    projection.blocks.length !== 1 ||
    projection.blocks[0]?.node.type !== "paragraph" ||
    !content?.every((node) => node.type === "text" || node.type === "hardBreak")
  ) {
    element.textContent = source;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const node of content) {
    let child: globalThis.Node =
      node.type === "hardBreak"
        ? document.createElement("br")
        : document.createTextNode(node.text ?? "");
    for (const mark of node.marks ?? []) {
      const tag = { bold: "strong", italic: "em", underline: "u", code: "code" }[
        mark.type as "bold" | "italic" | "underline" | "code"
      ];
      const wrapper = document.createElement(tag ?? "span");
      const style = LATEX_CANVAS_TEXT_MARKS.find((item) => item.name === mark.type)?.style;
      if (style) wrapper.dataset.latexTextStyle = style;
      wrapper.append(child);
      child = wrapper;
    }
    fragment.append(child);
  }
  element.replaceChildren(fragment);
}

export function LatexProsePreview({ source }: { source: string }) {
  const element = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (element.current) appendLatexProsePreview(element.current, source);
  }, [source]);
  return <span ref={element} />;
}
