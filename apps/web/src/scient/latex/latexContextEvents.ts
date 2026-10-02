/** The footer trigger and its fields belong to the same selected object. */
export function isLatexContextEvent(event: Event, toolbar: Element | null): boolean {
  const context = toolbar?.closest(".scient-latex-context-tools");
  if (!context) return false;
  if (event.composedPath().includes(context)) return true;
  const owner = latexSelectEventOwner(event);
  return Boolean(owner && context.contains(owner));
}

/** Portaled select choices still belong to the field that opened them. */
export function latexSelectEventOwner(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    const ownerId = target.dataset.latexSelectOwner;
    if (ownerId) return target.ownerDocument.getElementById(ownerId);
  }
  return null;
}
