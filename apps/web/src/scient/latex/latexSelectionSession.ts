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

function present(participant: Participant | null, selected = false) {
  if (presentation !== participant) {
    presentation?.element.removeAttribute("data-scient-active-slot");
    presentation?.element.removeAttribute("data-scient-selection-active");
    presentation = participant;
  }
  const next =
    participant?.element.closest<HTMLElement>(
      "math-field,.scient-latex-rich-preview,.scient-latex-title-preview," +
        ".scient-latex-abstract-preview,.scient-latex-simple-preview,.scient-latex-scientific-structure",
    ) ?? null;
  if (next !== guideOwner) {
    guideOwner?.removeAttribute("data-scient-editing-guides");
    guideOwner?.removeAttribute("data-scient-selection-active");
    guideOwner = next;
  }
  participant?.element.toggleAttribute("data-scient-active-slot", true);
  participant?.element.toggleAttribute("data-scient-selection-active", selected);
  guideOwner?.toggleAttribute("data-scient-editing-guides", true);
  guideOwner?.toggleAttribute("data-scient-selection-active", selected);
}

function emptyTextGuideRects(owner: HTMLElement | null): DOMRect[] {
  if (!owner || owner.matches('math-field,.scient-latex-rich-preview[data-kind="table"]'))
    return [];
  return [
    ...owner.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input[data-empty]:enabled,textarea[data-empty]:enabled",
    ),
  ]
    .filter((field) => !field.value && !field.readOnly && !field.closest("td,th"))
    .map((field) => {
      const bounds = field.getBoundingClientRect();
      const style = getComputedStyle(field);
      const scale = bounds.width / (field.offsetWidth || 1);
      const em = parseFloat(style.fontSize) * scale;
      const paddingLeft = parseFloat(style.paddingLeft) * scale;
      const paddingRight = parseFloat(style.paddingRight) * scale;
      const width = 0.6 * em;
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
      return new DOMRect(
        left,
        bounds.top + parseFloat(style.paddingTop) * scale + (lineHeight - 0.75 * em) / 2,
        width,
        0.75 * em,
      );
    });
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
  root.dispatchEvent(new CustomEvent("scient-latex-selection-scope", { detail: snapshot.path }));
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "scient-latex-selection-overlay";
    overlay.setAttribute("aria-hidden", "true");
    document.body.append(overlay);
  }
  const viewport = active.element.closest(".scient-latex-visual-scroll") ?? root;
  const documentClip = viewport.getBoundingClientRect();
  const mathClip = active.element
    .closest(".scient-latex-mathfield[data-math-viewport-active]")
    ?.getBoundingClientRect();
  const clip = {
    left: Math.max(documentClip.left, mathClip?.left ?? documentClip.left),
    top: Math.max(documentClip.top, mathClip?.top ?? documentClip.top),
    right: Math.min(documentClip.right, mathClip?.right ?? documentClip.right),
    bottom: Math.min(documentClip.bottom, mathClip?.bottom ?? documentClip.bottom),
  };
  const boxes = (
    rects: readonly DOMRect[],
    kind: string,
    scopePadding = snapshot.scopePadding ?? 2,
  ) =>
    rects.flatMap((rect) => {
      const padding = kind === "scient-latex-scope-outline" ? scopePadding : 0;
      const left = Math.max(clip.left, rect.left - padding),
        top = Math.max(clip.top, rect.top - padding);
      const right = Math.min(clip.right, rect.right + padding),
        bottom = Math.min(clip.bottom, rect.bottom + padding);
      if (right < left || bottom <= top) return [];
      const box = document.createElement("span");
      box.className = kind;
      Object.assign(box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.max(2, right - left)}px`,
        height: `${bottom - top}px`,
      });
      return [box];
    });
  const selection = snapshot.selection();
  present(active, selection.length > 0);
  const documentStyle = getComputedStyle(
    active.element.closest(".scient-latex-visual-document") ?? root,
  );
  for (const name of [
    "--scient-latex-selection-background",
    "--scient-latex-cell-selection-background",
    "--scient-latex-retained-selection-background",
  ])
    overlay.style.setProperty(name, documentStyle.getPropertyValue(name));
  const emptyText = emptyTextGuideRects(guideOwner);
  const activeEmptyText =
    (active.element instanceof HTMLInputElement || active.element instanceof HTMLTextAreaElement) &&
    !active.element.value;
  overlay.toggleAttribute("data-scient-selection-held", Boolean(held));
  overlay.replaceChildren(
    ...(selection.length
      ? []
      : [
          ...boxes(emptyText, "scient-latex-scope-outline", 0),
          ...(activeEmptyText ? [] : boxes(snapshot.scopes(), "scient-latex-scope-outline")),
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
  );
}
function schedule() {
  if (!frame) frame = requestAnimationFrame(paint);
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
    if (workspace(active) !== workspace(next)) {
      workspace(active)?.dispatchEvent(
        new CustomEvent("scient-latex-selection-scope", { detail: [] }),
      );
      parentHistory.length = 0;
    }
    release();
    active = next;
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
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    disposeListeners = () => {
      document.removeEventListener("pointerdown", activate, true);
      document.removeEventListener("focusin", activate, true);
      document.removeEventListener("scient-writing-restore-selection", restore);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scient-latex-selection-change", schedule);
      document.removeEventListener("input", clearParentHistory, true);
      document.removeEventListener("scroll", schedule, true);
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
