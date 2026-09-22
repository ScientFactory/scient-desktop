import type { Editor } from "@pierre/diffs/editor";
import type { Position } from "@pierre/diffs";
import { MathInputController } from "./controller";
import type { MathInputFormat } from "./context";

/** Follow the composed path through Pierre's shadow root; search and comment inputs are not source. */
export function sourceMathOwnsEvent(event: KeyboardEvent): boolean {
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    if (target.matches("[data-scient-math-tools],input,textarea,select,[data-line-annotation]"))
      return false;
    if (target.hasAttribute("contenteditable"))
      return (
        target.getAttribute("contenteditable") === "true" && target.hasAttribute("data-content")
      );
  }
  return false;
}

export function sourceOffset(source: string, position: Position): number {
  let offset = 0;
  let line = 0;
  for (const match of source.matchAll(/\r\n|[\r\n]/gu)) {
    if (line === position.line) return Math.min(offset + position.character, match.index);
    offset = match.index + match[0].length;
    line++;
  }
  return Math.min(offset + position.character, source.length);
}
export function sourcePosition(source: string, offset: number): Position {
  let line = 0;
  let start = 0;
  for (const match of source.matchAll(/\r\n|[\r\n]/gu)) {
    if (match.index + match[0].length > offset) break;
    line++;
    start = match.index + match[0].length;
  }
  return { line, character: offset - start };
}

export function sourceMathController<Annotation>(
  editor: Editor<Annotation>,
  format: MathInputFormat,
  editable: () => boolean,
): MathInputController {
  return new MathInputController({
    read() {
      const selections = editor.getState().selections;
      if (!editor.getFile() || editor.isComposing || !selections || selections.length !== 1)
        return null;
      const source = editor.getText();
      const selection = selections[0]!;
      return {
        source,
        format,
        editable: editable(),
        selection: {
          from: sourceOffset(source, selection.start),
          to: sourceOffset(source, selection.end),
        },
      };
    },
    apply(expected, edit) {
      if (!editable() || editor.isComposing || editor.getText() !== expected.source) return false;
      const next =
        expected.source.slice(0, edit.from) + edit.insert + expected.source.slice(edit.to);
      if (next !== expected.source)
        editor.applyEdits([
          {
            range: {
              start: sourcePosition(expected.source, edit.from),
              end: sourcePosition(expected.source, edit.to),
            },
            newText: edit.insert,
          },
        ]);
      editor.setSelections([
        {
          start: sourcePosition(next, edit.selection.from),
          end: sourcePosition(next, edit.selection.to),
          direction: "forward",
        },
      ]);
      return true;
    },
    focus: () => editor.focus(),
  });
}
