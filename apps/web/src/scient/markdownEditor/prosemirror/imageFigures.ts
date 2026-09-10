import { isHistoryTransaction } from "prosemirror-history";
import type { Node as ProseMirrorNode, ResolvedPos } from "prosemirror-model";
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";

/** Captions belong to paragraph images, outside links and table cells. */
export function canCaptionImage(doc: ProseMirrorNode, position: number): boolean {
  const image = doc.nodeAt(position);
  if (image?.type.name !== "image" || image.marks.some((mark) => mark.type.name === "link"))
    return false;
  const $pos = doc.resolve(position);
  if ($pos.parent.type.name !== "paragraph") return false;
  for (let depth = 0; depth <= $pos.depth; depth += 1) {
    if (["table_cell", "table_header"].includes($pos.node(depth).type.name)) return false;
  }
  return true;
}

export function standaloneImagePosition($pos: ResolvedPos): number | null {
  if ($pos.parent.type.name !== "paragraph") return null;
  let imagePosition: number | null = null;
  let otherContent = false;
  $pos.parent.forEach((node, offset) => {
    if (node.type.name === "image" && imagePosition === null) imagePosition = $pos.start() + offset;
    else if (!node.isText || node.text?.trim()) otherContent = true;
  });
  return !otherContent && imagePosition !== null && canCaptionImage($pos.doc, imagePosition)
    ? imagePosition
    : null;
}

/** Explicitly adding a caption to an inline image preserves the prose on both sides. */
export function isolateImage(transaction: Transaction, position: number): number {
  const image = transaction.doc.nodeAt(position)!;
  const after = position + image.nodeSize;
  if (after < transaction.doc.resolve(position).end()) transaction.split(after);
  if (position > transaction.doc.resolve(position).start()) {
    transaction.split(position);
    return position + 2;
  }
  return position;
}

function imageBoundary(state: EditorState): { position: number; side: -1 | 1 } | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const position = standaloneImagePosition(selection.$from);
  if (position === null) return null;
  return { position, side: selection.from <= position ? -1 : 1 };
}

function paragraphAtImageBoundary(state: EditorState): Transaction | null {
  const boundary = imageBoundary(state);
  if (!boundary) return null;
  const position = state.selection.from;
  const tr = state.tr.split(position);
  return tr.setSelection(TextSelection.create(tr.doc, position + (boundary.side === 1 ? 2 : 0)));
}

function imageBesideDeletion(state: EditorState, backwards: boolean): number | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const boundary = imageBoundary(state);
  if (boundary && boundary.side === (backwards ? 1 : -1)) return boundary.position;
  const $pos = selection.$from;
  if (
    !$pos.parent.isTextblock ||
    !$pos.depth ||
    $pos.parentOffset !== (backwards ? 0 : $pos.parent.content.size)
  )
    return null;
  const edge = backwards ? $pos.before() : $pos.after();
  const $edge = state.doc.resolve(edge);
  const adjacent = backwards ? $edge.nodeBefore : $edge.nodeAfter;
  if (adjacent?.type.name !== "paragraph") return null;
  return standaloneImagePosition(state.doc.resolve(edge - (backwards ? adjacent.nodeSize : 0) + 1));
}

/** Keep figure presentation and native editor input on the same paragraph boundary. */
export function imageFigurePlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (!view.editable || from !== to || from !== view.state.selection.from) return false;
        const tr = paragraphAtImageBoundary(view.state);
        if (!tr) return false;
        view.dispatch(tr.insertText(text).scrollIntoView());
        return true;
      },
      handlePaste(view, _event, slice) {
        if (!view.editable) return false;
        const tr = paragraphAtImageBoundary(view.state);
        if (!tr) return false;
        view.dispatch(tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (!view.editable || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
          return false;
        if (!event.shiftKey && (event.key === "Backspace" || event.key === "Delete")) {
          const position = imageBesideDeletion(view.state, event.key === "Backspace");
          if (position === null) return false;
          view.dispatch(
            view.state.tr
              .setSelection(NodeSelection.create(view.state.doc, position))
              .scrollIntoView(),
          );
          return true;
        }
        if (event.key !== "Enter") return false;
        const tr = paragraphAtImageBoundary(view.state);
        if (!tr) return false;
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        beforeinput(view, event) {
          // Create the native composition target before the IME owns its text node.
          if (view.editable && event.inputType === "insertCompositionText") {
            const tr = paragraphAtImageBoundary(view.state);
            if (tr) view.dispatch(tr);
          }
          return false;
        },
      },
    },
    appendTransaction(transactions, oldState, newState) {
      // Native DOM input and programmatic insertions also use this path. History
      // restores authored structure verbatim; merely selecting a figure never edits it.
      if (
        transactions.some(isHistoryTransaction) ||
        !transactions.some((tr) => tr.docChanged && tr.getMeta("addToHistory") !== false)
      )
        return null;
      const boundary = imageBoundary(oldState);
      if (!boundary) return null;
      let imagePosition = boundary.position;
      for (const tr of transactions) {
        const mapped = tr.mapping.mapResult(imagePosition, 1);
        if (mapped.deleted) return null;
        imagePosition = mapped.pos;
      }
      if (!canCaptionImage(newState.doc, imagePosition)) return null;
      if (standaloneImagePosition(newState.doc.resolve(imagePosition)) !== null) return null;
      const tr = newState.tr;
      isolateImage(tr, imagePosition);
      return tr.docChanged ? tr : null;
    },
  });
}
