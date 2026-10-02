/** The footer trigger and its fields belong to the same selected object. */
export function isLatexContextEvent(event: Event, toolbar: Element | null): boolean {
  const context = toolbar?.closest(".scient-latex-context-tools");
  return Boolean(context && event.composedPath().includes(context));
}
