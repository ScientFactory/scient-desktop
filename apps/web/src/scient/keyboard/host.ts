import type { KeyboardScope } from "./catalog";
import { registerShortcutClaim } from "./ownership";
import { ShortcutSequence } from "./sequence";
import { subscribeKeyboardPreferences } from "./preferences";

export interface ShortcutHost {
  /** Availability and execution stay with the document, including its history. */
  execute(command: string, event: KeyboardEvent): boolean;
  accepts(event: KeyboardEvent, command?: string): boolean;
  /** Reserve a recognized chord for a nested native input without rewriting the document. */
  native?: (event: KeyboardEvent, command?: string) => boolean;
}
export function attachShortcutHost(
  host: HTMLElement,
  scope: KeyboardScope,
  adapter: ShortcutHost,
): () => void {
  const status = document.createElement("span");
  status.className = "text-xs text-muted-foreground";
  status.setAttribute("role", "status");
  status.setAttribute("data-shortcut-status", "");
  host.append(status);
  const sequence = new ShortcutSequence(scope, (text) => {
    status.textContent = text;
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
  // Bubble: nested editor controls get the first opportunity to consume input.
  host.addEventListener("keydown", keydown);
  host.addEventListener("focusout", blur);
  return () => {
    release();
    unsubscribe();
    sequence.cancel();
    status.remove();
    host.removeEventListener("keydown", keydown);
    host.removeEventListener("focusout", blur);
  };
}
