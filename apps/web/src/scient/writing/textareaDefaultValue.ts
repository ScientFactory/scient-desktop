/**
 * React copies a controlled textarea's value into `defaultValue` after every change, which
 * replaces the textarea's text node. Chromium then re-matches the app's `:has()` rules against
 * the whole document on each keystroke. A default equal to the shown value changes nothing
 * visible, so that write is skipped.
 */
export function skipMirroredTextareaDefaults(): () => void {
  const prototype = HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "defaultValue");
  const set = descriptor?.set;
  if (!descriptor || !set) return () => {};
  Object.defineProperty(prototype, "defaultValue", {
    ...descriptor,
    set(this: HTMLTextAreaElement, value: string) {
      if (value !== this.value) set.call(this, value);
    },
  });
  return () => Object.defineProperty(prototype, "defaultValue", descriptor);
}
