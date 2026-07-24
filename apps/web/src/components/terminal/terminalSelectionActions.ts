// FILE: terminalSelectionActions.ts
// Purpose: Keep pure selection-action positioning helpers separate from the browser-heavy drawer.
// Layer: Chat terminal workspace helpers

const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;

// Xterm selections can include visual cell padding at the end of each line.
// Keep meaningful leading/internal whitespace and the original line endings,
// while matching the terminal runtime's established keyboard-copy behavior.
export function normalizeTerminalClipboardText(selection: string): string {
  return selection.replace(/[^\S\r\n]+(?=\r?$)/gm, "");
}

export function terminalSelectionCopyFailureMessage(error: unknown): string {
  const recovery =
    "Unable to copy terminal selection. Check clipboard access or use Cmd/Ctrl+C, then retry.";
  const reason = error instanceof Error ? error.message.trim() : "";
  return reason.length > 0 ? `${recovery} (${reason})` : recovery;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

export async function runTerminalSelectionMenuAction<TAction extends string>(input: {
  showMenu: () => Promise<TAction | null>;
  releaseMenu: () => void;
  isCurrent: () => boolean;
  execute: (action: TAction) => Promise<void>;
}): Promise<void> {
  let action: TAction | null;
  try {
    action = await input.showMenu();
  } finally {
    // The native menu is no longer open once its promise settles. Release this
    // single-flight guard before clipboard work, which may remain pending.
    input.releaseMenu();
  }
  if (action === null || !input.isCurrent()) return;
  await input.execute(action);
}

export async function executeTerminalSelectionAction<T>(input: {
  action: "add-to-chat" | "copy";
  clipboardText: string;
  selection: T;
  copyText: (text: string) => Promise<void>;
  addToChat: (selection: T) => void;
  clearSelection: () => void;
  focusTerminal: () => void;
  reportCopyError: (error: unknown) => void;
  isCurrent: () => boolean;
}): Promise<void> {
  if (!input.isCurrent()) return;
  if (input.action === "add-to-chat") {
    input.addToChat(input.selection);
    input.clearSelection();
    input.focusTerminal();
    return;
  }

  try {
    const normalizedText = normalizeTerminalClipboardText(input.clipboardText);
    if (normalizedText.trim().length === 0) {
      throw new Error("The selection contains no copyable text.");
    }
    await input.copyText(normalizedText);
  } catch (error) {
    if (!input.isCurrent()) return;
    input.reportCopyError(error);
  }
  if (input.isCurrent()) {
    input.focusTerminal();
  }
}
