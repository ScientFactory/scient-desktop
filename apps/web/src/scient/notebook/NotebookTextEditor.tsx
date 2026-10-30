import { Selection, TextSelection } from "prosemirror-state";
import { useEffect, useState, type KeyboardEvent } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { ScientMarkdownDocument } from "~/scient/markdownEditor/ScientMarkdownDocument";
import { ScientMarkdownEditorView } from "~/scient/markdownEditor/prosemirror/view";
import type { NotebookCaret } from "./notebookController";

/** A Text cell in the same editor as a Markdown document. */
export default function NotebookTextEditor(props: {
  readonly source: string;
  readonly caret: NotebookCaret;
  readonly onChange: (source: string) => void;
  readonly onDone: (advance: boolean) => void;
}) {
  const onChange = useStableCallback(props.onChange);
  const [view] = useState(
    () =>
      new ScientMarkdownEditorView({
        source: props.source,
        revision: "notebook-cell",
        ariaLabel: "Text cell",
        onUserSourceChange: (source) => onChange(source),
        // Typed math reads back differently from plain text; the cell keeps what was typed.
        onWritebackRefusal: (pending) => {
          if (pending !== null) onChange(pending.proposedSource);
        },
      }),
  );
  const placeCaret = useStableCallback(() => {
    const editor = view.view;
    if (editor === null) return;
    const { caret } = props;
    const { doc, tr } = editor.state;
    const point =
      typeof caret === "object"
        ? editor.posAtCoords({ left: caret.x, top: caret.y })?.pos
        : undefined;
    const selection =
      point !== undefined
        ? TextSelection.near(doc.resolve(point))
        : caret === "start"
          ? Selection.atStart(doc)
          : Selection.atEnd(doc);
    editor.dispatch(tr.setSelection(selection));
    view.focus();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the editor is an imperative view owned for this mount; it takes focus as it opens.
  useEffect(() => {
    const frame = requestAnimationFrame(placeCaret);
    return () => {
      cancelAnimationFrame(frame);
      view.destroy();
    };
  }, [placeCaret, view]);
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    // A math or code field inside the document closes first, so what it holds is kept.
    const finish = event.key === "Escape" && event.target === view.view?.dom;
    const run = event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey);
    if (!finish && !run) return;
    event.preventDefault();
    event.stopPropagation();
    props.onDone(run && event.shiftKey);
  };
  return (
    <div
      className="min-w-0 px-3 py-1 [&_.ProseMirror]:min-h-0! [&_.ProseMirror]:p-0!"
      onKeyDownCapture={onKeyDownCapture}
    >
      <ScientMarkdownDocument mode="write" controller={view} />
    </div>
  );
}
