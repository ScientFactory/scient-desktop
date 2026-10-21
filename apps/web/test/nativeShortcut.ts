// Native Chromium follows its host platform for Mod; keep navigator unmodified.
export function nativeShortcut(input: KeyboardEventInit): KeyboardEventInit {
  return /Mac|iPhone|iPad/.test(navigator.platform) && input.ctrlKey
    ? { ...input, ctrlKey: false, metaKey: true }
    : input;
}
