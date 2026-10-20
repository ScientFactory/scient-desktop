import type { MathfieldElement } from "mathlive";

/** MathLive repeats keyboard-sink focus after 60 ms. Preserve newer user focus
 * during that initial handoff rather than allowing its delayed callback to win. */
export function focusAdmittedMathField(math: MathfieldElement, fallback: HTMLElement) {
  const document = math.ownerDocument;
  let newer: HTMLElement | undefined;
  const pointer = (event: PointerEvent) => {
    if (!(event.target instanceof Element)) return;
    if (event.target === math || math.contains(event.target)) {
      // A new user click may return to the formula; delayed synthetic relay
      // still belongs to the original click and cannot supersede outside intent.
      if (event.isTrusted) newer = undefined;
      return;
    }
    newer =
      event.target.closest<HTMLElement>(
        "button,a[href],input,textarea,[tabindex],[contenteditable='true']",
      ) ?? fallback;
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Tab") newer = undefined;
  };
  const focus = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target === math || math.contains(event.target)) {
      if (newer?.isConnected) {
        event.stopImmediatePropagation();
        newer.focus({ preventScroll: true });
      }
    } else newer = event.target;
  };
  const cancel = () => {
    clearTimeout(timeout);
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("focus", focus, true);
    document.removeEventListener("keydown", key, true);
  };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("focus", focus, true);
  document.addEventListener("keydown", key, true);
  const timeout = setTimeout(cancel, 150);
  math.focus();
  const sink = math.shadowRoot?.querySelector<HTMLElement>(".ML__keyboard-sink");
  sink?.focus({ preventScroll: true });
  return cancel;
}
