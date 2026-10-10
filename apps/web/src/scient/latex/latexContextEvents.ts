/** Nested editors on one canvas share a context; separate documents do not. */
export function latexContextRoot(element: Element): Element {
  return element.closest(".scient-latex-visual-workspace") ?? element;
}

export function activateLatexContext(element: Element, id: string): void {
  latexContextRoot(element).dispatchEvent(
    new CustomEvent("scient-latex-context-activate", { detail: id }),
  );
}

/** Empty footer space and status text share the owning canvas's editing target. */
function isLatexFooterEvent(event: Event, element: Element): boolean {
  const workspace = element.closest(".scient-latex-visual-workspace");
  return Boolean(
    workspace &&
    event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target.matches(".scient-latex-reader-footer") &&
          target.closest(".scient-latex-visual-workspace") === workspace,
      ),
  );
}

/** The whole footer and its owned popups belong to the same selected object. */
export function isLatexContextEvent(event: Event, toolbar: Element | null): boolean {
  const context = toolbar?.closest(".scient-latex-context-tools");
  if (!context) return false;
  if (event.composedPath().includes(context) || isLatexFooterEvent(event, context)) return true;
  const owner = latexSelectEventOwner(event);
  return Boolean(owner && context.contains(owner));
}

/** Moving into this document's footer or menus keeps its editing target and selection. */
export function isLatexEditingMenuEvent(event: Event, element: Element): boolean {
  const workspace = element.closest(".scient-latex-visual-workspace");
  if (!workspace) return false;
  if (isLatexFooterEvent(event, element)) return true;
  const owner = latexSelectEventOwner(event);
  if (
    owner &&
    workspace.contains(owner) &&
    event
      .composedPath()
      .some(
        (target) => target instanceof Element && target.closest(".scient-latex-command-completion"),
      )
  )
    return true;
  const targets = owner ? [owner] : event.composedPath();
  return targets.some((target) => {
    if (!(target instanceof Element)) return false;
    const menu = target.closest(
      ".scient-latex-context-tools, .scient-latex-writing-toolbar, [data-latex-insert-menu]",
    );
    return Boolean(menu && workspace.contains(menu));
  });
}

/** Follow popup ownership through nested menus and select choices. */
export function latexSelectEventOwner(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    let popup = target.closest<HTMLElement>("[data-latex-select-owner], [data-writing-menu-owner]");
    let owner: HTMLElement | null = null;
    const visited = new Set<Element>();
    while (popup && !visited.has(popup)) {
      visited.add(popup);
      const id = popup.dataset.latexSelectOwner ?? popup.dataset.writingMenuOwner;
      const next = id ? popup.ownerDocument.getElementById(id) : null;
      if (!next) break;
      owner = next;
      popup = owner.closest<HTMLElement>("[data-latex-select-owner], [data-writing-menu-owner]");
    }
    if (owner) return owner;
  }
  return null;
}
