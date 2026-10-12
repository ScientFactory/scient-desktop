import { afterEditorPaint } from "./afterEditorPaint";

/** Track the displayed page without forcing paper layout during editor installation. */
export function observeLatexCurrentPage(
  scroll: HTMLElement,
  dimensions: { pageCount: number; pageHeight: number; pageGap: number; zoom: number },
  onPage: (page: number) => void,
) {
  let frame = 0;
  let previous: number | undefined;
  const update = () => {
    frame = 0;
    const paper = scroll.querySelector<HTMLElement>(".scient-latex-visual-paper");
    if (!paper) return;
    const top = scroll.getBoundingClientRect().top + Math.min(160, scroll.clientHeight / 3);
    const page = Math.max(
      1,
      Math.min(
        dimensions.pageCount,
        Math.floor(
          (top - paper.getBoundingClientRect().top) /
            (dimensions.zoom * (dimensions.pageHeight + dimensions.pageGap)),
        ) + 1,
      ),
    );
    if (page !== previous) {
      previous = page;
      onPage(page);
    }
  };
  const cancelInitial = afterEditorPaint(update);
  const schedule = () => {
    cancelInitial();
    if (!frame) frame = requestAnimationFrame(update);
  };
  scroll.addEventListener("scroll", schedule, { passive: true });
  return () => {
    cancelInitial();
    scroll.removeEventListener("scroll", schedule);
    cancelAnimationFrame(frame);
  };
}
