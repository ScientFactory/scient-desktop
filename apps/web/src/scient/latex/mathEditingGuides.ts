import type { MathfieldElement } from "mathlive";
import {
  mathCaretRect,
  mathCaretInAccentBody,
  mathEmptySlotRect,
  mathEmptySlotOffset,
  mathGuideScopeId,
  mathEditingSlotRects,
  mathSelectionAtOffset,
} from "./mathLiveSelection";

// MathLive 0.108 lays out array columns with a VBox. Decorate its rendered
// cell boxes, never its atoms: empty guides must not enter source or undo.
export const mathArrayCellSelector =
  ".ML__mtable > :is(.col-align-l,.col-align-c,.col-align-r) > .ML__vlist-t > .ML__vlist-r:first-child > .ML__vlist > span > span:not(.ML__pstrut,.ML__caret,.ML__text-caret,[data-scient-math-caret-anchor])";
const cellSelector = mathArrayCellSelector;
// Figure space reserves a click target with no ink, even before decoration.
// MathLive can render placeholders as ordinary font boxes (for example in
// accents), so its ML__placeholder class is not a reliable slot selector.
const emptySlotCharacter = "\u2007";

function emptyGuideSlots(math: MathfieldElement): HTMLElement[] {
  const root = math.shadowRoot;
  if (!root || math.readOnly) return [];
  const offsets = new Set<number>();
  return [
    ...root.querySelectorAll<HTMLElement>(
      "[data-scient-math-cell][data-empty][data-guide-active],.ML__placeholder[data-guide-active],[data-scient-math-slot][data-guide-active]",
    ),
  ].filter((slot) => {
    if (
      !slot.hasAttribute("data-scient-math-cell") &&
      slot.closest("[data-scient-math-cell][data-empty]")
    )
      return false;
    // A placeholder may have both a native wrapper and a decorated glyph.
    // They represent one insertion stop and must contribute only one guide.
    const offset = mathEmptySlotOffset(math, slot);
    if (offset === null) return true;
    if (offsets.has(offset)) return false;
    offsets.add(offset);
    return true;
  });
}

/** Vacant guides survive cell selection; occupied scope guides do not. */
export function mathEmptyGuideRects(math: MathfieldElement): DOMRect[] {
  return emptyGuideSlots(math).map((slot) => mathEmptySlotRect(math, slot));
}

/** The other vacant slots while editing; the current one is drawn as the scope. */
export function mathVacantGuideRects(math: MathfieldElement): DOMRect[] {
  return emptyGuideSlots(math)
    .filter((slot) => !slot.hasAttribute("data-guide-current"))
    .map((slot) => mathEmptySlotRect(math, slot));
}

/** The current scope: the vacant slot holding the caret, or what the caret is in. */
export function mathEditingGuideRects(math: MathfieldElement): DOMRect[] {
  const root = math.shadowRoot;
  if (!root || math.readOnly) return [];
  const rects: DOMRect[] = [];
  // Keep the same measured marker when the caret enters a vacant slot.
  const current = emptyGuideSlots(math).find((slot) => slot.hasAttribute("data-guide-current"));
  if (current) return [mathEmptySlotRect(math, current)];
  if (math.hasAttribute("data-scient-empty")) {
    const caret = root.querySelector<HTMLElement>(".ML__caret,.ML__text-caret");
    if (caret) {
      const bounds = mathCaretRect(math, caret);
      const scale = math.getBoundingClientRect().width / (math.offsetWidth || 1);
      const em = parseFloat(getComputedStyle(caret).fontSize) * scale;
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      rects.push(new DOMRect(x - 0.3 * em, y - 0.375 * em, 0.6 * em, 0.75 * em));
      return rects;
    }
  }
  return mathEditingSlotRects(math);
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
    [data-scient-math-caret-anchor] {
      display: inline-block;
      position: relative;
      width: 0;
      height: 0;
      line-height: 0;
      vertical-align: baseline;
      pointer-events: none;
    }
    :is(.ML__caret,.ML__text-caret,[data-scient-math-caret-anchor])::after {
      height: .76em;
      left: -.045em;
      bottom: -.05em;
    }
    /* Read the same computed stroke metrics at each future insertion point. */
    [data-scient-math-caret-anchor]::after {
      content: '';
      position: absolute;
      width: 0;
      border-right: 1px solid transparent;
      visibility: hidden;
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
    const caret = root.querySelector<HTMLElement>(".ML__caret,.ML__text-caret");
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
    for (const slot of root.querySelectorAll<HTMLElement>(
      ".ML__placeholder,[data-scient-math-slot]",
    )) {
      slot.toggleAttribute(
        "data-guide-active",
        Boolean(guideScope?.contains(slot)) && slot.closest(".ML__mtable") === activeTable,
      );
      if (caret || !math.hasAttribute("data-scient-selection-held"))
        slot.toggleAttribute(
          "data-guide-current",
          (math.selectionIsCollapsed && mathEmptySlotOffset(math, slot) === math.position) ||
            Boolean(caret && slot.contains(caret)) ||
            Boolean(slot.closest(".ML__placeholder-selected")),
        );
    }
    for (const cell of root.querySelectorAll<HTMLElement>(cellSelector)) {
      cell.dataset.scientMathCell = "";
      const text = (cell.textContent ?? "").replace(/[\s\u200b\u2060]/gu, "");
      // A rule, root, or nested structure is meaningful even without text.
      const structure = cell.querySelector("svg,.ML__mtable,.ML__sqrt,.ML__frac");
      const empty = !text && !structure;
      cell.toggleAttribute("data-empty", empty);
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
  math.addEventListener("focusin", schedule);
  math.addEventListener("selection-change", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  // Font loading can change the ink bounds without changing MathLive's DOM.
  const resize = new ResizeObserver(schedule);
  resize.observe(math);
  schedule();
  return () => {
    math.removeEventListener("focusin", schedule);
    math.removeEventListener("selection-change", schedule);
    observer.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
    for (const caret of root.querySelectorAll("[data-scient-accent-body]"))
      caret.removeAttribute("data-scient-accent-body");
    for (const anchor of root.querySelectorAll("[data-scient-math-caret-anchor]")) anchor.remove();
    style.remove();
  };
}
