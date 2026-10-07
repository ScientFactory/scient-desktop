import type { MathfieldElement } from "mathlive";
import { focusMathCellGuide, mathSelectionAtOffset } from "./mathLiveSelection";

// MathLive 0.108 lays out array columns with a VBox. Decorate its rendered
// cell boxes, never its atoms: empty guides must not enter source or undo.
export const mathArrayCellSelector =
  ".ML__mtable > :is(.col-align-l,.col-align-c,.col-align-r) > .ML__vlist-t > .ML__vlist-r:first-child > .ML__vlist > span > span:last-child";
const cellSelector = mathArrayCellSelector;
// Figure space reserves a click target with no ink, even before decoration.
// MathLive can render placeholders as ordinary font boxes (for example in
// accents), so its ML__placeholder class is not a reliable slot selector.
const emptySlotCharacter = "\u2007";

export function installMathEditingGuides(math: MathfieldElement): () => void {
  const root = math.shadowRoot;
  if (!root) return () => {};
  math.placeholderSymbol = emptySlotCharacter;
  const style = document.createElement("style");
  style.textContent = `
    /* Reserve targets from the first render, before the observer decorates
       cells. Focus, selection and guide updates must not resize the formula. */
    ${cellSelector} {
      min-width: .95em;
      box-sizing: border-box;
      position: relative;
    }
    :host(:not([read-only]):is(:focus-within,[data-scient-selection-held])) [data-scient-math-cell][data-empty][data-guide-active]::after {
      content: "";
      position: absolute;
      width: .75em;
      height: .9em;
      top: calc(var(--scient-guide-baseline) - .75em);
      left: .1em;
      box-sizing: border-box;
      border: 1px dashed var(--scient-empty-guide, #b8c7da);
      border-radius: 3px;
      pointer-events: none;
    }
    .ML__placeholder, [data-scient-math-slot] {
      color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
      position: relative;
    }
    :host(:not([read-only]):is(:focus-within,[data-scient-selection-held])) :is(.ML__placeholder,[data-scient-math-slot])::after {
      content: "";
      position: absolute;
      width: .65em;
      height: .9em;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      border: 1px dashed var(--scient-empty-guide, #b8c7da);
      border-radius: 3px;
      pointer-events: none;
    }
    [data-scient-math-cell][data-empty] :is(.ML__placeholder,[data-scient-math-slot])::after {
      display: none;
    }
    [data-scient-math-cell][data-empty] .ML__empty-line-anchor::after {
      display: none;
    }
    @media print { [data-scient-math-cell]::after, .ML__placeholder::after, [data-scient-math-slot]::after { display: none !important; } }
  `;
  root.append(style);
  let frame = 0;
  const update = () => {
    frame = 0;
    math.toggleAttribute(
      "data-scient-empty",
      !math.getValue("latex-without-placeholders").replace(/[{}\s]/gu, ""),
    );
    const formula = root.querySelector(".ML__latex");
    if (formula) {
      for (const slot of formula.querySelectorAll("[data-scient-math-slot]")) {
        if (slot.textContent !== emptySlotCharacter) slot.removeAttribute("data-scient-math-slot");
      }
      const texts = math.ownerDocument.createTreeWalker(formula, NodeFilter.SHOW_TEXT);
      for (let text = texts.nextNode(); text; text = texts.nextNode()) {
        if (text.nodeValue === emptySlotCharacter)
          text.parentElement?.setAttribute("data-scient-math-slot", "");
      }
    }
    // Limit guides to the innermost array being edited, including nested cases.
    const activeId = mathSelectionAtOffset(math, math.position).path.at(-1)?.array.id;
    const activeWrapper = activeId
      ? root.querySelector(`[data-atom-id="${CSS.escape(activeId)}"]`)
      : null;
    const activeTable = activeWrapper?.matches(".ML__mtable")
      ? activeWrapper
      : (activeWrapper?.querySelector(".ML__mtable") ??
        root.querySelector(".ML__caret,.ML__placeholder-selected")?.closest(".ML__mtable"));
    for (const cell of root.querySelectorAll<HTMLElement>(cellSelector)) {
      cell.dataset.scientMathCell = "";
      const text = (cell.textContent ?? "").replace(/[\s\u200b\u2060]/gu, "");
      // A rule, root, or nested structure is meaningful even without text.
      const structure = cell.querySelector("svg,.ML__mtable,.ML__sqrt,.ML__frac");
      const empty = !text && !structure;
      cell.toggleAttribute("data-empty", empty);
      if (empty) {
        // MathLive's existing strut ends at the row baseline. Both offsets
        // share the positioned row wrapper and remain local under CSS zoom.
        // Reading it avoids inserting an inline box that changes the baseline.
        const strut = cell.parentElement?.querySelector<HTMLElement>(":scope > .ML__pstrut");
        if (strut) {
          const baseline = strut.offsetTop + strut.offsetHeight - cell.offsetTop;
          cell.style.setProperty("--scient-guide-baseline", `${baseline}px`);
        }
      }
      cell.toggleAttribute("data-guide-active", cell.closest(".ML__mtable") === activeTable);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const click = (event: MouseEvent) => {
    if (math.readOnly || !math.selectionIsCollapsed) return;
    const target = event
      .composedPath()
      .find(
        (item): item is HTMLElement =>
          item instanceof HTMLElement &&
          item.hasAttribute("data-scient-math-cell") &&
          item.hasAttribute("data-empty"),
      );
    const table = target?.closest(".ML__mtable");
    const column = target?.closest(".col-align-l,.col-align-c,.col-align-r");
    if (!target || !table || !column) return;
    const columns = [...table.children].filter((element) =>
      element.matches(".col-align-l,.col-align-c,.col-align-r"),
    );
    const cells = [...column.querySelectorAll<HTMLElement>("[data-scient-math-cell]")].filter(
      (cell) => cell.closest(".ML__mtable") === table,
    );
    if (focusMathCellGuide(math, table, cells.indexOf(target), columns.indexOf(column)))
      event.stopPropagation();
  };
  math.addEventListener("click", click);
  math.addEventListener("focusin", schedule);
  math.addEventListener("selection-change", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => {
    math.removeEventListener("click", click);
    math.removeEventListener("focusin", schedule);
    math.removeEventListener("selection-change", schedule);
    observer.disconnect();
    cancelAnimationFrame(frame);
    style.remove();
  };
}
