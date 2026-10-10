import { Extension } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  TextSelection,
  type SelectionBookmark,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { registerLatexSelection } from "./latexSelectionSession";
import { latexInlineEditingScopes } from "./latexVisualDocument";
import { latexTextSelectionRects } from "./latexTextSelectionRects";
import {
  isLatexSelectionObject,
  latexObjectOwnsPointerSelection,
  latexSelectionBetween,
  latexSelectionObjectAtElement,
} from "./latexObjectSelection";

interface Scope {
  label: string;
  from: number;
  to: number;
  mark?: Mark;
  depth?: number;
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
  latexColor: "Colored text",
  latexBackground: "Text box",
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

function inlineScopes(view: EditorView, source: string | null): Scope[] {
  const { selection } = view.state;
  const { $head } = selection;
  if (!$head.parent.isTextblock) return [];
  const scopes: Scope[] = [];
  const marks: Mark[] = [];
  $head.parent.forEach((node) => {
    for (const mark of node.marks) if (!mark.isInSet(marks)) marks.push(mark);
  });
  const offset = $head.start();
  // Marks stay character ranges: crossing them never promotes ordinary selection.
  for (const mark of marks) {
    const runs: { from: number; to: number }[] = [];
    $head.parent.forEach((node, position) => {
      if (mark.isInSet(node.marks)) {
        const prior = runs.at(-1);
        if (prior?.to === offset + position) prior.to += node.nodeSize;
        else runs.push({ from: offset + position, to: offset + position + node.nodeSize });
      }
    });
    scopes.push(
      ...runs.map((run) => ({
        label: labels[mark.type.name] ?? mark.type.name.replace(/^latex/u, ""),
        ...run,
        mark,
      })),
    );
  }
  const authored = source === null ? null : latexInlineEditingScopes(source);
  if (authored?.length) {
    const exact = authored.flatMap((scope) => {
      const mark = marks.find(
        (mark) =>
          mark.type.name === scope.mark && (!scope.attrs || mark.eq(mark.type.create(scope.attrs))),
      );
      return mark
        ? [
            {
              label: labels[scope.mark] ?? scope.mark.replace(/^latex/u, ""),
              from: offset + scope.from,
              to: offset + scope.to,
              mark,
              depth: scope.depth,
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
  return scopes.sort(
    (a, b) => a.to - a.from - (b.to - b.from) || (b.depth ?? -1) - (a.depth ?? -1),
  );
}

function proseScopes(view: EditorView, source: string | null): Scope[] {
  const { selection, storedMarks } = view.state;
  const { $head } = selection;
  const marks = storedMarks ?? $head.marks();
  const scopes = inlineScopes(view, source).filter(
    (scope) => scope.from <= $head.pos && scope.to >= $head.pos && scope.mark!.isInSet(marks),
  );
  if (
    selection instanceof NodeSelection &&
    isLatexSelectionObject(selection.node) &&
    !latexObjectOwnsPointerSelection(selection.node)
  )
    scopes.push({ label: "Object", from: selection.from, to: selection.to });
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

/** One document range paints visible text, fields and embedded objects together. */
function documentRangeRects(
  view: EditorView,
  from: number,
  to: number,
  measured?: Set<Element>,
): DOMRect[] {
  try {
    const document = view.dom.ownerDocument;
    const start = view.domAtPos(from),
      end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const root = range.commonAncestorContainer;
    const excluded =
      'button,select,[aria-hidden="true"],[hidden],[data-shortcut-status],.scient-latex-visual-raw-label';
    const owner = root instanceof Element ? root : root.parentElement;
    const excludedOwner = owner?.closest(excluded);
    if (excludedOwner && view.dom.contains(excludedOwner)) return [];
    const filter = (node: Node) => {
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      if (node instanceof Element) {
        if (node.matches(excluded)) return NodeFilter.FILTER_REJECT;
        if (
          node.matches("img,input,textarea,svg,canvas,math-field,.scient-latex-math-preview,td,th")
        )
          return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
      acceptNode: filter,
    });
    const rects: DOMRect[] = [];
    let node: Node | null = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.parentElement && getComputedStyle(node.parentElement).visibility === "hidden") {
          node = walker.nextNode();
          continue;
        }
        const leaf = document.createRange();
        const length = node.textContent?.length ?? 0;
        const first = node === range.startContainer ? range.startOffset : 0;
        const last = node === range.endContainer ? range.endOffset : length;
        if (last > first) {
          leaf.setStart(node, first);
          leaf.setEnd(node, last);
          rects.push(...leaf.getClientRects());
        }
      } else if (node instanceof Element) {
        measured?.add(node);
        if (getComputedStyle(node).visibility !== "hidden") {
          if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)
            rects.push(...latexTextSelectionRects(node, 0, node.value.length));
          else {
            const bounds = node.getBoundingClientRect();
            const viewport = node.closest(".scient-latex-mathfield[data-math-viewport-active]");
            const clip = viewport?.getBoundingClientRect() ?? bounds;
            let left = Math.max(bounds.left, clip.left),
              top = Math.max(bounds.top, clip.top),
              right = Math.min(bounds.right, clip.right),
              bottom = Math.min(bounds.bottom, clip.bottom);
            if (node instanceof HTMLElement && node.matches("td,th")) {
              const style = getComputedStyle(node);
              const scale = bounds.width / (node.offsetWidth || 1);
              // Collapsed borders are shared; adjacent cells must not paint
              // twice over the same border strip.
              left += (parseFloat(style.borderLeftWidth) * scale) / 2;
              right -= (parseFloat(style.borderRightWidth) * scale) / 2;
              top += (parseFloat(style.borderTopWidth) * scale) / 2;
              bottom -= (parseFloat(style.borderBottomWidth) * scale) / 2;
            }
            rects.push(new DOMRect(left, top, right - left, bottom - top));
          }
        }
        // Replaced content owns its bounds; descendants must not paint again.
        let next: Node | null = walker.nextSibling();
        while (!next && walker.parentNode()) next = walker.nextSibling();
        node = next;
        continue;
      }
      node = walker.nextNode();
    }
    return rects.filter((rect) => rect.width > 0 && rect.height > 0);
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
    let scopeIndex = 0;
    let scopeCandidates: Scope[] | null = null;
    let exitedScope: Scope | null = null;
    const history: {
      bookmark: SelectionBookmark;
      marks: readonly Mark[] | null;
      scopeIndex: number;
    }[] = [];
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            pointerdown: () => {
              history.length = 0;
              scopeIndex = 0;
              scopeCandidates = null;
              exitedScope = null;
              return false;
            },
          },
        },
        state: {
          init: () => null,
          apply(tr) {
            if (bookmark) bookmark = bookmark.map(tr.mapping);
            if (tr.docChanged || (tr.selectionSet && !applying)) {
              history.length = 0;
              scopeIndex = 0;
              scopeCandidates = null;
              exitedScope = null;
            }
            return null;
          },
        },
        view(view) {
          let observed = new Set<Element>();
          const refreshGeometry = () => {
            if (!view.dom.hasAttribute("data-scient-active-slot")) {
              resize?.disconnect();
              observed.clear();
              return;
            }
            session.refresh();
          };
          const resize =
            typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refreshGeometry);
          const session = registerLatexSelection({
            element: view.dom,
            enterFrom: (child) => {
              const object = latexSelectionObjectAtElement(view, child);
              if (!object || view.isDestroyed) return;
              const selection = NodeSelection.create(view.state.doc, object.position);
              if (!view.state.selection.eq(selection))
                view.dispatch(view.state.tr.setSelection(selection));
            },
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
                scopes: () => {
                  if (view.dom.closest('td,th,.scient-latex-rich-preview[data-kind="table"]'))
                    return [];
                  const format = scopes.find((scope) => scope.mark);
                  if (format) return rangeRects(view, format.from, format.to);
                  const slot = view.dom.closest(".scient-latex-inline-field");
                  return slot ? [slot.getBoundingClientRect()] : [];
                },
                selectionOverlay: true,
                selection: () => {
                  const selection = bookmark?.resolve(view.state.doc);
                  const measured = new Set<Element>([view.dom]);
                  const rects =
                    selection && !selection.empty
                      ? documentRangeRects(view, selection.from, selection.to, measured)
                      : [];
                  for (const element of observed)
                    if (!measured.has(element)) resize?.unobserve(element);
                  for (const element of measured)
                    if (!observed.has(element)) resize?.observe(element);
                  observed = measured;
                  return rects;
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
              if (command === "enterScope") {
                if (!selection.empty || !selection.$head.parent.isTextblock) return false;
                const marks = storedMarks ?? selection.$head.marks();
                const candidates = inlineScopes(view, source(selection.$head.parent));
                // At a shared boundary, enter the following span before the previous one.
                // Equal ranges retain authored outer-to-inner ordering.
                const available = candidates
                  .filter(
                    (scope) =>
                      scope.from <= selection.head &&
                      scope.to >= selection.head &&
                      !scope.mark!.isInSet(marks),
                  )
                  .sort(
                    (a, b) =>
                      Number(b.to > selection.head) - Number(a.to > selection.head) ||
                      b.to - b.from - (a.to - a.from) ||
                      (a.depth ?? -1) - (b.depth ?? -1),
                  );
                const next =
                  available.find(
                    (scope) =>
                      exitedScope?.mark?.eq(scope.mark!) &&
                      scope.from === exitedScope.from &&
                      scope.to === exitedScope.to,
                  ) ?? available[0];
                if (!next) return false;
                const surrounding = marks.filter((mark) => {
                  const ranges = candidates.filter((scope) => scope.mark!.eq(mark));
                  return (
                    !ranges.length ||
                    ranges.some((scope) => scope.from <= next.from && scope.to >= next.to)
                  );
                });
                tr = tr.setStoredMarks(next.mark!.addToSet(surrounding));
                history.length = 0;
                scopeIndex = 0;
                scopeCandidates = null;
                exitedScope = null;
              } else if (command === "selectionShrink") {
                const previous = history.pop();
                if (!previous) return false;
                scopeIndex = previous.scopeIndex;
                tr = tr
                  .setSelection(previous.bookmark.resolve(tr.doc))
                  .setStoredMarks(previous.marks);
              } else if (command === "selectionExpand" || command === "selectionScopeExpand") {
                if (
                  command === "selectionExpand" &&
                  selection.empty &&
                  selection.$from.parent.isTextblock
                ) {
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
                if (command === "selectionScopeExpand" && !scopeCandidates)
                  scopeCandidates = scopes;
                const candidates = command === "selectionScopeExpand" ? scopeCandidates! : scopes;
                const next = candidates.findIndex(
                  (scope, index) =>
                    (command !== "selectionScopeExpand" || index >= scopeIndex) &&
                    scope.from <= selection.from &&
                    scope.to >= selection.to &&
                    (command === "selectionScopeExpand" ||
                      scope.from < selection.from ||
                      scope.to > selection.to),
                );
                const scope = candidates[next];
                if (!scope) return false;
                history.push({ bookmark: selection.getBookmark(), marks: storedMarks, scopeIndex });
                scopeIndex = next + 1;
                tr = tr.setSelection(
                  scope.label === "Document"
                    ? new AllSelection(tr.doc)
                    : scope.label === "Object"
                      ? NodeSelection.create(tr.doc, scope.from)
                      : latexSelectionBetween(tr.doc, scope.from, scope.to),
                );
              } else {
                const scope = scopes.find((scope) => scope.label !== "Document");
                if (!scope) return false;
                exitedScope = scope.mark ? scope : null;
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
                scopeIndex = 0;
                scopeCandidates = null;
              }
              applying = true;
              view.dispatch(tr.scrollIntoView());
              applying = false;
              view.focus();
              return true;
            },
          });
          const mutations = new MutationObserver(refreshGeometry);
          mutations.observe(view.dom, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["hidden", "style", "class", "src"],
          });
          view.dom.ownerDocument.fonts?.addEventListener("loadingdone", refreshGeometry);
          return {
            update: () => session.refresh(),
            destroy: () => {
              mutations.disconnect();
              resize?.disconnect();
              view.dom.ownerDocument.fonts?.removeEventListener("loadingdone", refreshGeometry);
              session.dispose();
            },
          };
        },
      }),
    ];
  },
});
