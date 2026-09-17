export function applyComposerDirection(
  rootElement: HTMLElement | null,
  direction: "auto" | "rtl" | "ltr",
): void {
  if (!rootElement) return;

  const surface = rootElement.closest<HTMLElement>(".composer-editor-surface");
  if (surface) {
    if (direction === "auto") {
      surface.removeAttribute("data-scient-content-direction");
    } else {
      surface.dataset.scientContentDirection = direction;
    }
  }

  if (direction === "auto") {
    rootElement.removeAttribute("dir");
    for (const paragraph of rootElement.querySelectorAll<HTMLElement>(":scope > p")) {
      paragraph.dir = "auto";
    }
    return;
  }

  rootElement.dir = direction;
  for (const paragraph of rootElement.querySelectorAll<HTMLElement>(":scope > p")) {
    paragraph.dir = direction;
  }
}
