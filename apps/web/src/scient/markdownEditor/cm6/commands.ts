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
    // Wrapping selects the inner text, so a repeated toggle sees the markers
    // just outside the range; strip them instead of nesting another pair.
    const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + marker.length));
    if (before === marker && after === marker) {
      return {
        changes: { from: range.from - marker.length, to: range.to + marker.length, insert: text },
        range: EditorSelection.range(
          range.from - marker.length,
          range.from - marker.length + text.length,
        ),
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

/** Insert an image template at the cursor with the alt text selected. */
export function insertImageTemplate(view: EditorView): boolean {
  const position = stateCursor(view);
  const template = "![alt](url)";
  view.dispatch({
    changes: { from: position, insert: template },
    selection: { anchor: position + 2, head: position + 5 },
  });
  view.focus();
  return true;
}

/**
 * Toggle the text-direction HTML region around the selected lines, matching
 * the `<div dir="...">` convention the ProseMirror surface serializes.
 * Repeating the same direction removes the wrapper; null unwraps any.
 */
export function toggleDirection(view: EditorView, direction: "ltr" | "rtl" | null): boolean {
  const { state } = view;
  const openTag = /^<div dir="(ltr|rtl|auto)">\s*$/u;
  let first = state.doc.lineAt(state.selection.main.from).number;
  let last = state.doc.lineAt(state.selection.main.to).number;
  // A cursor left on the wrapper tags (after a previous toggle) should act on
  // the wrapped content, not wrap the tag line itself.
  if (openTag.test(state.doc.line(first).text) && first < state.doc.lines) first += 1;
  if (last < first) last = first;
  if (state.doc.line(last).text.trim() === "</div>" && last > first) last -= 1;
  const lineBefore = first > 1 ? state.doc.line(first - 1) : null;
  const lineAfter = last < state.doc.lines ? state.doc.line(last + 1) : null;
  const openMatch = lineBefore ? openTag.exec(lineBefore.text) : null;
  const closeMatch = lineBefore && lineAfter && lineAfter.text.trim() === "</div>";
  if (openMatch && closeMatch) {
    view.dispatch({
      changes: [
        { from: lineAfter!.from - 1, to: lineAfter!.to },
        { from: lineBefore!.from, to: lineBefore!.to + 1 },
      ],
    });
    return true;
  }
  if (direction === null) return false;
  const lastLine = state.doc.line(last);
  view.dispatch({
    changes: [
      { from: lastLine.to, insert: `\n</div>` },
      { from: state.doc.line(first).from, insert: `<div dir="${direction}">\n` },
    ],
  });
  return true;
}

/** Reset the selected lines to plain paragraphs by stripping heading and quote markers. */
export function setParagraph(view: EditorView): boolean {
  const { state } = view;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const first = state.doc.lineAt(state.selection.main.from).number;
  const last = state.doc.lineAt(state.selection.main.to).number;
  for (let number = first; number <= last; number += 1) {
    const line = state.doc.line(number);
    const match = /^(?:#{1,6}\s+|>\s?)+/u.exec(line.text);
    if (match) changes.push({ from: line.from, to: line.from + match[0].length, insert: "" });
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes: changes.sort((a, b) => b.from - a.from) });
  return true;
}

/** Insert a Markdown hard break (`\` + newline): down one line, not one paragraph. */
export function insertLineBreak(view: EditorView): boolean {
  const position = stateCursor(view);
  view.dispatch({
    changes: { from: position, insert: "\\\n" },
    selection: { anchor: position + 2 },
  });
  return true;
}

/** Insert a block-level template at the cursor (code fence, math, table, rule). */
export function insertBlockTemplate(view: EditorView, template: string): boolean {
  const position = stateCursor(view);
  const newline = template.indexOf("\n");
  view.dispatch({
    changes: { from: position, insert: template },
    selection: { anchor: newline < 0 ? position + template.length : position + newline + 1 },
  });
  view.focus();
  return true;
}

function stateCursor(view: EditorView): number {
  return view.state.selection.main.head;
}
