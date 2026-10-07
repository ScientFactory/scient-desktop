import { Extension } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, TextSelection, type SelectionBookmark } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { registerLatexSelection } from "./latexSelectionSession";
import { latexInlineEditingScopes } from "./latexVisualDocument";

interface Scope {
  label: string;
  from: number;
  to: number;
  mark?: Mark;
  before?: number;
  after?: number;
}
const labels: Readonly<Record<string, string>> = {
  bold: "Bold",
  italic: "Italic",
  code: "Monospace",
  underline: "Underline",
  latexSmallCaps: "Small caps",
  latexRoman: "Roman",
  latexSans: "Sans",
  latexSlanted: "Slanted",
  latexUpright: "Upright",
  latexMedium: "Medium",
};

export function latexContainerScope(element: HTMLElement): string[] {
  const cells: string[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const cell = node.dataset.tableCell;
    if (cell && /^\d+-\d+$/u.test(cell)) {
      const [row, column] = cell.split("-").map(Number);
      cells.unshift("Table", `Cell (${row! + 1}, ${column! + 1})`);
    }
  }
  return cells;
}

function proseScopes(view: EditorView, source: string | null): Scope[] {
  const { selection, storedMarks } = view.state;
  const { $head } = selection;
  const scopes: Scope[] = [];
  const marks = storedMarks ?? $head.marks();
  const offset = $head.start();
  // Marks stay character ranges: crossing them never promotes ordinary selection.
  for (const mark of marks) {
    let from = $head.pos,
      to = $head.pos;
    const runs: { from: number; to: number }[] = [];
    $head.parent.forEach((node, position) => {
      if (mark.isInSet(node.marks)) {
        const prior = runs.at(-1);
        if (prior?.to === offset + position) prior.to += node.nodeSize;
        else runs.push({ from: offset + position, to: offset + position + node.nodeSize });
      }
    });
    const run = runs.find((range) => range.from <= $head.pos && range.to >= $head.pos);
    if (!run) continue;
    ({ from, to } = run);
    scopes.push({
      label: labels[mark.type.name] ?? mark.type.name.replace(/^latex/u, ""),
      from,
      to,
      mark,
    });
  }
  scopes.sort((a, b) => a.to - a.from - (b.to - b.from));
  const authored = source === null ? null : latexInlineEditingScopes(source);
  if (authored?.length) {
    const exact = authored
      .filter((scope) => scope.from + offset <= $head.pos && scope.to + offset >= $head.pos)
      .sort((a, b) => a.to - a.from - (b.to - b.from) || b.depth - a.depth)
      .flatMap((scope) => {
        const mark = marks.find((mark) => mark.type.name === scope.mark);
        return mark
          ? [
              {
                label: labels[scope.mark] ?? scope.mark.replace(/^latex/u, ""),
                from: offset + scope.from,
                to: offset + scope.to,
                mark,
              },
            ]
          : [];
      });
    const exactMarks = new Set(exact.map((scope) => scope.mark.type.name));
    scopes.splice(
      0,
      scopes.length,
      ...exact,
      ...scopes.filter((scope) => !exactMarks.has(scope.mark!.type.name)),
    );
  }
  for (let depth = $head.depth; depth > 0; depth--) {
    const node = $head.node(depth);
    scopes.push({
      label:
        node.type.name === "paragraph"
          ? "Paragraph"
          : node.type.name === "heading"
            ? "Heading"
            : node.type.name,
      from: node.isTextblock ? $head.start(depth) : $head.before(depth),
      to: node.isTextblock ? $head.end(depth) : $head.after(depth),
      before: $head.before(depth),
      after: $head.after(depth),
    });
  }
  scopes.push({ label: "Document", from: 0, to: view.state.doc.content.size });
  return scopes;
}

function rangeRects(view: EditorView, from: number, to: number): DOMRect[] {
  try {
    const start = view.domAtPos(from),
      end = view.domAtPos(to);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
    if (rects.length) return rects;
    const caret = view.coordsAtPos(from);
    return [new DOMRect(caret.left, caret.top, 2, caret.bottom - caret.top)];
  } catch {
    return [];
  }
}

/** Scope commands change the selection/stored marks only, never the source. */
export const LatexStructuredSelection = Extension.create<{
  source: (node: ProseMirrorNode) => string | null;
}>({
  name: "latexStructuredSelection",
  addOptions() {
    return { source: () => null };
  },
  addProseMirrorPlugins() {
    const source = this.options.source;
    let bookmark: SelectionBookmark | null = null;
    let applying = false;
    let capturedMarks: readonly Mark[] | null = null;
    const history: { bookmark: SelectionBookmark; marks: readonly Mark[] | null }[] = [];
    return [
      new Plugin({
        state: {
          init: () => null,
          apply(tr) {
            if (bookmark) bookmark = bookmark.map(tr.mapping);
            if (tr.docChanged || (tr.selectionSet && !applying)) history.length = 0;
            return null;
          },
        },
        view(view) {
          const session = registerLatexSelection({
            element: view.dom,
            capture: () => {
              bookmark = view.state.selection.getBookmark();
              capturedMarks = view.state.storedMarks;
              const scopes = proseScopes(view, source(view.state.selection.$head.parent));
              return {
                path: [
                  ...latexContainerScope(view.dom),
                  ...scopes
                    .filter((scope) => scope.label !== "Document")
                    .toReversed()
                    .map((scope) => scope.label),
                ],
                scopes: () =>
                  scopes
                    .filter((scope) => scope.mark)
                    .slice(0, 2)
                    .flatMap((scope) => rangeRects(view, scope.from, scope.to)),
                selection: () => {
                  const selection = bookmark?.resolve(view.state.doc);
                  return selection && !selection.empty
                    ? rangeRects(view, selection.from, selection.to)
                    : [];
                },
                restore: (focus) => {
                  if (!bookmark || view.isDestroyed) return false;
                  applying = true;
                  view.dispatch(
                    view.state.tr
                      .setSelection(bookmark.resolve(view.state.doc))
                      .setStoredMarks(capturedMarks),
                  );
                  applying = false;
                  if (focus) view.focus();
                  return true;
                },
              };
            },
            command: (command) => {
              if (!view.editable) return false;
              const { selection, storedMarks } = view.state;
              const scopes = proseScopes(view, source(view.state.selection.$head.parent));
              let tr = view.state.tr;
              if (command === "selectionShrink") {
                const previous = history.pop();
                if (!previous) return false;
                tr = tr
                  .setSelection(previous.bookmark.resolve(tr.doc))
                  .setStoredMarks(previous.marks);
              } else if (command === "selectionExpand") {
                if (selection.empty && selection.$from.parent.isTextblock) {
                  const text = selection.$from.parent.textBetween(
                    0,
                    selection.$from.parent.content.size,
                    "\uFFFC",
                    "\uFFFC",
                  );
                  const at = selection.$from.parentOffset;
                  for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
                    if (match.index <= at && match.index + match[0].length >= at) {
                      scopes.unshift({
                        label: "Word",
                        from: selection.$from.start() + match.index,
                        to: selection.$from.start() + match.index + match[0].length,
                      });
                      break;
                    }
                  }
                }
                const scope = scopes.find(
                  (scope) =>
                    scope.from <= selection.from &&
                    scope.to >= selection.to &&
                    (scope.from < selection.from || scope.to > selection.to),
                );
                if (!scope) return false;
                history.push({ bookmark: selection.getBookmark(), marks: storedMarks });
                tr = tr.setSelection(
                  scope.label === "Document"
                    ? new AllSelection(tr.doc)
                    : TextSelection.between(tr.doc.resolve(scope.from), tr.doc.resolve(scope.to)),
                );
              } else {
                const scope = scopes.find((scope) => scope.label !== "Document");
                if (!scope) return false;
                const after = command === "leaveParentAfter";
                tr = tr.setSelection(
                  TextSelection.near(
                    tr.doc.resolve(
                      after ? (scope.after ?? scope.to) : (scope.before ?? scope.from),
                    ),
                    after ? 1 : -1,
                  ),
                );
                if (scope.mark)
                  tr = tr.setStoredMarks(
                    (storedMarks ?? selection.$head.marks()).filter(
                      (mark) => !mark.eq(scope.mark!),
                    ),
                  );
                history.length = 0;
              }
              applying = true;
              view.dispatch(tr.scrollIntoView());
              applying = false;
              view.focus();
              return true;
            },
          });
          return { update: () => session.refresh(), destroy: () => session.dispose() };
        },
      }),
    ];
  },
});
