import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Decoration, type EditorView } from "@tiptap/pm/view";
import { latexViewportMeasurement } from "./latexViewport";

export type ParagraphSpacingCache = WeakMap<
  DocumentNode,
  { key: string; spacing: number; element: HTMLElement; width: number; previous: Element | null }
>;

/** Fit a short paragraph using shrinkable spaces, as TeX does before wrapping.
 * Keep glyph widths, indentation and the text area unchanged. This is bounded
 * single-line fitting, not a replacement for TeX's paragraph breaking algorithm.
 */
export function latexParagraphSpacing(
  view: EditorView,
  cache: ParagraphSpacingCache,
  unchanged?: (element: HTMLElement) => boolean,
  reuseUnchangedWidth = false,
) {
  const decorations: Decoration[] = [];
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return decorations;
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== "paragraph") return !node.isAtom;
    // Literal text only: hard breaks, math, references and nested editors retain
    // their own layout. Formatting marks are measured with their actual fonts.
    if (!node.childCount || !node.content.content.every((child) => child.isText)) return false;
    const paragraph = view.nodeDOM(position);
    if (!(paragraph instanceof HTMLElement)) return false;
    const previous = paragraph.previousElementSibling;
    let cached = cache.get(node);
    const decorate = (spacing: number) => {
      if (spacing)
        decorations.push(
          Decoration.node(
            position,
            position + node.nodeSize,
            { style: `word-spacing: ${spacing}px` },
            { latexParagraphSpacing: spacing },
          ),
        );
    };
    if (paragraph.hasAttribute("data-latex-viewport-closed")) {
      decorate(latexViewportMeasurement(view, node, position)?.wordSpacing ?? cached?.spacing ?? 0);
      return false;
    }
    // The local measurement path already checked the paper width/typography.
    // Reusing an unchanged paragraph must not wake its distant layout subtree.
    if (
      reuseUnchangedWidth &&
      cached?.element === paragraph &&
      cached.previous === previous &&
      unchanged?.(paragraph)
    ) {
      decorate(cached.spacing);
      return false;
    }
    const widthOnScreen = paragraph.clientWidth;
    if (
      cached?.element === paragraph &&
      cached.width === widthOnScreen &&
      cached.previous === previous &&
      unchanged?.(paragraph)
    ) {
      decorate(cached.spacing);
      return false;
    }
    const style = getComputedStyle(paragraph);
    if (
      style.textAlign !== "justify" ||
      (paragraph.previousElementSibling &&
        getComputedStyle(paragraph.previousElementSibling).float !== "none")
    )
      return false;
    let width = parseFloat(style.width);
    if (style.boxSizing === "border-box")
      width -=
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
    const available = width - parseFloat(style.textIndent);
    if (!(available > 0)) return false;
    const runs: {
      text: string;
      font: string;
      kerning: CanvasFontKerning;
      letterSpacing: string;
    }[] = [];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const parent = text.parentElement;
      if (!parent || parent.closest('[contenteditable="false"]')) continue;
      const run = getComputedStyle(parent);
      // Canvas cannot reproduce arbitrary OpenType/CSS transformations here.
      if (
        run.fontFeatureSettings !== "normal" ||
        run.fontVariantCaps !== "normal" ||
        run.fontStretch !== "100%" ||
        run.textTransform !== "none"
      )
        return false;
      runs.push({
        text: text.textContent ?? "",
        font: `${run.fontStyle} ${run.fontWeight} ${run.fontSize} ${run.fontFamily}`,
        kerning: run.fontKerning as CanvasFontKerning,
        letterSpacing: run.letterSpacing,
      });
    }
    // Pre-wrap hangs trailing spaces outside the line's fit calculation.
    const last = runs.at(-1);
    if (last) last.text = last.text.replace(/ +$/u, "");
    const key = JSON.stringify([available, runs]);
    if (cached?.key !== key) {
      let natural = 0,
        spaces = 0,
        shrink = Infinity;
      for (const run of runs) {
        context.font = run.font;
        context.fontKerning = run.kerning;
        context.letterSpacing = run.letterSpacing === "normal" ? "0px" : run.letterSpacing;
        natural += context.measureText(run.text).width;
        const count = (run.text.match(/ /gu) ?? []).length;
        spaces += count;
        if (count) shrink = Math.min(shrink, context.measureText(" ").width / 3);
      }
      const excess = natural - available;
      // A subpixel allowance prevents browser rounding from wrapping again.
      const adjustment = spaces ? Math.ceil(((excess + 0.25) / spaces) * 100) / 100 : 0;
      const spacing = excess > 0 && adjustment > 0 && adjustment <= shrink ? -adjustment : 0;
      cached = { key, spacing, element: paragraph, width: widthOnScreen, previous };
      cache.set(node, cached);
    } else {
      cached = { ...cached, element: paragraph, width: widthOnScreen, previous };
      cache.set(node, cached);
    }
    decorate(cached.spacing);
    return false;
  });
  return decorations;
}
