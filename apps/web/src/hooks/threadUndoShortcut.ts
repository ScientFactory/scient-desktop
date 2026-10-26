import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand, type ShortcutMatchContext } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { surfaceOwnsShortcut } from "../scient/keyboard/ownership";
import {
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoLatestThreadAction,
} from "./showThreadUndoNotice";

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

export function installThreadUndoShortcut(options: {
  keybindings: ResolvedKeybindingsConfig;
  noticeVisible: boolean;
  enabled?: () => boolean;
  heldUndoKey: { current: string | null };
  getContext: () => Partial<ShortcutMatchContext>;
}): () => void {
  const { heldUndoKey } = options;
  const release = () => {
    heldUndoKey.current = null;
    releaseThreadUndoShortcut();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Capture runs before editors: honor explicit ownership before suppressing repeats, too.
    if (
      options.enabled?.() === false ||
      event.defaultPrevented ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen() ||
      surfaceOwnsShortcut(event) ||
      event
        .composedPath()
        .some(
          (node) => node instanceof Element && node.closest("[data-keybinding-capture]") !== null,
        )
    ) {
      release();
      return;
    }
    if (event.repeat) {
      if (event.code === heldUndoKey.current) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!MODIFIER_KEYS.has(event.key)) heldUndoKey.current = null;
    const command = resolveShortcutCommand(event, options.keybindings, {
      context: {
        ...options.getContext(),
        modelPickerOpen: false,
        editableFocus:
          isEditableFocused(event.target) && !(options.noticeVisible && threadUndoClaimsShortcut()),
      },
    });
    if (command !== "thread.undo") {
      if (!MODIFIER_KEYS.has(event.key)) release();
      return;
    }
    if (undoLatestThreadAction()) {
      heldUndoKey.current = event.code;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === heldUndoKey.current) heldUndoKey.current = null;
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Menu paste, dictation and drops hand undo back without a keypress.
  window.addEventListener("input", release, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("input", release, true);
  };
}
