import { observeResize } from "~/lib/observeResize";
import { mathArrayCellSelector } from "./mathEditingGuides";

/** Match outer equation rows to MathLive's rendered baselines without changing math. */
export function positionEquationNumbers(root: HTMLElement, rowCount: number): () => void {
  // Passive single equations expose their ascent/depth in the rendered struts.
  // Use those metrics without observing every formula or reading layout.
  if (rowCount <= 1) {
    let active: (() => void) | undefined;
    const refresh = () => {
      active?.();
      active = undefined;
      if (root.querySelector("math-field")) {
        active = observeEquationNumbers(root, 1);
        return;
      }
      const shadow = root.querySelector(".scient-latex-math-preview")?.shadowRoot;
      const ascent = shadow?.querySelector<HTMLElement>(".ML__latex > .ML__strut");
      const extent = shadow?.querySelector<HTMLElement>(".ML__latex > .ML__strut--bottom");
      const height = parseFloat(ascent?.style.height ?? ""),
        total = parseFloat(extent?.style.height ?? "");
      for (const number of root.querySelectorAll<HTMLElement>("[data-latex-equation-row]")) {
        if (Number.isFinite(height) && Number.isFinite(total)) {
          number.style.top = `calc(50% + ${height - total / 2}em)`;
          number.style.transform = "translateY(-.8em)";
        } else {
          number.style.removeProperty("top");
          number.style.removeProperty("transform");
        }
      }
    };
    root.addEventListener("scient-latex-math-mounted", refresh);
    root.addEventListener("scient-latex-math-preview", refresh);
    refresh();
    return () => {
      active?.();
      root.removeEventListener("scient-latex-math-mounted", refresh);
      root.removeEventListener("scient-latex-math-preview", refresh);
    };
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
        rowCount === 1
          ? shadow.querySelector<HTMLElement>(".ML__latex > .ML__strut,.ML__content > .ML__strut")
          : cells.length === rowCount
            ? cells[row]?.parentElement?.querySelector<HTMLElement>(":scope > .ML__pstrut")
            : null;
      if (strut) {
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
  const stopResize = observeResize(math ? [root, math] : root, schedule);
  const mutation = new MutationObserver(schedule);
  mutation.observe(shadow, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => {
    stopResize();
    mutation.disconnect();
    cancelAnimationFrame(frame);
  };
}
