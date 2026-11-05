import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

interface InputActivity {
  readonly element: HTMLElement;
  readonly chat: boolean;
  quietAt: number;
  composing: boolean;
  dragging: boolean;
}
const activities = new Set<InputActivity>();
const QUIET_MS = 150;
const CHAT_QUIET_MS = 500;
const chatListeners = new Set<() => void>();

export function chatInputQuietDelay(): number {
  let delay = 0;
  let focused = false;
  for (const activity of activities) {
    if (!activity.chat || !activity.element.contains(activity.element.ownerDocument.activeElement))
      continue;
    focused = true;
    delay = Math.max(
      delay,
      activity.composing || activity.dragging
        ? CHAT_QUIET_MS
        : activity.quietAt - performance.now(),
    );
  }
  const scheduling =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { scheduling?: { isInputPending(): boolean } }).scheduling;
  if (focused && scheduling?.isInputPending()) delay = Math.max(delay, 16);
  return Math.max(0, delay);
}

export function afterChatInputQuiet(callback: () => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, chatInputQuietDelay());
  };
  const stop = () => {
    active = false;
    clearTimeout(timer);
    chatListeners.delete(schedule);
  };
  const run = () => {
    if (!active) return;
    if (chatInputQuietDelay() > 0) schedule();
    else {
      stop();
      callback();
    }
  };
  chatListeners.add(schedule);
  schedule();
  return stop;
}

export function waitForChatInputQuiet(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      cancel();
      reject(signal.reason);
    };
    const cancel = afterChatInputQuiet(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Omit the element for work sharing the renderer with every registered editor. */
export function inputQuietDelay(element?: Element): number {
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

export function afterInputQuiet(callback: () => void, element?: Element): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const run = () => {
    if (!active) return;
    const delay = inputQuietDelay(element);
    if (delay > 0) timer = setTimeout(run, delay);
    else {
      active = false;
      callback();
    }
  };
  timer = setTimeout(run, inputQuietDelay(element));
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

function observeInputActivity(element: HTMLElement, chat: boolean): () => void {
  const activity: InputActivity = {
    element,
    chat,
    quietAt: 0,
    composing: false,
    dragging: false,
  };
  activities.add(activity);
  const input = () => {
    activity.quietAt = performance.now() + (chat ? CHAT_QUIET_MS : QUIET_MS);
    if (chat) for (const notify of chatListeners) notify();
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
    if (chat) {
      activity.quietAt = 0;
      for (const notify of chatListeners) notify();
    }
  };
  element.addEventListener("beforeinput", input, true);
  element.addEventListener("keydown", input, true);
  element.addEventListener("compositionstart", startComposition, true);
  element.addEventListener("compositionend", endComposition, true);
  element.addEventListener("pointerdown", down, true);
  element.addEventListener("focusout", blur);
  element.ownerDocument.addEventListener("pointerup", up, true);
  element.ownerDocument.addEventListener("pointercancel", up, true);
  element.ownerDocument.defaultView?.addEventListener("blur", blur);
  return () => {
    activities.delete(activity);
    if (chat) for (const notify of chatListeners) notify();
    element.removeEventListener("beforeinput", input, true);
    element.removeEventListener("keydown", input, true);
    element.removeEventListener("compositionstart", startComposition, true);
    element.removeEventListener("compositionend", endComposition, true);
    element.removeEventListener("pointerdown", down, true);
    element.removeEventListener("focusout", blur);
    element.ownerDocument.removeEventListener("pointerup", up, true);
    element.ownerDocument.removeEventListener("pointercancel", up, true);
    element.ownerDocument.defaultView?.removeEventListener("blur", blur);
  };
}

export function prioritizeChatInput(element: HTMLElement): () => void {
  return observeInputActivity(element, true);
}

export const InputPriority = Extension.create<{ chat: boolean }>({
  name: "inputPriority",
  addOptions: () => ({ chat: false }),
  addProseMirrorPlugins() {
    const chat = this.options.chat;
    return [
      new Plugin({
        view(view) {
          return { destroy: observeInputActivity(view.dom, chat) };
        },
      }),
    ];
  },
});
