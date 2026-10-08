const EDITOR_SELECTOR =
  ".scient-latex-visual-document[contenteditable='true'], .scient-markdown-document[contenteditable='true']";

/**
 * Puts the caret at the end of the editor that opens for a document just
 * created, so writing continues under its title. Gives up quietly if no
 * editor appears, or if the person has moved focus elsewhere meanwhile.
 */
export function focusNewDocumentWhenOpen(timeoutMs = 10_000): void {
  const startedWith = document.activeElement;
  const deadline = performance.now() + timeoutMs;
  const attempt = () => {
    const moved =
      document.activeElement !== startedWith &&
      document.activeElement !== document.body &&
      document.activeElement !== null;
    if (moved || performance.now() > deadline) return;
    const editors = document.querySelectorAll<HTMLElement>(EDITOR_SELECTOR);
    const editor = editors[editors.length - 1];
    if (!editor || !editor.isConnected || editor.getClientRects().length === 0) {
      requestAnimationFrame(attempt);
      return;
    }
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  requestAnimationFrame(attempt);
}
