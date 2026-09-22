/** Small host boundary: no editor imports, state mutation, or source rewrites. */
type Claim = (event: KeyboardEvent) => boolean;
const claims = new WeakMap<EventTarget, Set<Claim>>();
export function registerShortcutClaim(host: EventTarget, claim: Claim): () => void {
  let handlers = claims.get(host);
  if (!handlers) {
    handlers = new Set();
    claims.set(host, handlers);
  }
  handlers.add(claim);
  return () => {
    handlers.delete(claim);
  };
}
export function surfaceOwnsShortcut(event: unknown): boolean {
  return (
    typeof KeyboardEvent !== "undefined" &&
    event instanceof KeyboardEvent &&
    event.composedPath().some((host) => [...(claims.get(host) ?? [])].some((claim) => claim(event)))
  );
}
/** Central defaults for native events; caller context can add non-DOM state. */
export function keyboardFocusContext(event: unknown): Record<string, boolean> {
  if (typeof KeyboardEvent === "undefined" || !(event instanceof KeyboardEvent)) return {};
  const path = event
    .composedPath()
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const matches = (selector: string) => path.some((node) => node.matches(selector));
  return {
    terminalFocus: matches("[data-terminal-owner]"),
    previewFocus: matches("[data-preview-panel-mode], webview"),
    markdownFocus: matches(".scient-markdown-workspace"),
    pdfFocus: matches(".scient-pdf-reader"),
    textInputFocus: matches("input, textarea, select, [contenteditable='true']"),
    editableFocus: matches("input, textarea, select, [contenteditable='true']"),
  };
}
