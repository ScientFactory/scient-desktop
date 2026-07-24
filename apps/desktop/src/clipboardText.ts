// FILE: clipboardText.ts
// Purpose: Validate bounded renderer text before it reaches Electron's native clipboard.
// Layer: Desktop main-process helper

export const MAX_CLIPBOARD_TEXT_LENGTH = 1024 * 1024;

export function normalizeClipboardText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value.length <= MAX_CLIPBOARD_TEXT_LENGTH ? value : null;
}
