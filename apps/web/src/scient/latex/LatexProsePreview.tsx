import { useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { latexEquationReferencesKey, navigateToEquation } from "./latexEquationReferences";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { LATEX_CANVAS_TEXT_MARKS } from "./latexTextFormatting";

/** Small read-only prose projections share the source parser and never inject HTML. */
export function appendLatexProsePreview(element: HTMLElement, source: string, editor?: Editor) {
  const projection = projectLatexVisualDocument(source);
  const content = projection.content.content?.[0]?.content;
  if (
    projection.blocks.length !== 1 ||
    projection.blocks[0]?.node.type !== "paragraph" ||
    !content?.every(
      (node) =>
        node.type === "text" ||
        node.type === "hardBreak" ||
        (editor &&
          node.type === "latexInlineCommand" &&
          ["ref", "eqref"].includes(String(node.attrs?.name))),
    )
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
    if (node.type === "latexInlineCommand" && editor) {
      const key = String(node.attrs?.argument ?? "");
      const target = latexEquationReferencesKey.getState(editor.state)?.labels.get(key);
      const reference = document.createElement("button");
      reference.type = "button";
      reference.className = "scient-latex-inline-command";
      const number = target?.number ?? "?";
      reference.textContent = node.attrs?.name === "eqref" ? `(${number})` : number;
      reference.setAttribute("aria-label", `Go to reference ${key}`);
      reference.disabled = !target;
      reference.onclick = (event) => {
        event.stopPropagation();
        if (target) navigateToEquation(editor.view, target);
      };
      child = reference;
    }
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

export function LatexProsePreview({ source, editor }: { source: string; editor?: Editor }) {
  const element = useRef<HTMLSpanElement>(null);
  const references = useEditorState({
    editor: editor ?? null,
    selector: ({ editor: current }) =>
      current ? latexEquationReferencesKey.getState(current.state)?.labels : null,
  });
  useLayoutEffect(() => {
    if (element.current) appendLatexProsePreview(element.current, source, editor);
  }, [source, editor, references]);
  return <span ref={element} />;
}
