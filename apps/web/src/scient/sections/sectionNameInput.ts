import type { ChangeEvent } from "react";

import { capitalizeSectionName } from "./logic";

/**
 * The value to keep after a section-name input changes, capitalized by the
 * same rule a saved name follows. Rewrites the field in place so the caret
 * stays put, and leaves IME composition alone.
 */
export function readTypedSectionName(event: ChangeEvent<HTMLInputElement>): string {
  const input = event.currentTarget;
  if ((event.nativeEvent as InputEvent).isComposing) return input.value;
  const next = capitalizeSectionName(input.value);
  if (next !== input.value) {
    const { selectionStart, selectionEnd } = input;
    input.value = next;
    input.setSelectionRange(selectionStart, selectionEnd);
  }
  return next;
}
