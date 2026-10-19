const EDITOR_SELECTOR =
  ".scient-latex-visual-document[contenteditable='true'], .scient-markdown-document[contenteditable='true']";

function visible(element: Element | null | undefined): element is HTMLElement {
  return (
    element instanceof HTMLElement && element.isConnected && element.getClientRects().length > 0
  );
}

/** The caret as a character offset into an editor's text, to restore after it remounts. */
export function caretOffsetInEditor(): number | null {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  if (!selection || !anchor) return null;
  const element = anchor instanceof Element ? anchor : anchor.parentElement;
  const editor = element?.closest<HTMLElement>(EDITOR_SELECTOR);
  if (!editor) return null;
  const range = document.createRange();
  range.setStart(editor, 0);
  range.setEnd(anchor, selection.anchorOffset);
  return range.toString().length;
}

function caretAtOffset(editor: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
  }
  caretAtEnd(editor);
}

function caretAtEnd(container: Node) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(container);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Puts the caret in the editor that opens for a new document: in its title
 * when it has just been created, back where it was after it is renamed.
 * Gives up quietly if no editor appears, or if the person has started typing
 * elsewhere meanwhile.
 */
export function focusNewDocumentWhenOpen(
  target: "title" | { readonly offset: number },
  timeoutMs = 10_000,
): void {
  const startedWith = document.activeElement;
  const deadline = performance.now() + timeoutMs;
  const attempt = () => {
    // Typing somewhere else meanwhile wins; a menu handing focus back, or the
    // document's own editor focusing itself as it mounts, does not.
    const active = document.activeElement;
    const typingElsewhere =
      active !== startedWith &&
      active instanceof HTMLElement &&
      !active.closest(EDITOR_SELECTOR) &&
      (active.isContentEditable || active.matches("input, textarea, select"));
    if (typingElsewhere || performance.now() > deadline) return;
    const editors = document.querySelectorAll<HTMLElement>(EDITOR_SELECTOR);
    const editor = editors[editors.length - 1];
    if (!visible(editor)) {
      requestAnimationFrame(attempt);
      return;
    }
    if (target === "title") {
      const page = editor.closest(".scient-latex-surface") ?? editor;
      const latexTitle = page.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Document title"]',
      );
      if (visible(latexTitle)) {
        latexTitle.focus({ preventScroll: true });
        latexTitle.setSelectionRange(latexTitle.value.length, latexTitle.value.length);
        return;
      }
      // A template without a title is named above its page instead.
      const name = page.querySelector<HTMLInputElement>('input[aria-label="Document name"]');
      if (visible(name)) {
        name.focus({ preventScroll: true });
        return;
      }
      const heading = editor.querySelector("h1");
      if (visible(heading)) {
        editor.focus({ preventScroll: true });
        caretAtEnd(heading);
        return;
      }
      // The title is not drawn yet.
      requestAnimationFrame(attempt);
      return;
    }
    // A remounted editor draws its text after it appears; wait for it.
    if ((editor.textContent?.length ?? 0) < target.offset) {
      requestAnimationFrame(attempt);
      return;
    }
    editor.focus({ preventScroll: true });
    caretAtOffset(editor, target.offset);
  };
  requestAnimationFrame(attempt);
}
