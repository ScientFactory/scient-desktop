let nextSelection = 0;

/** Keep PDF ink selected when another Split pane owns the native browser selection. */
export function installPdfRetainedSelection(container: HTMLElement) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  if (!window || typeof Highlight === "undefined" || !CSS.highlights) return () => {};
  const name = `scient-pdf-retained-${++nextSelection}`;
  const style = document.createElement("style");
  style.textContent = `.textLayer ::highlight(${name}) { background: color-mix(in oklab, var(--primary) 22%, transparent); color: inherit; }`;
  container.append(style);
  let saved: Range | null = null;
  const clear = () => {
    CSS.highlights.delete(name);
  };
  const remember = () => {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (container.contains(range.startContainer) && container.contains(range.endContainer))
      saved = range.cloneRange();
  };
  const retain = (event: Event) => {
    if (!container.closest("[data-latex-split]")) {
      clear();
      return;
    }
    if (event.composedPath().includes(container)) {
      if (event.type === "pointerdown") {
        saved = null;
        clear();
      }
      return;
    }
    remember();
    if (saved?.startContainer.isConnected && saved.endContainer.isConnected)
      CSS.highlights.set(name, new Highlight(saved));
  };
  document.addEventListener("selectionchange", remember);
  window.addEventListener("pointerdown", retain, true);
  window.addEventListener("focusin", retain, true);
  return () => {
    clear();
    document.removeEventListener("selectionchange", remember);
    window.removeEventListener("pointerdown", retain, true);
    window.removeEventListener("focusin", retain, true);
    style.remove();
  };
}
