/**
 * Marks a textarea whose owner never uses its native default value or form reset. React copies
 * a controlled textarea's value into `defaultValue` after every change, replacing its text node,
 * and Chromium then re-matches the app's `:has()` rules against the whole document on each key.
 */
export const SKIP_MIRRORED_DEFAULT = { "data-skip-mirrored-default": "" } as const;

/** Marked textareas ignore a default equal to the text they already show. */
export function installMirroredDefaultSkip(document: Document): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "defaultValue");
  const skip = (event: FocusEvent) => {
    const textarea = event.target;
    if (
      !descriptor?.get ||
      !descriptor.set ||
      !(textarea instanceof HTMLTextAreaElement) ||
      !textarea.hasAttribute("data-skip-mirrored-default") ||
      Object.hasOwn(textarea, "defaultValue")
    )
      return;
    const { get, set } = descriptor;
    Object.defineProperty(textarea, "defaultValue", {
      configurable: true,
      get: () => get.call(textarea),
      set: (value: string) => {
        if (value.replace(/\r\n?/gu, "\n") !== textarea.value) set.call(textarea, value);
      },
    });
  };
  document.addEventListener("focusin", skip, true);
  return () => document.removeEventListener("focusin", skip, true);
}
