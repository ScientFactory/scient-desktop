import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  planLatexVisualPagination,
  type LatexVisualPaginationBlock,
  type LatexVisualPaginationOptions,
} from "./latexVisualPagination";

interface PaginationState {
  readonly decorations: DecorationSet;
  readonly dimensions: LatexVisualPaginationOptions;
  readonly revision: number;
}

type PaginationUpdate =
  | { readonly dimensions: LatexVisualPaginationOptions }
  | { readonly decorations: DecorationSet };

export const latexPaginationKey = new PluginKey<PaginationState>("scientLatexPagination");

export function setLatexPaginationDimensions(
  view: EditorView,
  dimensions: LatexVisualPaginationOptions,
) {
  view.dispatch(
    view.state.tr
      .setMeta(latexPaginationKey, { dimensions } satisfies PaginationUpdate)
      .setMeta("addToHistory", false),
  );
}

interface MeasuredUnit extends LatexVisualPaginationBlock {
  readonly position: number;
  readonly objectPart?: { readonly index: number; readonly node: DocumentNode };
}

interface ObjectPagination {
  readonly node: DocumentNode;
  readonly gaps: Readonly<Record<number, number>>;
}

export function latexObjectPageGaps(
  decorations: readonly Decoration[],
  node: DocumentNode,
): Readonly<Record<number, number>> {
  for (const decoration of decorations) {
    const object = decoration.spec.latexObjectPagination as ObjectPagination | undefined;
    if (object?.node === node) return object.gaps;
  }
  return {};
}

interface TextFragment {
  position: number;
  top: number;
  bottom: number;
}

interface CachedLines {
  readonly width: number;
  readonly height: number;
  readonly font: string;
  readonly lines: readonly TextFragment[];
}

/** Find line starts in rendered text, including text split by marks or view widgets. */
function measureLines(
  view: EditorView,
  node: DocumentNode,
  position: number,
  element: HTMLElement,
): TextFragment[] {
  const fragments: TextFragment[] = [];
  const atoms: TextFragment[] = [];
  const range = element.ownerDocument.createRange();
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(text) {
      const excluded = text.parentElement?.closest(
        '[contenteditable="false"], .scient-latex-pagination-gap',
      );
      return excluded && element.contains(excluded)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let text: globalThis.Node | null;
  while ((text = walker.nextNode())) {
    const length = text.textContent?.length ?? 0;
    if (length === 0) continue;
    range.selectNodeContents(text);
    const rectangles = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    let start = 0;
    for (const rectangle of rectangles) {
      // Binary search inside this DOM text node, never through an equation or
      // across marks. The character's rectangle unambiguously identifies a wrap.
      let low = start,
        high = length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        range.setStart(text, middle);
        range.setEnd(text, Math.min(length, middle + 1));
        const rect = range.getBoundingClientRect();
        if (rect.top < rectangle.top - 0.5) low = middle + 1;
        else high = middle;
      }
      start = low;
      if (start < length)
        fragments.push({
          position: view.posAtDOM(text, start),
          top: rectangle.top,
          bottom: rectangle.bottom,
        });
    }
  }
  node.forEach((child, offset) => {
    if (child.isText) return;
    const dom = view.nodeDOM(position + 1 + offset);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    if (rect.height > 0)
      atoms.push({ position: position + 1 + offset, top: rect.top, bottom: rect.bottom });
  });
  fragments.sort((a, b) => a.top - b.top || a.position - b.position);
  const lines: TextFragment[] = [];
  for (const fragment of fragments) {
    const line = lines[lines.length - 1];
    // Font ink boxes can overlap between successive baselines. Compare their
    // centers, otherwise a tight TeX baseline can merge two entire lines.
    if (
      line &&
      Math.abs((fragment.top + fragment.bottom - line.top - line.bottom) / 2) <
        Math.min(fragment.bottom - fragment.top, line.bottom - line.top) * 0.4
    ) {
      line.position = Math.min(line.position, fragment.position);
      line.top = Math.min(line.top, fragment.top);
      line.bottom = Math.max(line.bottom, fragment.bottom);
    } else lines.push({ ...fragment });
  }
  for (const atom of atoms) {
    const candidates = lines.filter((line) => atom.top < line.bottom && atom.bottom > line.top);
    const line = candidates.sort(
      (a, b) =>
        Math.abs(a.top + a.bottom - atom.top - atom.bottom) -
        Math.abs(b.top + b.bottom - atom.top - atom.bottom),
    )[0];
    if (line) {
      line.position = Math.min(line.position, atom.position);
      line.top = Math.min(line.top, atom.top);
      line.bottom = Math.max(line.bottom, atom.bottom);
    } else lines.push({ ...atom });
  }
  return lines.sort((a, b) => a.top - b.top);
}

function measureDocument(
  view: EditorView,
  cache: WeakMap<DocumentNode, CachedLines>,
  dimensions: LatexVisualPaginationOptions,
): MeasuredUnit[] {
  const root = view.dom;
  const bounds = root.getBoundingClientRect();
  const width = Number.parseFloat(getComputedStyle(root).width) || root.offsetWidth;
  const scale = width > 0 ? bounds.width / width : 1;
  if (!Number.isFinite(scale) || scale <= 0) return [];
  const units: MeasuredUnit[] = [];
  const computed = getComputedStyle(root);
  const font = `${computed.font}|${computed.textAlign}|${computed.textIndent}|${computed.letterSpacing}`;
  const y = (value: number) => (value - bounds.top) / scale;
  const visit = (node: DocumentNode, position: number, before: number = position) => {
    const dom = view.nodeDOM(position);
    if (!(dom instanceof HTMLElement)) return;
    if (
      node.type.name === "bulletList" ||
      node.type.name === "orderedList" ||
      node.type.name === "listItem"
    ) {
      node.forEach((child, offset, index) =>
        visit(child, position + 1 + offset, index === 0 ? before : position + 1 + offset),
      );
      return;
    }
    const rect = dom.getBoundingClientRect();
    const contentHeight = dimensions.pageHeight - dimensions.marginTop - dimensions.marginBottom;
    if (
      node.type.name === "latexRichPreview" &&
      (node.attrs.kind === "description" || node.attrs.kind === "toc")
    ) {
      const items = [
        ...dom.querySelectorAll<HTMLElement>(
          "[data-latex-description-item], [data-latex-toc-entry]",
        ),
      ];
      if (items.length > 0) {
        items.forEach((item, index) => {
          const itemRect = item.getBoundingClientRect();
          units.push({
            position: before,
            top: y(index === 0 ? rect.top : itemRect.top),
            bottom: y(index === items.length - 1 ? rect.bottom : itemRect.bottom),
            keepWithNext:
              node.attrs.kind === "toc" && item.dataset.level === "1" && index < items.length - 1,
            ...(index > 0 ? { objectPart: { index, node } } : {}),
          });
        });
        return;
      }
    }
    if (
      node.type.name === "latexRichPreview" &&
      node.attrs.kind === "table" &&
      (rect.height / scale > contentHeight || node.attrs.tableKind === "long")
    ) {
      const rows = [...dom.querySelectorAll<HTMLElement>("tr[data-latex-table-row]")];
      if (rows.length > 1) {
        rows.forEach((row, index) => {
          const rowRect = row.getBoundingClientRect();
          units.push({
            position: before,
            top: y(index === 0 ? rect.top : rowRect.top),
            bottom: y(index === rows.length - 1 ? rect.bottom : rowRect.bottom),
            keepWithNext: index === 0 && node.attrs.hasHeader === true,
            ...(index > 0 ? { objectPart: { index, node } } : {}),
          });
        });
        return;
      }
    }
    const heading = node.type.name === "heading";
    let lines: TextFragment[] = [];
    if (node.type.name === "paragraph") {
      const cached = cache.get(node);
      if (
        cached &&
        Math.abs(cached.width - rect.width / scale) < 0.1 &&
        Math.abs(cached.height - rect.height / scale) < 0.1 &&
        cached.font === font
      ) {
        lines = cached.lines.map((line) => ({
          position: position + line.position,
          top: rect.top + line.top * scale,
          bottom: rect.top + line.bottom * scale,
        }));
      } else {
        lines = measureLines(view, node, position, dom);
        cache.set(node, {
          width: rect.width / scale,
          height: rect.height / scale,
          font,
          lines: lines.map((line) => ({
            position: line.position - position,
            top: (line.top - rect.top) / scale,
            bottom: (line.bottom - rect.top) / scale,
          })),
        });
      }
    }
    if (lines.length < 2) {
      units.push({
        position: before,
        top: y(rect.top),
        bottom: y(rect.bottom),
        explicitBreak: node.type.name === "latexRichPreview" && node.attrs.kind === "pagebreak",
        keepWithNext: heading,
      });
      return;
    }
    const boundaries = [
      rect.top,
      ...lines.slice(1).map((line, index) => (lines[index]!.bottom + line.top) / 2),
      rect.bottom,
    ];
    lines.forEach((line, index) =>
      units.push({
        position: index === 0 ? before : line.position,
        top: y(boundaries[index]!),
        bottom: y(boundaries[index + 1]!),
        // Two lines at both ends keeps single orphan/widow lines off a sheet.
        keepWithNext: index === 0 || index === lines.length - 2,
      }),
    );
  };
  view.state.doc.forEach((node, offset) => visit(node, offset));
  return units;
}

function gapDecoration(
  position: number,
  height: number,
  explicit: boolean,
  inline: boolean,
): Decoration {
  return Decoration.widget(
    position,
    () => {
      const gap = document.createElement("span");
      gap.className = "scient-latex-pagination-gap";
      gap.setAttribute("aria-hidden", "true");
      gap.setAttribute("contenteditable", "false");
      gap.style.height = `${height}px`;
      if (explicit) gap.dataset.explicit = "true";
      if (inline) gap.dataset.inline = "true";
      return gap;
    },
    { side: -1, key: `page:${position}:${height}:${explicit}:${inline}`, ignoreSelection: true },
  );
}

export const LatexVisualPagination = Extension.create<{
  onPageCount: (count: number) => void;
}>({
  name: "latexVisualPagination",
  addOptions() {
    return { onPageCount: () => {} };
  },
  addProseMirrorPlugins() {
    const onPageCount = this.options.onPageCount;
    return [
      new Plugin<PaginationState>({
        key: latexPaginationKey,
        state: {
          init: () => ({
            decorations: DecorationSet.empty,
            dimensions: { pageHeight: 1056, pageGap: 28, marginTop: 96, marginBottom: 96 },
            revision: 0,
          }),
          apply(transaction, previous) {
            const update = transaction.getMeta(latexPaginationKey) as PaginationUpdate | undefined;
            return {
              decorations:
                update && "decorations" in update
                  ? update.decorations
                  : previous.decorations.map(transaction.mapping, transaction.doc),
              dimensions:
                update && "dimensions" in update ? update.dimensions : previous.dimensions,
              revision: previous.revision + (update && "dimensions" in update ? 1 : 0),
            };
          },
        },
        props: { decorations: (state) => latexPaginationKey.getState(state)?.decorations },
        view(view) {
          let frame = 0;
          let disposed = false;
          let measuring = false;
          let composing = false;
          let signature = "";
          let measuredDocument: DocumentNode | null = null;
          let lineCache = new WeakMap<DocumentNode, CachedLines>();
          const root = view.dom;
          const scroll = () => root.closest<HTMLElement>(".scient-latex-visual-scroll");
          const anchor = () => {
            const viewport = scroll();
            if (!viewport) return null;
            const box = viewport.getBoundingClientRect();
            const point = view.hasFocus()
              ? view.state.selection.head
              : view.posAtCoords({
                  left: Math.max(
                    box.left + 24,
                    root.getBoundingClientRect().left + root.getBoundingClientRect().width / 2,
                  ),
                  top: box.top + Math.min(60, box.height / 3),
                })?.pos;
            if (point === undefined) return null;
            const top = view.coordsAtPos(point).top;
            return top >= box.top && top <= box.bottom ? { position: point, top, viewport } : null;
          };
          const paginate = () => {
            frame = 0;
            if (
              disposed ||
              view.composing ||
              composing ||
              measuring ||
              !root.isConnected ||
              root.getBoundingClientRect().width === 0
            )
              return;
            const state = latexPaginationKey.getState(view.state);
            if (!state) return;
            measuring = true;
            const pinned = anchor();
            const focusedObject = document.activeElement;
            const viewportBefore = scroll()?.getBoundingClientRect();
            const focusedBox =
              focusedObject instanceof HTMLElement &&
              focusedObject !== root &&
              root.contains(focusedObject)
                ? focusedObject.getBoundingClientRect()
                : null;
            const keepObjectVisible =
              focusedBox &&
              viewportBefore &&
              focusedBox.bottom >= viewportBefore.top &&
              focusedBox.top <= viewportBefore.bottom;
            try {
              // Hiding only our widgets exposes natural flow without replacing the
              // editable DOM or touching its native selection and composition.
              root.dataset.latexMeasuring = "true";
              const units = measureDocument(view, lineCache, state.dimensions);
              const plan = planLatexVisualPagination(units, state.dimensions);
              const objects = new Map<
                number,
                { node: DocumentNode; gaps: Record<number, number> }
              >();
              const gaps = plan.placements.flatMap((placement, index) => {
                const unit = units[index]!;
                if (unit.objectPart) {
                  if (placement.offset > 0.5) {
                    const object: { node: DocumentNode; gaps: Record<number, number> } =
                      objects.get(unit.position) ?? {
                        node: unit.objectPart.node,
                        gaps: {},
                      };
                    object.gaps[unit.objectPart.index] = Math.round(placement.offset * 100) / 100;
                    objects.set(unit.position, object);
                  }
                  return [];
                }
                return placement.offset > 0.5
                  ? [
                      {
                        position: unit.position,
                        height: Math.round(placement.offset * 100) / 100,
                        explicit: unit.explicitBreak === true,
                      },
                    ]
                  : [];
              });
              delete root.dataset.latexMeasuring;
              const nextSignature = JSON.stringify([
                gaps,
                [...objects].map(([position, object]) => [position, object.gaps]),
              ]);
              if (signature !== nextSignature || measuredDocument !== view.state.doc) {
                signature = nextSignature;
                measuredDocument = view.state.doc;
                view.dispatch(
                  view.state.tr
                    .setMeta(latexPaginationKey, {
                      decorations: DecorationSet.create(view.state.doc, [
                        ...gaps.map((gap) =>
                          gapDecoration(
                            gap.position,
                            gap.height,
                            gap.explicit,
                            view.state.doc.resolve(gap.position).parent.isTextblock,
                          ),
                        ),
                        ...[...objects].map(([position, object]) =>
                          Decoration.node(
                            position,
                            position + object.node.nodeSize,
                            {},
                            { latexObjectPagination: object },
                          ),
                        ),
                      ]),
                    } satisfies PaginationUpdate)
                    .setMeta("addToHistory", false),
                );
              }
              root.style.setProperty(
                "--scient-latex-document-height",
                `${plan.pageCount * state.dimensions.pageHeight + (plan.pageCount - 1) * state.dimensions.pageGap}px`,
              );
              onPageCount(plan.pageCount);
              if (pinned && root.isConnected)
                pinned.viewport.scrollTop += view.coordsAtPos(pinned.position).top - pinned.top;
              const active = document.activeElement;
              const viewport = scroll();
              if (
                keepObjectVisible &&
                viewport &&
                active instanceof HTMLElement &&
                active === focusedObject
              ) {
                const box = active.getBoundingClientRect();
                const visible = viewport.getBoundingClientRect();
                if (box.bottom > visible.bottom - 20)
                  viewport.scrollTop += box.bottom - visible.bottom + 20;
                else if (box.top < visible.top + 20)
                  viewport.scrollTop += box.top - visible.top - 20;
              }
            } finally {
              delete root.dataset.latexMeasuring;
              measuring = false;
            }
          };
          const schedule = () => {
            if (disposed || frame) return;
            frame = requestAnimationFrame(paginate);
          };
          const fontsChanged = () => {
            lineCache = new WeakMap();
            schedule();
          };
          const compositionStart = () => {
            composing = true;
          };
          const compositionEnd = () => {
            composing = false;
            schedule();
          };
          const resize =
            typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
          const observe = () => {
            resize?.disconnect();
            resize?.observe(root);
            for (const child of root.children) {
              if (!child.classList.contains("scient-latex-pagination-gap")) resize?.observe(child);
            }
          };
          observe();
          root.addEventListener("load", schedule, true);
          root.addEventListener("compositionstart", compositionStart, true);
          root.addEventListener("compositionend", compositionEnd, true);
          document.fonts?.addEventListener("loadingdone", fontsChanged);
          void document.fonts?.ready.then(fontsChanged);
          schedule();
          return {
            update(_view, previous) {
              const before = latexPaginationKey.getState(previous);
              const after = latexPaginationKey.getState(view.state);
              if (previous.doc !== view.state.doc) {
                observe();
                schedule();
              } else if (before?.revision !== after?.revision) {
                lineCache = new WeakMap();
                schedule();
              }
            },
            destroy() {
              disposed = true;
              cancelAnimationFrame(frame);
              resize?.disconnect();
              root.removeEventListener("load", schedule, true);
              root.removeEventListener("compositionstart", compositionStart, true);
              root.removeEventListener("compositionend", compositionEnd, true);
              document.fonts?.removeEventListener("loadingdone", fontsChanged);
            },
          };
        },
      }),
    ];
  },
});
