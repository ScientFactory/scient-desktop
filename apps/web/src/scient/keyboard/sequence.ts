import { eventStroke, isMacKeyboard, normalizeKeys } from "./keys";
import { getKeyboardPreferences, surfaceBindings } from "./preferences";
import type { KeyboardScope } from "./catalog";

/** Pure peek and one consuming transition; callers preserve their own transaction/history. */
export class ShortcutSequence {
  private prefix = "";
  private started = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private bindingsSnapshot: ReturnType<typeof getKeyboardPreferences> | undefined;
  private normalized: readonly { keys: string; command: string }[] = [];
  private bindings() {
    const snapshot = getKeyboardPreferences();
    if (snapshot !== this.bindingsSnapshot) {
      this.bindingsSnapshot = snapshot;
      this.normalized = surfaceBindings(this.scope, this.mac).map((binding) => ({
        keys: normalizeKeys(binding.keys, this.mac),
        command: binding.command,
      }));
    }
    return this.normalized;
  }
  constructor(
    private readonly scope: KeyboardScope,
    private readonly feedback: (text: string) => void = () => {},
    private readonly mac = isMacKeyboard(),
  ) {}
  peek(event: KeyboardEvent): { command?: string; prefix?: string; cancel?: boolean } | null {
    if (event.defaultPrevented || event.isComposing || event.getModifierState?.("AltGraph"))
      return null;
    const prefix =
      Date.now() - this.started < getKeyboardPreferences().preferences.sequenceTimeoutMs
        ? this.prefix
        : "";
    if (prefix && event.key === "Escape") return { cancel: true };
    const stroke = eventStroke(event, Boolean(prefix));
    if (!stroke) return null;
    const keys = prefix ? prefix + " " + stroke : stroke;
    const bindings = this.bindings();
    const exact = bindings.find((binding) => binding.keys === keys);
    if (exact) return { command: exact.command };
    if (bindings.some((binding) => binding.keys.startsWith(keys + " "))) return { prefix: keys };
    return prefix ? { cancel: true } : null;
  }
  handle(event: KeyboardEvent, execute: (command: string) => boolean): boolean {
    const result = this.peek(event);
    if (!result) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return true;
    if (result.prefix) {
      this.cancel();
      this.prefix = result.prefix;
      this.started = Date.now();
      const next = this.bindings()
        .filter((binding) => binding.keys.startsWith(this.prefix + " "))
        .map((binding) => binding.keys.slice(this.prefix.length + 1).split(" ")[0]);
      this.feedback(`${this.prefix} … Next: ${[...new Set(next)].join(", ")}. Escape cancels.`);
      this.timer = setTimeout(
        () => this.cancel(),
        getKeyboardPreferences().preferences.sequenceTimeoutMs,
      );
    } else {
      this.cancel();
      if (result.command && !execute(result.command))
        this.feedback("This command is unavailable at the current selection.");
      else if (result.cancel && event.key !== "Escape")
        this.feedback("Shortcut cancelled; the document was not changed.");
    }
    return true;
  }
  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.prefix = "";
    this.feedback("");
  }
}
