import type { ChangeEvent } from "react";

import { capitalizeTypedSectionName } from "./logic";

/**
 * The value to keep after a section-name input changes, with its first letter
 * capitalized as typed. Rewrites the field in place so the caret stays put,
 * and leaves IME composition alone.
 */
export function readTypedSectionName(
  event: ChangeEvent<HTMLInputElement>,
  previous: string,
): string {
  const input = event.currentTarget;
  if ((event.nativeEvent as InputEvent).isComposing) return input.value;
  const next = capitalizeTypedSectionName(previous, input.value);
  if (next !== input.value) {
    const { selectionStart, selectionEnd } = input;
    input.value = next;
    input.setSelectionRange(selectionStart, selectionEnd);
  }
  return next;
}
