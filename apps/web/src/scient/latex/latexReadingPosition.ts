import type { EditorView } from "@tiptap/pm/view";
import { pagedLayoutSettled, readLatexVisibleReadingTarget } from "./latexPagedGeometry";

/** Where each recently read document was, for this session: its first visible
 * top-level block and that block's offset from the top of the reading area. */
const positions = new Map<string, { readonly block: number; readonly offset: number }>();
const LIMIT = 32;
const READER_NAVIGATION = "scient-latex-reader-navigation";

/** Header controls live outside the editor DOM but own the reader's next position. */
export function cancelLatexReadingPosition(view: EditorView): void {
  view.dom.dispatchEvent(new Event(READER_NAVIGATION));
}

function scroller(view: EditorView) {
  return view.dom.closest<HTMLElement>(".scient-latex-visual-scroll");
}

/** The block a reopened document should load first, so it opens where it was read. */
export function rememberedLatexReadingBlock(key: string): number {
  return positions.get(key)?.block ?? 0;
}

/** Records the block at the top of the reading area, found by hit-testing, not by walking the document. */
export function rememberLatexReadingPosition(key: string, view: EditorView): void {
  const scroll = scroller(view);
  if (!scroll || scroll.clientHeight <= 0) return;
  const box = scroll.getBoundingClientRect();
  const paper = view.dom.getBoundingClientRect();
  const target = readLatexVisibleReadingTarget(view, box, paper);
  if (!target) return;
  let index: number;
  let start: number;
  try {
    const { doc } = view.state;
    const $position = doc.resolve(Math.min(view.posAtDOM(target.block, 0), doc.content.size));
    index = $position.index(0);
    // Inside a block, or at a widget just before one.
    start = $position.depth > 0 ? $position.before(1) : $position.pos;
  } catch {
    return;
  }
  const element = view.nodeDOM(start);
  if (!(element instanceof HTMLElement)) return;
  positions.delete(key);
  positions.set(key, { block: index, offset: element.getBoundingClientRect().top - box.top });
  if (positions.size > LIMIT) positions.delete(positions.keys().next().value!);
}

/**
 * Scrolls an editor opened at `block` (its first block) to the remembered
 * offset. Blocks are rendered, at their real height, only on the next frames,
 * so the position is set again once they are, unless the reader has scrolled.
 */
export function restoreLatexReadingPosition(key: string, view: EditorView, block: number): void {
  const saved = positions.get(key);
  const scroll = scroller(view);
  const element = view.nodeDOM(0);
  if (!saved || saved.block !== block || !scroll || !(element instanceof HTMLElement)) return;
  const apply = () => {
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
    return scroll.scrollTop;
  };
  const set = apply();
  let frame = 0;
  // Stage resize can precede the final page plan while opening blocks are added.
  const finished = () => {
    cancelAnimationFrame(frame);
    view.dom.removeEventListener("scient-latex-layout", laidOut);
    for (const name of ["wheel", "pointerdown", "keydown", READER_NAVIGATION])
      view.dom.removeEventListener(name, finished);
  };
  const laidOut = () => {
    if (element.isConnected) apply();
    if (view.dom.dataset.latexLoading !== "true" && pagedLayoutSettled(view)) finished();
  };
  view.dom.addEventListener("scient-latex-layout", laidOut);
  for (const name of ["wheel", "pointerdown", "keydown", READER_NAVIGATION])
    view.dom.addEventListener(name, finished, { once: true });
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (element.isConnected && Math.abs(scroll.scrollTop - set) < 1) apply();
    });
  });
}
