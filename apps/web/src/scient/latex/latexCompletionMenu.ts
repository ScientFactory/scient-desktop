import type { LatexCommandChoice } from "./latexCommandCompletion";
import "./mathCommandCompletion.css";

/** One anchored list for source, prose and math; clicking never discards the edit range. */
export function latexCompletionMenu(
  owner: HTMLElement,
  bounds: () => DOMRect | { left: number; right: number; top: number; bottom: number },
  accept: (choice: number) => void,
) {
  const document = owner.ownerDocument;
  if (!owner.id) owner.id = `scient-latex-completion-${++sequence}`;
  const menu = document.createElement("div");
  menu.id = `${owner.id}-completions`;
  menu.className = "scient-latex-command-completion";
  menu.dataset.latexSelectOwner = owner.id;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "LaTeX completions");
  menu.hidden = true;
  let active = 0;
  let count = 0;
  const position = () => {
    if (menu.hidden) return;
    const rect = bounds();
    const viewport = document.documentElement;
    menu.style.left = `${Math.max(8, Math.min(rect.left, viewport.clientWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(
      8,
      rect.bottom + menu.offsetHeight + 8 > viewport.clientHeight
        ? rect.top - menu.offsetHeight - 4
        : rect.bottom + 4,
    )}px`;
  };
  const hide = () => {
    menu.hidden = true;
    owner.removeAttribute("aria-controls");
    owner.removeAttribute("aria-activedescendant");
    document.removeEventListener("scroll", position, true);
    document.defaultView?.removeEventListener("resize", position);
  };
  const highlight = () => {
    [...menu.children].forEach((child, index) =>
      child.setAttribute("aria-selected", String(index === active)),
    );
    owner.setAttribute("aria-activedescendant", `${menu.id}-${active}`);
    const option = menu.children[active] as HTMLElement | undefined;
    if (!option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  };
  return {
    get open() {
      return !menu.hidden;
    },
    hide,
    show(choices: readonly LatexCommandChoice[], reset = false) {
      count = choices.length;
      if (!count) return hide();
      active = reset ? 0 : Math.min(active, count - 1);
      menu.replaceChildren(
        ...choices.map((choice, index) => {
          const option = document.createElement("button");
          option.type = "button";
          option.id = `${menu.id}-${index}`;
          option.textContent = choice.preview;
          option.setAttribute("role", "option");
          option.addEventListener("pointerdown", (event) => event.preventDefault());
          option.addEventListener("click", () => accept(index));
          return option;
        }),
      );
      if (!menu.isConnected) document.body.append(menu);
      menu.hidden = false;
      owner.setAttribute("aria-controls", menu.id);
      document.addEventListener("scroll", position, true);
      document.defaultView?.addEventListener("resize", position);
      highlight();
      position();
    },
    key(event: KeyboardEvent, space = false): boolean {
      if (menu.hidden || event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
        return false;
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        highlight();
      } else if (
        !event.shiftKey &&
        (event.key === "Tab" || event.key === "Enter" || (space && event.key === " "))
      )
        accept(active);
      else return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    },
    dispose() {
      hide();
      menu.remove();
    },
  };
}
let sequence = 0;
