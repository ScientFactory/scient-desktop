import {
  countStrongScripts,
  resolveProseBlockDirectionFromCounts,
  resolveStructuredDirectionFromCounts,
} from "./contentDirection";

const COMPOSER_DIRECTION_GROUP_SELECTOR =
  ":scope > p, :scope > ul, :scope > ol, :scope > blockquote";
const COMPOSER_TECHNICAL_ELEMENTS = new Set(["CODE", "PRE"]);

function composerProseText(node: Node): string {
  if (node instanceof HTMLElement && COMPOSER_TECHNICAL_ELEMENTS.has(node.tagName)) return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return Array.from(node.childNodes, composerProseText).join(" ");
}

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
    const groups = Array.from(
      rootElement.querySelectorAll<HTMLElement>(COMPOSER_DIRECTION_GROUP_SELECTOR),
    );
    const messageDirection = resolveStructuredDirectionFromCounts(
      groups.map((group) => countStrongScripts(composerProseText(group))),
      countStrongScripts(composerProseText(rootElement)),
      "ltr",
    );
    rootElement.dir = messageDirection;
    for (const group of groups) {
      group.dir = resolveProseBlockDirectionFromCounts(
        countStrongScripts(composerProseText(group)),
        messageDirection,
      );
    }
    return;
  }

  rootElement.dir = direction;
  for (const group of rootElement.querySelectorAll<HTMLElement>(
    COMPOSER_DIRECTION_GROUP_SELECTOR,
  )) {
    group.dir = direction;
  }
}
