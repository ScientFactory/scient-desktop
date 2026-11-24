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
      this.normalized = surfaceBindings(undefined, this.mac)
        .filter((binding) =>
          typeof this.scope === "string"
            ? binding.scope === this.scope
            : this.scope.includes(binding.scope),
        )
        .map((binding) => ({
          keys: normalizeKeys(binding.keys, this.mac),
          command: binding.command,
        }));
    }
    return this.normalized;
  }
  constructor(
    private readonly scope: KeyboardScope | readonly KeyboardScope[],
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
    // Saved logical strokes (including sequence prefixes) take precedence over
    // the two physical size defaults. Recording keeps the original key names.
    const overrides = getKeyboardPreferences().preferences.overrides;
    if (
      !prefix &&
      event.shiftKey &&
      !event.altKey &&
      (this.mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    ) {
      const symbol = event.code === "Period" ? "." : event.code === "Comma" ? "," : null;
      const saved = bindings.some(
        (binding) =>
          Object.hasOwn(overrides, binding.command) &&
          (binding.keys === keys || binding.keys.startsWith(keys + " ")),
      );
      if (symbol && !saved) {
        const physical = this.bindings().find(
          (binding) =>
            /\.fontSize(?:Larger|Smaller)$/u.test(binding.command) &&
            !Object.hasOwn(overrides, binding.command) &&
            binding.keys === normalizeKeys("mod+shift+" + symbol, this.mac),
        );
        if (physical) return { command: physical.command };
      }
    }
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
