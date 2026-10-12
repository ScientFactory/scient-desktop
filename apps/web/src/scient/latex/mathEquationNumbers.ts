import { mathArrayCellSelector } from "./mathEditingGuides";

/** Match outer equation rows to MathLive's rendered baselines without changing math. */
export function positionEquationNumbers(root: HTMLElement, rowCount: number): () => void {
  // The single-row position is already supplied by CSS. It never needs a
  // resize/mutation observer or a layout read when preview glyphs arrive.
  if (rowCount <= 1) {
    for (const number of root.querySelectorAll<HTMLElement>("[data-latex-equation-row]")) {
      if (number.style.top) number.style.removeProperty("top");
      if (number.style.transform) number.style.removeProperty("transform");
    }
    return () => {};
  }
  let dispose: (() => void) | undefined;
  const refresh = () => {
    dispose?.();
    dispose = observeEquationNumbers(root, rowCount);
  };
  root.addEventListener("scient-latex-math-mounted", refresh);
  root.addEventListener("scient-latex-math-preview", refresh);
  refresh();
  return () => {
    root.removeEventListener("scient-latex-math-mounted", refresh);
    root.removeEventListener("scient-latex-math-preview", refresh);
    dispose?.();
  };
}

function observeEquationNumbers(root: HTMLElement, rowCount: number): (() => void) | undefined {
  const math = root.querySelector("math-field");
  const preview = root.querySelector(".scient-latex-math-preview");
  const shadow = math?.shadowRoot ?? preview?.shadowRoot ?? preview;
  if (!shadow) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    const rect = root.getBoundingClientRect();
    const scale = root.offsetHeight > 0 ? rect.height / root.offsetHeight : 0;
    if (!scale) return;
    const numbers = [...root.querySelectorAll<HTMLElement>("[data-latex-equation-row]")];
    const table = shadow.querySelector(".ML__mtable");
    const column = table?.querySelector(
      ":scope > .col-align-l,:scope > .col-align-c,:scope > .col-align-r",
    );
    const cells = column
      ? [...column.querySelectorAll<HTMLElement>(mathArrayCellSelector)].filter(
          (cell) => cell.closest(".ML__mtable") === table,
        )
      : [];
    for (const [row, number] of numbers.entries()) {
      const strut =
        cells.length === rowCount
          ? cells[row]?.parentElement?.querySelector<HTMLElement>(":scope > .ML__pstrut")
          : null;
      if (rowCount > 1 && strut) {
        const top = `${(strut.getBoundingClientRect().bottom - rect.top) / scale}px`;
        if (number.style.top !== top) number.style.top = top;
        if (number.style.transform !== "translateY(-0.8em)")
          number.style.transform = "translateY(-.8em)";
      } else {
        const top = `${((row + 0.5) * 100) / rowCount}%`;
        if (number.style.top !== top) number.style.top = top;
        if (number.style.transform !== "translateY(-50%)")
          number.style.transform = "translateY(-50%)";
      }
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  if (math) resize.observe(math);
  const mutation = new MutationObserver(schedule);
  mutation.observe(shadow, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    cancelAnimationFrame(frame);
  };
}
