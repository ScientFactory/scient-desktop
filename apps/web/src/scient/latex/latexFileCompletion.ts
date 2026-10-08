import type { Editor } from "@pierre/diffs/editor";
import { sourceMathOwnsEvent, sourceOffset, sourcePosition } from "../math/input/sourceAdapter";
import { installLatexTextCompletion } from "./latexTextCompletion";
import { latexDocumentMathSetup } from "./latexDocumentMacros";
import { latexDocumentColors } from "./latexColorBoxes";
import { latexPreambleEnd } from "./latexPackages";

/** Source completion uses the file editor's edits and undo, including its shadow-root selection. */
export function installLatexFileCompletion<Annotation>(
  editor: Editor<Annotation>,
  host: HTMLElement,
  editable: () => boolean,
) {
  let snippet: { from: number; to: number } | null = null;
  let lastSource = "";
  let setupSource = "";
  let setup = { macros: latexDocumentMathSetup("").macros, colors: latexDocumentColors("") };
  const read = () => {
    const selections = editor.getState().selections;
    if (
      !editable() ||
      !editor.getFile() ||
      editor.isComposing ||
      !host.matches(":focus-within") ||
      selections?.length !== 1
    )
      return null;
    const source = editor.getText();
    if (snippet && lastSource !== source) {
      let start = 0;
      while (
        start < lastSource.length &&
        start < source.length &&
        lastSource[start] === source[start]
      )
        start++;
      let oldEnd = lastSource.length,
        newEnd = source.length;
      while (oldEnd > start && newEnd > start && lastSource[oldEnd - 1] === source[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      const delta = newEnd - oldEnd;
      if (start <= snippet.from && oldEnd >= snippet.to) snippet = null;
      else
        snippet = {
          from:
            snippet.from <= start
              ? snippet.from
              : snippet.from >= oldEnd
                ? snippet.from + delta
                : start,
          to: snippet.to < start ? snippet.to : snippet.to >= oldEnd ? snippet.to + delta : newEnd,
        };
    }
    lastSource = source;
    return {
      source,
      from: sourceOffset(source, selections[0]!.start),
      to: sourceOffset(source, selections[0]!.end),
    };
  };
  const context = () => {
    const source = editor.getText();
    const preamble = source.slice(0, latexPreambleEnd(source));
    if (preamble !== setupSource) {
      setupSource = preamble;
      setup = {
        macros: latexDocumentMathSetup(preamble).macros,
        colors: latexDocumentColors(preamble),
      };
    }
    return { ...setup, source };
  };
  const completion = installLatexTextCompletion(
    host,
    {
      read,
      apply(choice) {
        const current = read();
        if (!current || current.from !== current.to) return false;
        const next =
          current.source.slice(0, choice.from) +
          choice.replacement +
          current.source.slice(choice.to);
        editor.applyEdits([
          {
            range: {
              start: sourcePosition(current.source, choice.from),
              end: sourcePosition(current.source, choice.to),
            },
            newText: choice.replacement,
          },
        ]);
        const position = sourcePosition(next, choice.from + choice.caret);
        editor.setSelections([{ start: position, end: position, direction: "forward" }]);
        if (choice.label.startsWith("\\")) {
          snippet = { from: choice.from, to: choice.from + choice.replacement.length };
          lastSource = next;
        }
        editor.focus();
        return true;
      },
      bounds() {
        let focused = host.ownerDocument.activeElement;
        while (focused?.shadowRoot) {
          const caret = focused.shadowRoot.querySelector<HTMLElement>("[data-caret]");
          if (caret) {
            const bounds = caret.getBoundingClientRect();
            if (bounds.height) return bounds;
          }
          focused = focused.shadowRoot.activeElement;
        }
        const selection = host.ownerDocument.getSelection();
        if (selection?.rangeCount) {
          const bounds = selection.getRangeAt(0).getBoundingClientRect();
          if (bounds.height) return bounds;
        }
        return host.getBoundingClientRect();
      },
    },
    "source",
    context,
  );
  const key = (event: KeyboardEvent) => {
    if (!sourceMathOwnsEvent(event) || completion.key(event)) return;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.key !== "Tab" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const input = read();
    if (
      !input ||
      !snippet ||
      input.from !== input.to ||
      input.from < snippet.from ||
      input.from > snippet.to
    )
      return;
    const slots = [...input.source.slice(snippet.from, snippet.to).matchAll(/[{[](?=[}\]])/gu)].map(
      (match) => snippet!.from + match.index + 1,
    );
    const next = event.shiftKey
      ? slots.findLast((position) => position < input.from)
      : slots.find((position) => position > input.from);
    const position = sourcePosition(input.source, next ?? snippet.to);
    editor.setSelections([{ start: position, end: position, direction: "forward" }]);
    if (next === undefined) snippet = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      completion.refresh();
    });
  };
  const blur = () => completion.hide();
  host.addEventListener("keydown", key, true);
  for (const name of ["input", "keyup", "pointerup", "focusin", "compositionend"])
    host.addEventListener(name, refresh);
  host.addEventListener("focusout", blur);
  host.ownerDocument.addEventListener("selectionchange", refresh);
  return () => {
    completion.dispose();
    host.removeEventListener("keydown", key, true);
    for (const name of ["input", "keyup", "pointerup", "focusin", "compositionend"])
      host.removeEventListener(name, refresh);
    host.removeEventListener("focusout", blur);
    host.ownerDocument.removeEventListener("selectionchange", refresh);
  };
}
