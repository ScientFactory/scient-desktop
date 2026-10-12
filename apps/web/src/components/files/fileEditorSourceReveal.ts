import type { Editor } from "@pierre/diffs/edit";
import { sourcePosition } from "~/scient/math/input/sourceAdapter";

export interface SourceSelectionReveal {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly requestId: number;
}

/** Update the source editor's own selection without native focus or viewport movement. */
export function revealFileEditorSelection<Annotation>(
  editor: Editor<"file", Annotation, undefined>,
  reveal: SourceSelectionReveal,
) {
  if (
    !editor.getFile() ||
    editor.getText() !== reveal.source ||
    reveal.from < 0 ||
    reveal.to < reveal.from ||
    reveal.to > reveal.source.length
  )
    return false;
  const state = editor.getViewState();
  editor.setViewState({
    selections: [
      {
        start: sourcePosition(reveal.source, reveal.from),
        end: sourcePosition(reveal.source, reveal.to),
        direction: reveal.from === reveal.to ? 0 : 1,
      },
    ],
    // Supplying the view avoids Pierre's setSelections auto-scroll/focus path.
    view: state.view ?? { scrollLeft: 0 },
  });
  return true;
}
