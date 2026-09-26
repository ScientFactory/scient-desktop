import type { KeyboardScope } from "./catalog";
import { registerShortcutClaim } from "./ownership";
import { ShortcutSequence } from "./sequence";
import { subscribeKeyboardPreferences } from "./preferences";

export interface ShortcutHost {
  /** Availability and execution stay with the document, including its history. */
  execute(command: string, event: KeyboardEvent): boolean;
  accepts(event: KeyboardEvent, command?: string): boolean;
  /** Capture is for adapters which exclude other nested input owners. */
  capture?: boolean;
  /** Render announcements in existing editor chrome, outside the editable document. */
  feedback?: (text: string) => void;
  /** Reserve a recognized chord for a nested native input without rewriting the document. */
  native?: (event: KeyboardEvent, command?: string) => boolean;
}
export function attachShortcutHost(
  host: HTMLElement,
  scope: KeyboardScope | readonly KeyboardScope[],
  adapter: ShortcutHost,
): () => void {
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  status.setAttribute("data-shortcut-status", "");
  if (!adapter.feedback) host.append(status);
  const sequence = new ShortcutSequence(scope, (text) => {
    status.textContent = text;
    adapter.feedback?.(text);
  });
  const accepts = (event: KeyboardEvent) => {
    const match = sequence.peek(event);
    return match !== null && adapter.accepts(event, match.command);
  };
  const release = registerShortcutClaim(host, accepts);
  const unsubscribe = subscribeKeyboardPreferences(() => sequence.cancel());
  const keydown = (event: KeyboardEvent) => {
    if (adapter.native?.(event, sequence.peek(event)?.command)) return;
    if (accepts(event)) sequence.handle(event, (command) => adapter.execute(command, event));
  };
  const blur = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget))
      sequence.cancel();
  };
  // Capture adapters must explicitly exclude nested controls they do not own.
  host.addEventListener("keydown", keydown, adapter.capture ?? false);
  host.addEventListener("focusout", blur);
  return () => {
    release();
    unsubscribe();
    sequence.cancel();
    status.remove();
    host.removeEventListener("keydown", keydown, adapter.capture ?? false);
    host.removeEventListener("focusout", blur);
  };
}
