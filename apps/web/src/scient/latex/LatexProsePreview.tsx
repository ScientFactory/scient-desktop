import { useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  latexEquationReferencesKey,
  latexReferencePresentation,
  navigateToEquation,
} from "./latexEquationReferences";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { LATEX_CANVAS_TEXT_MARKS } from "./latexTextFormatting";
import { latexDirectionMark } from "./latexLanguage";
import type { JSONContent } from "@tiptap/core";
import { latexColorCss } from "./latexColorBoxes";

/** Small read-only prose projections share the source parser and never inject HTML. */
export function appendLatexProsePreview(
  element: HTMLElement,
  source: string,
  editor?: Editor,
  rootSource?: string,
) {
  const projection = projectLatexVisualDocument(source, 0, rootSource ?? source);
  const content = projection.content.content ?? [];
  const supported = (node: JSONContent): boolean =>
    ["text", "hardBreak"].includes(String(node.type)) ||
    (!!editor &&
      node.type === "latexInlineCommand" &&
      ["ref", "eqref"].includes(String(node.attrs?.name))) ||
    ((node.type === "paragraph" ||
      (node.type === "latexScientific" && node.attrs?.layout?.kind === "contentGroup")) &&
      (node.content ?? []).every(supported));
  if (projection.rawBlocks || !content.every(supported)) {
    element.dataset.sourceFallback = "true";
    element.textContent = source;
    return;
  }
  delete element.dataset.sourceFallback;
  const fragment = document.createDocumentFragment();
  const append = (parent: globalThis.Node, node: JSONContent) => {
    if (node.type === "paragraph") {
      for (const child of node.content ?? []) append(parent, child);
      return;
    }
    if (node.type === "latexScientific") {
      const wrapper = document.createElement("span");
      const layout = node.attrs!.layout;
      if (layout.size) wrapper.style.fontSize = `var(--scient-latex-size-${layout.size})`;
      if (layout.points) wrapper.style.fontSize = `${(layout.points * 96) / 72.27}px`;
      if (layout.weight) wrapper.style.fontWeight = String(layout.weight);
      if (layout.fontStyle) wrapper.style.fontStyle = layout.fontStyle;
      if (layout.color) wrapper.style.color = latexColorCss(layout.color) ?? "";
      for (const child of node.content ?? []) append(wrapper, child);
      parent.appendChild(wrapper);
      return;
    }
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
      reference.dataset.latexProseText = `[${key}]`;
      reference.setAttribute("aria-label", `Go to reference ${key}`);
      reference.disabled = !target;
      reference.onclick = (event) => {
        event.stopPropagation();
        const current = latexEquationReferencesKey.getState(editor.state)?.labels.get(key);
        if (current) navigateToEquation(editor.view, current);
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
      const direction = latexDirectionMark(mark.type);
      if (mark.type === "latexColor")
        wrapper.style.color = latexColorCss(String(mark.attrs?.color ?? "")) ?? "";
      if (direction) {
        wrapper.dataset.latexDirectionMark = direction.name;
        wrapper.dir = direction.direction;
        if (direction.language) wrapper.lang = direction.language === "hebrew" ? "he" : "en";
      }
      wrapper.append(child);
      child = wrapper;
    }
    parent.appendChild(child);
  };
  for (const node of content) append(fragment, node);
  element.replaceChildren(fragment);
}

export function LatexProsePreview({
  source,
  editor,
  rootSource,
}: {
  source: string;
  editor?: Editor;
  rootSource?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const references = useEditorState({
    editor: editor ?? null,
    selector: ({ editor: current }) => (current ? latexReferencePresentation(current.state) : null),
  });
  useLayoutEffect(() => {
    if (element.current) appendLatexProsePreview(element.current, source, editor, rootSource);
  }, [source, editor, rootSource, references]);
  return <span ref={element} />;
}
