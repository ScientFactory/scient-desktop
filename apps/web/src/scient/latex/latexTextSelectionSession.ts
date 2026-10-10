import { attachShortcutHost } from "../keyboard/host";
import {
  latexSelectionCommand,
  registerLatexSelection,
  runLatexSelectionCommand,
} from "./latexSelectionSession";
import { latexContainerScope } from "./latexStructuredSelection";
import { latexTextSelectionRects } from "./latexTextSelectionRects";

export function installLatexTextSelectionSession(field: HTMLTextAreaElement): () => void {
  const history: { start: number; end: number; direction: "forward" | "backward" | "none" }[] = [];
  let applying = false;
  const session = registerLatexSelection({
    element: field,
    capture: () => {
      const start = field.selectionStart,
        end = field.selectionEnd,
        direction = field.selectionDirection;
      const value = field.value;
      return {
        path: [...latexContainerScope(field), field.getAttribute("aria-label") ?? "Text"],
        scopes: () =>
          field.closest('td,th,.scient-latex-rich-preview[data-kind="table"]')
            ? []
            : [field.getBoundingClientRect()],
        selection: () => latexTextSelectionRects(field, start, end),
        restore: (focus) => {
          if (!field.isConnected || field.value !== value) return false;
          applying = true;
          field.setSelectionRange(start, end, direction);
          applying = false;
          if (focus) field.focus({ preventScroll: true });
          return true;
        },
      };
    },
    command: (command) => {
      if (field.readOnly || field.disabled) return false;
      let start = 0,
        end = field.value.length,
        direction: "forward" | "backward" | "none" = "forward";
      if (command === "selectionShrink") {
        const previous = history.pop();
        if (!previous) return false;
        ({ start, end, direction } = previous);
      } else if (command === "selectionExpand" || command === "selectionScopeExpand") {
        if (
          field.selectionStart === 0 &&
          field.selectionEnd === end &&
          (command !== "selectionScopeExpand" || history.length > 0)
        )
          return false;
        history.push({
          start: field.selectionStart,
          end: field.selectionEnd,
          direction: field.selectionDirection,
        });
        if (command === "selectionExpand" && field.selectionStart === field.selectionEnd) {
          const word = [...field.value.matchAll(/[\p{L}\p{N}_]+/gu)].find(
            (match) =>
              match.index <= field.selectionStart &&
              match.index + match[0].length >= field.selectionEnd,
          );
          if (word) {
            start = word.index;
            end = start + word[0].length;
          }
        }
      } else return false;
      applying = true;
      field.setSelectionRange(start, end, direction);
      applying = false;
      field.focus({ preventScroll: true });
      session.refresh();
      return true;
    },
  });
  const changed = () => {
    if (!applying) history.length = 0;
    session.refresh();
  };
  const keydown = (event: KeyboardEvent) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
      history.length = 0;
  };
  field.addEventListener("keydown", keydown);
  field.addEventListener("input", changed);
  field.addEventListener("pointerdown", changed);
  field.addEventListener("keyup", session.refresh);
  field.addEventListener("select", session.refresh);
  const detach = attachShortcutHost(field, "latex", {
    capture: true,
    accepts: (_event, id) =>
      !field.readOnly && !field.disabled && (!id || Boolean(latexSelectionCommand(id))),
    execute: (id) => {
      const command = latexSelectionCommand(id);
      return Boolean(command && runLatexSelectionCommand(field, command));
    },
  });
  return () => {
    detach();
    session.dispose();
    field.removeEventListener("keydown", keydown);
    field.removeEventListener("input", changed);
    field.removeEventListener("pointerdown", changed);
    field.removeEventListener("keyup", session.refresh);
    field.removeEventListener("select", session.refresh);
  };
}
