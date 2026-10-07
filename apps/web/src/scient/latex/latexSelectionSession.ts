import { isLatexEditingMenuEvent } from "./latexContextEvents";

export type LatexSelectionCommand =
  | "selectionExpand"
  | "selectionShrink"
  | "leaveParentBefore"
  | "leaveParentAfter";
export function latexSelectionCommand(id: string): LatexSelectionCommand | null {
  const command = id.replace(/^latex\./u, "");
  return ["selectionExpand", "selectionShrink", "leaveParentBefore", "leaveParentAfter"].includes(
    command,
  )
    ? (command as LatexSelectionCommand)
    : null;
}

export interface LatexSelectionSnapshot {
  readonly path: readonly string[];
  readonly scopes: () => readonly DOMRect[];
  readonly selection: () => readonly DOMRect[];
  readonly selectionOverlay?: boolean;
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
const parentHistory: { participant: Participant; snapshot: LatexSelectionSnapshot }[] = [];
const clearParentHistory = () => {
  parentHistory.length = 0;
};
const workspace = (participant: Participant | null) =>
  participant?.element.closest(".scient-latex-visual-workspace");

function paint() {
  frame = 0;
  // Toolbar buttons may prevent focus transfer. Only actual menu focus needs
  // an inactive selection; continued editing must use the live selection.
  if (held && active?.element.matches(":focus-within")) release();
  const root = workspace(active);
  const snapshot = held ?? active?.capture();
  if (!root || !snapshot || !active?.element.isConnected) {
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
  const clip = viewport.getBoundingClientRect();
  const boxes = (rects: readonly DOMRect[], kind: string) =>
    rects.flatMap((rect) => {
      const left = Math.max(clip.left, rect.left),
        top = Math.max(clip.top, rect.top);
      const right = Math.min(clip.right, rect.right),
        bottom = Math.min(clip.bottom, rect.bottom);
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
  overlay.replaceChildren(
    ...boxes(snapshot.scopes(), "scient-latex-scope-outline"),
    ...(held || snapshot.selectionOverlay
      ? boxes(
          snapshot.selection(),
          held ? "scient-latex-retained-selection" : "scient-latex-cell-selection",
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
}
function hold() {
  if (!held) held = active?.capture() ?? null;
  if (held) active?.element.setAttribute("data-scient-selection-held", "");
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
  } else if (!handled && command !== "selectionShrink") {
    const child = active;
    const snapshot = child.capture();
    for (let parent = child.element.parentElement; parent; parent = parent.parentElement) {
      const participant = [...participants].find((candidate) => candidate.element === parent);
      if (participant?.command(command)) {
        if (snapshot && command === "selectionExpand")
          parentHistory.push({ participant: child, snapshot });
        active = participant;
        handled = true;
        break;
      }
    }
  }
  schedule();
  return handled;
}
