// FILE: browserPanelFocus.ts
// Purpose: Restore keyboard focus after the Browser panel removes its final tab.
// Layer: Chat browser/dock accessibility helpers

const ENABLED_BUTTON_SELECTOR = 'button:not(:disabled):not([aria-disabled="true"])';

function focusTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  target.focus();
  return target.ownerDocument.activeElement === target;
}

export function restoreRightDockFocusAfterBrowserClose(document: Document): boolean {
  const dock = document.querySelector<HTMLElement>("[data-right-dock-content]");
  if (!dock) return false;

  return focusTarget(
    dock.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
      dock.querySelector<HTMLElement>(`[data-right-dock-empty-state] ${ENABLED_BUTTON_SELECTOR}`) ??
      dock.querySelector<HTMLElement>(`${ENABLED_BUTTON_SELECTOR}[aria-label="Add panel"]`) ??
      dock.querySelector<HTMLElement>(`${ENABLED_BUTTON_SELECTOR}[aria-label="Collapse panel"]`),
  );
}

export function restoreSplitChatFocusAfterBrowserClose(pane: HTMLElement): boolean {
  return focusTarget(
    pane.querySelector<HTMLElement>(
      '[data-chat-composer-form="true"] [data-testid="composer-editor"][contenteditable="true"]',
    ) ?? pane,
  );
}
