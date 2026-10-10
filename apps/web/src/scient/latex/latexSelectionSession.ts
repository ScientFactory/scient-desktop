import { isLatexEditingMenuEvent } from "./latexContextEvents";

export type LatexSelectionCommand =
  | "selectionExpand"
  | "selectionScopeExpand"
  | "selectionShrink"
  | "enterScope"
  | "leaveParentBefore"
  | "leaveParentAfter";
export function latexSelectionCommand(id: string): LatexSelectionCommand | null {
  const command = id.replace(/^latex\./u, "");
  return [
    "selectionExpand",
    "selectionScopeExpand",
    "selectionShrink",
    "enterScope",
    "leaveParentBefore",
    "leaveParentAfter",
  ].includes(command)
    ? (command as LatexSelectionCommand)
    : null;
}

export interface LatexSelectionSnapshot {
  readonly path: readonly string[];
  readonly scopes: () => readonly DOMRect[];
  /** Vacant slots remain identifiable while their contents are selected. */
  readonly emptyScopes?: () => readonly DOMRect[];
  /** The other vacant slots while editing, marked lighter than the current scope. */
  readonly vacantScopes?: () => readonly DOMRect[];
  readonly scopePadding?: number;
  readonly selection: () => readonly DOMRect[];
  /** False means the surface paints its selection even while a menu owns focus. */
  readonly selectionOverlay?: boolean;
  readonly selectionKind?: "text" | "cells";
  /** False means the underlying document/model was replaced. Never replay stale offsets. */
  readonly restore: (focus: boolean) => boolean;
}
interface Participant {
  readonly element: HTMLElement;
  readonly capture: () => LatexSelectionSnapshot | null;
  readonly enterFrom?: (child: HTMLElement) => void;
  readonly command: (command: LatexSelectionCommand) => boolean;
}

const participants = new Set<Participant>();
let active: Participant | null = null;
let held: LatexSelectionSnapshot | null = null;
let overlay: HTMLDivElement | null = null;
let frame = 0;
let disposeListeners: (() => void) | null = null;
let presentation: Participant | null = null;
let guideOwner: HTMLElement | null = null;
const parentHistory: { participant: Participant; snapshot: LatexSelectionSnapshot }[] = [];
const clearParentHistory = () => {
  parentHistory.length = 0;
};
const workspace = (participant: Participant | null) =>
  participant?.element.closest(".scient-latex-visual-workspace");
const participantGuide = (participant: Participant | null) =>
  participant?.element.closest<HTMLElement>(
    "math-field,.scient-latex-rich-preview,.scient-latex-title-preview," +
      ".scient-latex-abstract-preview,.scient-latex-simple-preview,.scient-latex-scientific-structure",
  ) ?? null;

function present(participant: Participant | null, selected = false, selectionOverlay = false) {
  if (presentation !== participant) {
    presentation?.element.removeAttribute("data-scient-active-slot");
    presentation?.element.removeAttribute("data-scient-selection-active");
    presentation?.element.removeAttribute("data-scient-selection-overlay");
    presentation = participant;
  }
  const next = participantGuide(participant);
  if (next !== guideOwner) {
    guideOwner?.removeAttribute("data-scient-editing-guides");
    guideOwner?.removeAttribute("data-scient-selection-active");
    guideOwner = next;
  }
  participant?.element.toggleAttribute("data-scient-active-slot", true);
  participant?.element.toggleAttribute("data-scient-selection-active", selected);
  participant?.element.toggleAttribute("data-scient-selection-overlay", selectionOverlay);
  guideOwner?.toggleAttribute("data-scient-editing-guides", true);
  guideOwner?.toggleAttribute("data-scient-selection-active", selected);
}

// Guides sit outside what they mark, so the marked text stays readable: the
// current scope a little further out and darker than the other vacant slots.
// The current margin grows with what it surrounds, so a letter's tail or a
// word's capitals never touch the corners at any zoom.
const VACANT_GUIDE_MARGIN = 1;
function currentGuideMargin(rect: DOMRect, scale: number): number {
  return Math.min(7 * scale, Math.max(3.5 * scale, rect.height * 0.2625));
}

let measureContext: CanvasRenderingContext2D | null = null;

/** Where an empty field's text would be: its hint word, or one letter's room. */
function emptyFieldGuideRect(field: HTMLInputElement | HTMLTextAreaElement): DOMRect {
  const bounds = field.getBoundingClientRect();
  const style = getComputedStyle(field);
  const scale = bounds.width / (field.offsetWidth || 1);
  const em = parseFloat(style.fontSize) * scale;
  const paddingLeft = parseFloat(style.paddingLeft) * scale;
  const paddingRight = parseFloat(style.paddingRight) * scale;
  let width = 0.6 * em;
  if (field.placeholder) {
    measureContext ??= document.createElement("canvas").getContext("2d");
    if (measureContext) {
      measureContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      width = Math.min(
        bounds.width - paddingLeft - paddingRight,
        measureContext.measureText(field.placeholder).width * scale,
      );
    }
  }
  const rightAligned =
    style.textAlign === "right" ||
    (style.textAlign === "start" && style.direction === "rtl") ||
    (style.textAlign === "end" && style.direction !== "rtl");
  const left =
    style.textAlign === "center"
      ? bounds.left + (bounds.width - width) / 2
      : rightAligned
        ? bounds.right - paddingRight - width
        : bounds.left + paddingLeft;
  const lineHeight = (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2) * scale;
  const height = (field.placeholder ? 0.9 : 0.75) * em;
  return new DOMRect(
    left,
    bounds.top + parseFloat(style.paddingTop) * scale + (lineHeight - height) / 2,
    width,
    height,
  );
}

function emptyTextFields(owner: HTMLElement | null) {
  if (!owner || owner.matches('math-field,.scient-latex-rich-preview[data-kind="table"]'))
    return [];
  return [
    ...owner.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input[data-empty]:enabled,textarea[data-empty]:enabled",
    ),
  ].filter((field) => !field.value && !field.readOnly && !field.closest("td,th"));
}

function paint() {
  frame = 0;
  // Toolbar buttons may prevent focus transfer. Only actual menu focus needs
  // an inactive selection; continued editing must use the live selection.
  if (held && active?.element.matches(":focus-within")) release();
  const root = workspace(active);
  const snapshot = held ?? active?.capture();
  if (!root || !snapshot || !active?.element.isConnected) {
    present(null);
    overlay?.replaceChildren();
    return;
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "scient-latex-selection-overlay";
    overlay.setAttribute("aria-hidden", "true");
  }
  // Paint in the same scrolling layer as the ink. A fixed body overlay waits
  // for main-thread measurement while compositor scrolling moves the page.
  // Math's own viewport carries its overlay during horizontal panning too.
  const anchor =
    active.element.closest(".scient-latex-mathfield") ??
    active.element.closest(".scient-latex-page-zoom-frame") ??
    active.element.closest(".scient-latex-visual-scroll") ??
    root;
  if (overlay.parentElement !== anchor) anchor.append(overlay);
  // The layer is one CSS pixel square. Its measured dimensions give the exact
  // ancestor scale without offsetWidth rounding at fractional document zoom.
  const origin = overlay.getBoundingClientRect();
  if (origin.width <= 0 || origin.height <= 0) {
    overlay.replaceChildren();
    return;
  }
  const boxes = (
    rects: readonly DOMRect[],
    kind: string,
    scopePadding = snapshot.scopePadding,
    vacant = false,
  ) =>
    rects.flatMap((rect) => {
      const padding =
        kind === "scient-latex-scope-outline"
          ? scopePadding === undefined
            ? currentGuideMargin(rect, origin.height)
            : scopePadding * origin.height
          : 0;
      // Keep complete rectangles, including offscreen ones. The scrolling
      // ancestors clip them natively; truncating at today's viewport edges
      // would leave cut-off highlights when that content scrolls into view.
      const left = rect.left - padding,
        top = rect.top - padding;
      const right = rect.right + padding,
        bottom = rect.bottom + padding;
      if (right < left || bottom <= top) return [];
      const box = document.createElement("span");
      box.className = kind;
      if (vacant) box.dataset.guide = "vacant";
      Object.assign(box.style, {
        left: `${(left - origin.left) / origin.width}px`,
        top: `${(top - origin.top) / origin.height}px`,
        width: `${Math.max(2, right - left) / origin.width}px`,
        height: `${(bottom - top) / origin.height}px`,
      });
      return [box];
    });
  const selection = snapshot.selection();
  const documentStyle = getComputedStyle(
    active.element.closest(".scient-latex-visual-document") ?? root,
  );
  const colors = [
    "--scient-latex-selection-background",
    "--scient-latex-cell-selection-background",
    "--scient-latex-retained-selection-background",
  ].map((name) => [name, documentStyle.getPropertyValue(name)] as const);
  const activeField =
    active.element instanceof HTMLInputElement || active.element instanceof HTMLTextAreaElement
      ? active.element
      : null;
  const emptyFields = emptyTextFields(guideOwner);
  const vacantText = emptyFields.filter((field) => field !== activeField).map(emptyFieldGuideRect);
  // An empty field being typed in is framed around its hint word.
  const current =
    activeField && !activeField.value && !activeField.closest("td,th")
      ? [emptyFieldGuideRect(activeField)]
      : snapshot.scopes();
  const children = [
    ...(selection.length
      ? boxes(
          snapshot.emptyScopes?.() ?? [],
          "scient-latex-scope-outline",
          VACANT_GUIDE_MARGIN,
          true,
        )
      : [
          ...boxes(
            [...vacantText, ...(snapshot.vacantScopes?.() ?? [])],
            "scient-latex-scope-outline",
            VACANT_GUIDE_MARGIN,
            true,
          ),
          ...boxes(current, "scient-latex-scope-outline"),
        ]),
    ...((held && snapshot.selectionOverlay !== false) || snapshot.selectionOverlay
      ? boxes(
          selection,
          held
            ? "scient-latex-retained-selection"
            : snapshot.selectionKind === "cells"
              ? "scient-latex-cell-selection"
              : "scient-latex-range-selection",
        )
      : []),
  ];
  // Finish ink, guide and color reads before presentation changes invalidate
  // styles. In particular, computed styles are live: read all three colors
  // before writing any overlay variable, rather than flushing after each one.
  present(active, selection.length > 0, snapshot.selectionOverlay === true);
  for (const [name, value] of [["--scient-scope-pixel", `${1 / origin.width}px`], ...colors])
    if (overlay.style.getPropertyValue(name) !== value) overlay.style.setProperty(name, value);
  overlay.toggleAttribute("data-scient-selection-held", Boolean(held));
  overlay.replaceChildren(...children);
  root.dispatchEvent(new CustomEvent("scient-latex-selection-scope", { detail: snapshot.path }));
}
function schedule() {
  if (!frame) frame = requestAnimationFrame(paint);
}
function scrolled(event: Event) {
  const anchor = overlay?.parentElement;
  if (!anchor || !overlay?.isConnected) {
    schedule();
    return;
  }
  const target = event.target;
  // Ancestor scrolling already moves the layer and clips it with the content.
  // Only scrolling within the anchored content (such as a textarea) changes
  // the measured selection relative to that layer.
  if (target === document || (target instanceof Element && target.contains(anchor))) return;
  if (target instanceof Element && anchor.contains(target)) schedule();
}
function release() {
  held = null;
  active?.element.removeAttribute("data-scient-selection-held");
  workspace(active)?.removeAttribute("data-scient-selection-held");
}
function hold() {
  if (!held) held = active?.capture() ?? null;
  if (held) {
    active?.element.setAttribute("data-scient-selection-held", "");
    workspace(active)?.setAttribute("data-scient-selection-held", "");
  }
  schedule();
}
function activate(event: Event) {
  if (active && isLatexEditingMenuEvent(event, active.element)) {
    hold();
    return;
  }
  const path = event.composedPath();
  if (event.type === "pointerdown") parentHistory.length = 0;
  const next = path
    .flatMap((target) =>
      target instanceof HTMLElement
        ? [...participants].filter((participant) => participant.element === target)
        : [],
    )
    .at(0);
  if (next) {
    // Programmatic focus from a menu must replay the held range before it is
    // released. A pointer into the paper has already discarded that snapshot.
    const retained = event.type === "focusin" && next === active ? held : null;
    if (workspace(active) !== workspace(next)) {
      workspace(active)?.dispatchEvent(
        new CustomEvent("scient-latex-selection-scope", { detail: [] }),
      );
      parentHistory.length = 0;
    }
    release();
    active = next;
    retained?.restore(false);
    schedule();
  } else {
    release();
    workspace(active)?.dispatchEvent(
      new CustomEvent("scient-latex-selection-scope", { detail: [] }),
    );
    active = null;
    schedule();
  }
}
function restore(event: Event) {
  if (!active || !held || !workspace(active)?.contains(event.target as Node)) return;
  const snapshot = held;
  release();
  snapshot.restore(event instanceof CustomEvent && event.detail === "focus");
  schedule();
}

/** One selection owner, even when keyboard focus is inside a portal or nested editor. */
export function registerLatexSelection(participant: Participant): {
  refresh: () => void;
  dispose: () => void;
} {
  participants.add(participant);
  // A node view may register after its field has already received focus.
  if (
    participant.element.matches(":focus-within") &&
    (!active || active.element.contains(participant.element))
  ) {
    release();
    active = participant;
    schedule();
  }
  if (!disposeListeners) {
    document.addEventListener("pointerdown", activate, true);
    document.addEventListener("focusin", activate, true);
    document.addEventListener("scient-writing-restore-selection", restore);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("scient-latex-selection-change", schedule);
    document.addEventListener("input", clearParentHistory, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", schedule);
    disposeListeners = () => {
      document.removeEventListener("pointerdown", activate, true);
      document.removeEventListener("focusin", activate, true);
      document.removeEventListener("scient-writing-restore-selection", restore);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scient-latex-selection-change", schedule);
      document.removeEventListener("input", clearParentHistory, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", schedule);
    };
  }
  return {
    refresh: () => {
      if (active === participant) schedule();
    },
    dispose: () => {
      participants.delete(participant);
      if (active === participant) {
        workspace(active)?.dispatchEvent(
          new CustomEvent("scient-latex-selection-scope", { detail: [] }),
        );
        release();
        active = null;
        schedule();
      }
      if (!participants.size) {
        present(null);
        disposeListeners?.();
        disposeListeners = null;
        cancelAnimationFrame(frame);
        frame = 0;
        overlay?.remove();
        overlay = null;
        parentHistory.length = 0;
      }
    },
  };
}

export function runLatexSelectionCommand(
  element: HTMLElement,
  command: LatexSelectionCommand,
): boolean {
  if (!active || workspace(active) !== element.closest(".scient-latex-visual-workspace"))
    return false;
  if (held) {
    const snapshot = held;
    release();
    if (!snapshot.restore(false)) return false;
  }
  let handled = active.command(command);
  if (!handled && command === "selectionShrink") {
    const previous = parentHistory.at(-1);
    if (previous && participants.has(previous.participant)) {
      parentHistory.pop();
      handled = previous.snapshot.restore(true);
      if (handled) active = previous.participant;
    }
  } else if (!handled && command !== "selectionShrink" && command !== "enterScope") {
    const child = active;
    const snapshot = child.capture();
    for (let parent = child.element.parentElement; parent; parent = parent.parentElement) {
      const participant = [...participants].find((candidate) => candidate.element === parent);
      participant?.enterFrom?.(child.element);
      if (participant?.command(command)) {
        if (snapshot && (command === "selectionExpand" || command === "selectionScopeExpand"))
          parentHistory.push({ participant: child, snapshot });
        active = participant;
        handled = true;
        break;
      }
    }
  }
  schedule();
  // Repeated Select All at the outermost scope keeps that selection.
  return handled || command === "selectionScopeExpand";
}
