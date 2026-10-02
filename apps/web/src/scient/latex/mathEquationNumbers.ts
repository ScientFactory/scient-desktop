import { mathArrayCellSelector } from "./mathEditingGuides";

/** Match outer equation rows to MathLive's rendered baselines without changing math. */
export function positionEquationNumbers(root: HTMLElement, rowCount: number): () => void {
  const math = root.querySelector("math-field");
  const shadow = math?.shadowRoot;
  if (!math || !shadow) return () => {};
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
        number.style.top = `${(strut.getBoundingClientRect().bottom - rect.top) / scale}px`;
        number.style.transform = "translateY(-.8em)";
      } else {
        number.style.top = `${((row + 0.5) * 100) / rowCount}%`;
        number.style.transform = "translateY(-50%)";
      }
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(math);
  const mutation = new MutationObserver(schedule);
  mutation.observe(shadow, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    cancelAnimationFrame(frame);
  };
}
