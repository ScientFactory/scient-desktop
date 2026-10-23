import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

interface InputActivity {
  readonly element: HTMLElement;
  quietAt: number;
  composing: boolean;
  dragging: boolean;
}
const activities = new Set<InputActivity>();
const QUIET_MS = 150;

/** Speculative work waits; input, visible layout and explicit commands stay immediate. */
export function latexInputQuietDelay(element?: Element): number {
  let delay = 0;
  for (const activity of activities) {
    if (element && !activity.element.contains(element)) continue;
    delay = Math.max(
      delay,
      activity.composing || activity.dragging ? QUIET_MS : activity.quietAt - performance.now(),
    );
  }
  return Math.max(0, delay);
}

export function afterLatexInputQuiet(callback: () => void, element?: Element): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const run = () => {
    if (!active) return;
    const delay = latexInputQuietDelay(element);
    if (delay > 0) timer = setTimeout(run, delay);
    else {
      active = false;
      callback();
    }
  };
  timer = setTimeout(run, latexInputQuietDelay(element));
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

export const LatexInputPriority = Extension.create({
  name: "latexInputPriority",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          const activity: InputActivity = {
            element: view.dom,
            quietAt: 0,
            composing: false,
            dragging: false,
          };
          activities.add(activity);
          const input = () => {
            activity.quietAt = performance.now() + QUIET_MS;
          };
          const startComposition = () => {
            activity.composing = true;
            input();
          };
          const endComposition = () => {
            activity.composing = false;
            input();
          };
          const down = (event: PointerEvent) => {
            if (event.button === 0) {
              activity.dragging = true;
              input();
            }
          };
          const up = () => {
            if (activity.dragging) {
              activity.dragging = false;
              input();
            }
          };
          const blur = () => {
            activity.composing = activity.dragging = false;
          };
          view.dom.addEventListener("beforeinput", input, true);
          view.dom.addEventListener("keydown", input, true);
          view.dom.addEventListener("compositionstart", startComposition, true);
          view.dom.addEventListener("compositionend", endComposition, true);
          view.dom.addEventListener("pointerdown", down, true);
          view.dom.ownerDocument.addEventListener("pointerup", up, true);
          view.dom.ownerDocument.addEventListener("pointercancel", up, true);
          view.dom.ownerDocument.defaultView?.addEventListener("blur", blur);
          return {
            destroy() {
              activities.delete(activity);
              view.dom.removeEventListener("beforeinput", input, true);
              view.dom.removeEventListener("keydown", input, true);
              view.dom.removeEventListener("compositionstart", startComposition, true);
              view.dom.removeEventListener("compositionend", endComposition, true);
              view.dom.removeEventListener("pointerdown", down, true);
              view.dom.ownerDocument.removeEventListener("pointerup", up, true);
              view.dom.ownerDocument.removeEventListener("pointercancel", up, true);
              view.dom.ownerDocument.defaultView?.removeEventListener("blur", blur);
            },
          };
        },
      }),
    ];
  },
});
