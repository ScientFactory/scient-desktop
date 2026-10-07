import type { MathfieldElement } from "mathlive";
import {
  focusMathCellGuide,
  mathCaretInAccentBody,
  mathGuideScopeId,
  mathEditingScopes,
  mathScopeRects,
  mathSelectionAtOffset,
} from "./mathLiveSelection";

// MathLive 0.108 lays out array columns with a VBox. Decorate its rendered
// cell boxes, never its atoms: empty guides must not enter source or undo.
export const mathArrayCellSelector =
  ".ML__mtable > :is(.col-align-l,.col-align-c,.col-align-r) > .ML__vlist-t > .ML__vlist-r:first-child > .ML__vlist > span > span:last-child";
const cellSelector = mathArrayCellSelector;
// Figure space reserves a click target with no ink, even before decoration.
// MathLive can render placeholders as ordinary font boxes (for example in
// accents), so its ML__placeholder class is not a reliable slot selector.
const emptySlotCharacter = "\u2007";

/** Active and vacant slots share one measured box and one overlay renderer. */
export function mathEditingGuideRects(math: MathfieldElement): DOMRect[] {
  const root = math.shadowRoot;
  if (!root || math.readOnly) return [];
  const scale = math.getBoundingClientRect().width / (math.offsetWidth || 1);
  const empty = [
    ...root.querySelectorAll<HTMLElement>(
      "[data-scient-math-cell][data-empty][data-guide-active],.ML__placeholder[data-guide-active],[data-scient-math-slot][data-guide-active]",
    ),
  ].filter(
    (slot) =>
      slot.hasAttribute("data-scient-math-cell") ||
      !slot.closest("[data-scient-math-cell][data-empty]"),
  );
  const rectFor = (slot: HTMLElement) => {
    const bounds = slot.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(slot).fontSize) * scale;
    if (slot.hasAttribute("data-scient-math-cell")) {
      const baseline = parseFloat(slot.style.getPropertyValue("--scient-guide-baseline"));
      return new DOMRect(
        bounds.left + 0.175 * em,
        Number.isFinite(baseline) ? bounds.top + baseline * scale - 0.675 * em : bounds.top,
        0.6 * em,
        0.75 * em,
      );
    }
    return new DOMRect(
      bounds.left + (bounds.width - 0.6 * em) / 2,
      bounds.top + (bounds.height - 0.75 * em) / 2,
      0.6 * em,
      0.75 * em,
    );
  };
  const rects = empty.map(rectFor);
  // Keep the identical empty-slot marker when the caret enters that slot.
  if (empty.some((slot) => slot.hasAttribute("data-guide-current"))) return rects;
  if (math.hasAttribute("data-scient-empty")) {
    const caret = root.querySelector<HTMLElement>(".ML__caret,.ML__text-caret");
    if (caret) {
      const bounds = caret.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(caret).fontSize) * scale;
      rects.push(
        new DOMRect(bounds.left - 0.3 * em, bounds.bottom - 0.675 * em, 0.6 * em, 0.75 * em),
      );
      return rects;
    }
  }
  const scope = mathEditingScopes(math)[0];
  // The first offset is a caret anchor, not slot content. Its zero-height
  // sentinel can resolve to the enclosing accent, delimiter, or previous atom.
  if (scope) rects.push(...mathScopeRects(math, scope.range, true));
  return rects;
}

export function installMathEditingGuides(math: MathfieldElement): () => void {
  const root = math.shadowRoot;
  if (!root) return () => {};
  math.placeholderSymbol = emptySlotCharacter;
  const style = document.createElement("style");
  style.textContent = `
    :host :is(.ML__caret,.ML__text-caret,.ML__latex-caret)::after {
      --_caret-width: 1px;
      border-radius: 0;
      border-right-color: currentColor;
    }
    :host(:is([data-scient-selection-held],[data-scient-selection-active])) :is(.ML__caret,.ML__text-caret,.ML__latex-caret)::after {
      visibility: hidden;
      animation: none;
    }
    /* Scale only the painted caret, preserving its baseline and layout box. */
    :is(.ML__caret,.ML__text-caret)[data-scient-accent-body]::after {
      transform: scaleY(.85);
      transform-origin: center bottom;
    }
    /* Reserve targets from the first render, before the observer decorates
       cells. Focus, selection and guide updates must not resize the formula. */
    ${cellSelector} {
      min-width: .95em;
      box-sizing: border-box;
      position: relative;
    }
    .ML__placeholder, [data-scient-math-slot] {
      color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
      position: relative;
    }
    [data-scient-math-cell][data-empty] :is(.ML__placeholder,[data-scient-math-slot])::after {
      display: none;
    }
    [data-scient-math-cell][data-empty] .ML__empty-line-anchor::after {
      display: none;
    }
    :host([data-scient-empty]) .ML__empty-line-anchor::after {
      display: none;
    }
    @media print {
      [data-scient-math-cell]::after, .ML__placeholder::after, [data-scient-math-slot]::after,
      .ML__caret::after, .ML__text-caret::after, .ML__latex-caret::after {
        display: none !important;
      }
    }
  `;
  root.append(style);
  let frame = 0;
  const update = () => {
    frame = 0;
    const caret = root.querySelector(".ML__caret,.ML__text-caret");
    const inAccentBody = mathCaretInAccentBody(math);
    for (const caret of root.querySelectorAll(".ML__caret,.ML__text-caret"))
      caret.toggleAttribute("data-scient-accent-body", inAccentBody);
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
    const activeCell = mathSelectionAtOffset(math, math.position).path.at(-1);
    const activeId = activeCell?.array.id;
    const activeWrapper = activeId
      ? root.querySelector(`[data-atom-id="${CSS.escape(activeId)}"]`)
      : null;
    const activeTable = activeWrapper?.matches(".ML__mtable")
      ? activeWrapper
      : (activeWrapper?.querySelector(".ML__mtable") ??
        root.querySelector(".ML__caret,.ML__placeholder-selected")?.closest(".ML__mtable") ??
        null);
    const activeColumn =
      activeCell && activeTable
        ? [...activeTable.children].filter((element) =>
            element.matches(".col-align-l,.col-align-c,.col-align-r"),
          )[activeCell.column]
        : null;
    const currentCell = activeCell
      ? [...(activeColumn?.querySelectorAll(cellSelector) ?? [])].filter(
          (cell) => cell.closest(".ML__mtable") === activeTable,
        )[activeCell.row]
      : null;
    const guideScopeId = mathGuideScopeId(math);
    const guideScope = guideScopeId
      ? root.querySelector(`[data-atom-id="${CSS.escape(guideScopeId)}"]`)
      : formula;
    for (const slot of root.querySelectorAll(".ML__placeholder,[data-scient-math-slot]")) {
      slot.toggleAttribute(
        "data-guide-active",
        Boolean(guideScope?.contains(slot)) && slot.closest(".ML__mtable") === activeTable,
      );
      if (caret || !math.hasAttribute("data-scient-selection-held"))
        slot.toggleAttribute(
          "data-guide-current",
          Boolean(caret) &&
            (slot.contains(caret) ||
              slot === caret?.previousElementSibling ||
              slot.parentElement === caret?.parentElement),
        );
    }
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
      cell.toggleAttribute(
        "data-guide-active",
        Boolean(guideScope?.contains(cell)) && cell.closest(".ML__mtable") === activeTable,
      );
      cell.toggleAttribute(
        "data-guide-current",
        cell === currentCell || Boolean(caret && cell.contains(caret)),
      );
    }
    // Decoration follows MathLive's render; repaint after the slot measurements
    // are ready without changing selection, source, or document history.
    math.dispatchEvent(new CustomEvent("scient-latex-selection-change", { bubbles: true }));
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
    for (const caret of root.querySelectorAll("[data-scient-accent-body]"))
      caret.removeAttribute("data-scient-accent-body");
    style.remove();
  };
}
