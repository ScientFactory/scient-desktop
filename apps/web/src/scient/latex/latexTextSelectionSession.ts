import { attachShortcutHost } from "../keyboard/host";
import {
  latexSelectionCommand,
  registerLatexSelection,
  runLatexSelectionCommand,
} from "./latexSelectionSession";
import { latexContainerScope } from "./latexStructuredSelection";

/** Measure the selected text using the field's layout, including wrapping and RTL. */
function textRects(field: HTMLTextAreaElement, from: number, to: number): DOMRect[] {
  if (from === to) return [];
  const rect = field.getBoundingClientRect(),
    style = getComputedStyle(field);
  const scale = field.offsetWidth ? rect.width / field.offsetWidth : 1;
  const mirror = document.createElement("div");
  const properties = [
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontVariant",
    "direction",
    "textAlign",
    "tabSize",
  ] as const;
  for (const property of properties) mirror.style[property] = style[property];
  for (const property of [
    "fontSize",
    "letterSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ] as const) {
    mirror.style[property] = `${parseFloat(style[property]) * scale || 0}px`;
  }
  mirror.style.lineHeight =
    style.lineHeight === "normal" ? "normal" : `${parseFloat(style.lineHeight) * scale}px`;
  Object.assign(mirror.style, {
    position: "fixed",
    left: `${rect.left - field.scrollLeft * scale}px`,
    top: `${rect.top - field.scrollTop * scale}px`,
    width: `${field.clientWidth * scale}px`,
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    visibility: "hidden",
    pointerEvents: "none",
  });
  const text = document.createTextNode(field.value);
  mirror.append(text);
  document.body.append(mirror);
  try {
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    return [...range.getClientRects()].flatMap((part) => {
      const left = Math.max(rect.left, part.left),
        right = Math.min(rect.right, part.right);
      const top = Math.max(rect.top, part.top),
        bottom = Math.min(rect.bottom, part.bottom);
      return right > left && bottom > top
        ? [new DOMRect(left, top, right - left, bottom - top)]
        : [];
    });
  } finally {
    mirror.remove();
  }
}

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
        selection: () => textRects(field, start, end),
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
