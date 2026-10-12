import type { Editor } from "@tiptap/core";
import { useEffect, useRef, type RefObject } from "react";
import type { LatexVisualDocument } from "./latexVisualDocument";
import { latexVisualNodeSignature } from "./latexVisualDocument";
import type { LatexVisualNavigation } from "./latexSourceNavigation";

/** Navigation reads the current projection and never changes editing selection or focus. */
export function useLatexSourceNavigation({
  editor,
  target,
  projection,
  source,
  viewport,
  onUnavailable,
}: {
  editor: Editor | null;
  target: LatexVisualNavigation | null | undefined;
  projection: RefObject<LatexVisualDocument>;
  source: RefObject<string>;
  viewport: RefObject<HTMLElement | null>;
  onUnavailable: (message: string) => void;
}) {
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!editor || !target || handled.current === target.requestId) return;
    let frame = 0;
    let timer = 0;
    let marked: HTMLElement | null = null;
    let done = false;
    const reveal = () => {
      frame = 0;
      if (
        done ||
        editor.isDestroyed ||
        source.current !== target.source ||
        projection.current.source !== target.source ||
        !viewport.current
      )
        return;
      const blocks = projection.current.blocks;
      if (editor.state.doc.childCount !== blocks.length) return;
      let destination: HTMLElement | null = null;
      editor.state.doc.forEach((node, position, index) => {
        const block = blocks[index];
        if (
          destination ||
          !block ||
          block.to <= target.from ||
          block.from >= target.to ||
          latexVisualNodeSignature(block.node) !== latexVisualNodeSignature(node.toJSON())
        )
          return;
        const dom = editor.view.nodeDOM(position);
        if (dom instanceof HTMLElement) destination = dom;
      });
      done = true;
      handled.current = target.requestId;
      if (!destination) {
        onUnavailable("This source line has no displayed content in Visual.");
        return;
      }
      const element: HTMLElement = destination;
      const scroll = viewport.current;
      const bounds = scroll.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      // Center within this pane only; a long environment reveals its beginning.
      const middle = rect.top + Math.min(rect.height, scroll.clientHeight / 2) / 2;
      scroll.scrollTop += middle - bounds.top - scroll.clientTop - scroll.clientHeight / 2;
      const x = rect.left + Math.min(rect.width, scroll.clientWidth / 2) / 2;
      if (rect.left < bounds.left || rect.right > bounds.right)
        scroll.scrollLeft += x - bounds.left - scroll.clientLeft - scroll.clientWidth / 2;
      marked = element;
      element.setAttribute("data-latex-source-sync", "");
      timer = window.setTimeout(() => element.removeAttribute("data-latex-source-sync"), 1_600);
    };
    const schedule = () => {
      if (done) return;
      cancelAnimationFrame(frame);
      // Let pagination and node views settle before measuring the destination.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(reveal);
      });
    };
    editor.on("transaction", schedule);
    schedule();
    return () => {
      editor.off("transaction", schedule);
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      marked?.removeAttribute("data-latex-source-sync");
    };
  }, [editor, target, projection, source, viewport, onUnavailable]);
}
