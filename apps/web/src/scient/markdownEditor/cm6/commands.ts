import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Toggle an inline wrap marker (bold, italic, strike, code) around each range. */
export function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
      const unwrapped = text.slice(marker.length, text.length - marker.length);
      return {
        changes: { from: range.from, to: range.to, insert: unwrapped },
        range: EditorSelection.range(range.from, range.from + unwrapped.length),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: `${marker}${text}${marker}` },
      range: EditorSelection.range(
        range.from + marker.length,
        range.from + marker.length + text.length,
      ),
    };
  });
  view.dispatch(changes);
  return true;
}

/** Toggle a line prefix (heading, list marker, quote) on every selected line. */
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view;
  const changes: Array<{ from: number; to?: number; insert: string }> = [];
  const seenLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      if (seenLines.has(number)) continue;
      seenLines.add(number);
      const line = state.doc.line(number);
      if (line.text.startsWith(prefix)) {
        changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
      } else {
        changes.push({ from: line.from, insert: prefix });
      }
    }
  }
  if (changes.length === 0) return false;
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
  return true;
}

/** Toggle a numbered-list prefix, computing the ordinal per line. */
export function toggleNumberedList(view: EditorView): boolean {
  const { state } = view;
  const changes: Array<{ from: number; to?: number; insert: string }> = [];
  const seenLines = new Set<number>();
  let ordinal = 1;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      if (seenLines.has(number)) continue;
      seenLines.add(number);
      const line = state.doc.line(number);
      const existing = /^(\d+)\.\s/u.exec(line.text);
      if (existing) {
        changes.push({ from: line.from, to: line.from + existing[0].length, insert: "" });
      } else {
        changes.push({ from: line.from, insert: `${ordinal}. ` });
        ordinal += 1;
      }
    }
  }
  if (changes.length === 0) return false;
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
  return true;
}

/** Wrap the selection in a link; an empty selection becomes [text](url). */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || "text";
    const insert = `[${text}](url)`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from + text.length + 3, range.from + insert.length - 1),
    };
  });
  view.dispatch(changes);
  return true;
}

/** Insert a block-level template at the cursor (code fence, math, table, rule). */
export function insertBlockTemplate(view: EditorView, template: string): boolean {
  const position = stateCursor(view);
  view.dispatch({
    changes: { from: position, insert: template },
    selection: {
      anchor: position + template.indexOf("\n") < 0 ? template.length : template.indexOf("\n"),
    },
  });
  view.focus();
  return true;
}

function stateCursor(view: EditorView): number {
  return view.state.selection.main.head;
}
