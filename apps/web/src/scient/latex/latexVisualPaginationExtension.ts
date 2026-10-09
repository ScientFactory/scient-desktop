import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { afterEditorPaint } from "./afterEditorPaint";
import { createEditorBackgroundTask } from "./editorBackgroundTask";
import { latexParagraphSpacing, type ParagraphSpacingCache } from "./latexParagraphSpacing";
import { latexCounterLabel } from "./latexDocumentStructure";
import { latexInlineColumnBreakPositions } from "./latexColumnBreaks";
import { appendLatexProsePreview } from "./LatexProsePreview";
import {
  latexEquationReferencesKey,
  latexReferenceLayoutChanged,
  navigateToFootnote,
} from "./latexEquationReferences";
import {
  planLatexVisualPagination,
  type LatexVisualPaginationBlock,
  type LatexVisualPaginationOptions,
} from "./latexVisualPagination";

interface PaginationState {
  readonly decorations: DecorationSet;
  readonly dimensions: LatexVisualPaginationOptions;
  readonly revision: number;
  readonly pages: readonly { position: number; page: number }[];
}

type PaginationUpdate =
  | { readonly dimensions: LatexVisualPaginationOptions }
  | { readonly decorations: DecorationSet; readonly pages: PaginationState["pages"] };

export const latexPaginationKey = new PluginKey<PaginationState>("scientLatexPagination");

const emptyPages: PaginationState["pages"] = [];
const orderedPageMaps = new WeakMap<PaginationState["pages"], boolean>();
const printedPageLabels = new WeakMap<
  DocumentNode,
  { pages: PaginationState["pages"]; titlePage: boolean; labels: readonly (string | null)[] }
>();

/** Local CSS page map; these values are not compiled TeX page evidence. */
export function latexVisualPageAt(
  state: import("@tiptap/pm/state").EditorState,
  position: number,
): number | null {
  const pages = latexPaginationKey.getState(state)?.pages;
  if (!pages?.length) return null;
  let ordered = orderedPageMaps.get(pages);
  if (ordered === undefined) {
    ordered = pages.every(
      (entry, index) => index === 0 || pages[index - 1]!.position <= entry.position,
    );
    orderedPageMaps.set(pages, ordered);
  }
  if (ordered) {
    // Upper bound retains the last entry at duplicate positions (split objects).
    let low = 0,
      high = pages.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pages[middle]!.position <= position) low = middle + 1;
      else high = middle;
    }
    return pages[Math.max(0, low - 1)]!.page + 1;
  }
  // Unusual rendered line order retains the existing sequential lookup semantics.
  let page = pages[0]!.page;
  for (const entry of pages) {
    if (entry.position > position) break;
    page = entry.page;
  }
  return page + 1;
}

/** Printed labels are separate from physical sheets and reset at document controls. */
export function latexVisualPageLabels(
  state: import("@tiptap/pm/state").EditorState,
): readonly (string | null)[] {
  const pages = latexPaginationKey.getState(state)?.pages ?? emptyPages;
  const titlePage = latexEquationReferencesKey.getState(state)?.titlePage === true;
  const cached = printedPageLabels.get(state.doc);
  if (cached?.pages === pages && cached.titlePage === titlePage) return cached.labels;
  const count = pages.reduce((maximum, entry) => Math.max(maximum, entry.page + 1), 1);
  const resets = new Map<number, string>();
  const covers = new Set<number>();
  state.doc.forEach((node, position) => {
    if (node.type.name !== "latexRichPreview") return;
    const cover = node.attrs.kind === "title" && titlePage;
    const numbering =
      node.attrs.kind === "documentCommand" && node.attrs.environment === "pagenumbering";
    if (!cover && !numbering) return;
    const page = (latexVisualPageAt(state, position) ?? 1) - 1;
    if (cover) {
      covers.add(page);
      resets.set(page + 1, "arabic");
    }
    if (numbering) resets.set(page, String(node.attrs.body));
  });
  let style = "arabic",
    counter = 0;
  const labels = Array.from({ length: count }, (_, page) => {
    const reset = resets.get(page);
    if (reset) {
      style = reset;
      counter = 0;
    }
    counter++;
    return covers.has(page) ? null : latexCounterLabel(counter, style);
  });
  printedPageLabels.set(state.doc, { pages, titlePage, labels });
  return labels;
}

export function latexVisualPageLabelAt(
  state: import("@tiptap/pm/state").EditorState,
  position: number,
): string | null {
  const page = latexVisualPageAt(state, position);
  return page === null ? null : (latexVisualPageLabels(state)[page - 1] ?? null);
}

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
  readonly continuation?: { head: number; foot: number };
}

/** Content edits retain the page map until the new measurements settle. */
function sameObjectStructure(previous: DocumentNode, current: DocumentNode): boolean {
  if (previous === current) return true;
  if (
    previous.type !== current.type ||
    previous.attrs.sourceId == null ||
    previous.attrs.sourceId !== current.attrs.sourceId ||
    previous.attrs.kind !== current.attrs.kind
  )
    return false;
  const keys =
    current.attrs.kind === "table"
      ? ["rowIds", "columnIds", "tableKind", "hasHeader"]
      : ["itemIds"];
  if (!Array.isArray(current.attrs[keys[0]!]) || !Array.isArray(previous.attrs[keys[0]!]))
    return false;
  return keys.every(
    (key) => JSON.stringify(previous.attrs[key]) === JSON.stringify(current.attrs[key]),
  );
}

export function latexObjectContinuationHeights(
  decorations: readonly Decoration[],
  node: DocumentNode,
) {
  for (const decoration of decorations) {
    const object = decoration.spec.latexObjectPagination as ObjectPagination | undefined;
    if (object && sameObjectStructure(object.node, node))
      return object.continuation ?? { head: 0, foot: 0 };
  }
  return { head: 0, foot: 0 };
}

export function latexObjectPageGaps(
  decorations: readonly Decoration[],
  node: DocumentNode,
): Readonly<Record<number, number>> {
  for (const decoration of decorations) {
    const object = decoration.spec.latexObjectPagination as ObjectPagination | undefined;
    if (object && sameObjectStructure(object.node, node)) return object.gaps;
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

interface CachedUnits {
  readonly element: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly context: string;
  readonly units: readonly MeasuredUnit[];
}

/** Measure continuation rows at the body's column widths, including merged cells. */
function measureLongTableBand(dom: HTMLElement, kind: "head" | "foot", scale: number): number {
  const template = dom.querySelector<HTMLTableElement>(`[data-latex-longtable-measure="${kind}"]`);
  const body = dom.querySelector<HTMLTableElement>(".scient-latex-rich-table-scroll > table");
  const host = template?.parentElement;
  if (!template || !body || !host) return 0;
  const copy = template.cloneNode(true) as HTMLTableElement;
  const columns = copy.ownerDocument.createElement("colgroup");
  const firstRow = [...body.querySelectorAll<HTMLTableRowElement>("tr[data-latex-table-row]")].find(
    (row) => [...row.cells].every((cell) => cell.colSpan === 1),
  );
  if (!firstRow) return template.getBoundingClientRect().height / scale;
  for (const cell of firstRow.cells) {
    const column = copy.ownerDocument.createElement("col");
    column.style.width = `${cell.getBoundingClientRect().width / scale}px`;
    columns.append(column);
  }
  copy.prepend(columns);
  copy.style.width = `${body.getBoundingClientRect().width / scale}px`;
  copy.style.maxWidth = "none";
  copy.style.tableLayout = "fixed";
  copy.style.fontSize = getComputedStyle(body).fontSize;
  copy.style.lineHeight = getComputedStyle(body).lineHeight;
  host.append(copy);
  try {
    return copy.getBoundingClientRect().height / scale;
  } finally {
    copy.remove();
  }
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
  blocks: WeakMap<DocumentNode, CachedUnits>,
  unchanged: (element: HTMLElement) => boolean,
): MeasuredUnit[] {
  const root = view.dom;
  const bounds = root.getBoundingClientRect();
  const width = Number.parseFloat(getComputedStyle(root).width) || root.offsetWidth;
  const scale = width > 0 ? bounds.width / width : 1;
  if (!Number.isFinite(scale) || scale <= 0) return [];
  const units: MeasuredUnit[] = [];
  const references = latexEquationReferencesKey.getState(view.state);
  const chapters = ["report", "book"].includes(references?.documentClass ?? "");
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
    const breakBefore =
      (chapters &&
        ((node.type.name === "heading" && node.attrs.level === 6) ||
          (node.type.name === "latexRichPreview" && node.attrs.kind === "toc"))) ||
      (references?.titlePage === true &&
        node.type.name === "latexRichPreview" &&
        node.attrs.kind === "title");
    if (
      node.type.name === "latexScientific" &&
      (!node.attrs.layout ||
        node.attrs.layout.kind === "direction" ||
        (node.attrs.layout.kind === "colorBox" && node.attrs.layout.breakable))
    ) {
      const firstUnit = units.length;
      const heading = dom.querySelector<HTMLElement>(
        ".scient-latex-scientific-heading, .scient-latex-color-box-title",
      );
      if (heading) {
        const headingRect = heading.getBoundingClientRect();
        units.push({
          position: before,
          top: y(rect.top),
          bottom: y(headingRect.bottom),
          keepWithNext: true,
        });
      }
      node.forEach((child, offset) => visit(child, position + 1 + offset));
      const lastUnit = units.length - 1;
      if (
        (dom.dataset.proofEnd === "square" || node.attrs.layout?.kind === "colorBox") &&
        lastUnit >= firstUnit
      ) {
        // Include the generated ending when a proof finishes with a display/list.
        units[lastUnit] = {
          ...units[lastUnit]!,
          bottom: Math.max(units[lastUnit]!.bottom, y(rect.bottom)),
        };
      }
      return;
    }
    const contentHeight = dimensions.pageHeight - dimensions.marginTop - dimensions.marginBottom;
    if (
      node.type.name === "latexRichPreview" &&
      ["description", "toc", "bibliography"].includes(node.attrs.kind)
    ) {
      const items = [
        ...dom.querySelectorAll<HTMLElement>(
          "[data-latex-description-item], [data-latex-toc-entry], [data-latex-bibliography-item]",
        ),
      ];
      if (items.length > 0) {
        items.forEach((item, index) => {
          const itemRect = item.getBoundingClientRect();
          units.push({
            position: before,
            top: y(index === 0 ? rect.top : itemRect.top),
            bottom: y(index === items.length - 1 ? rect.bottom : itemRect.bottom),
            breakBefore: index === 0 && breakBefore,
            keepWithNext:
              node.attrs.kind === "toc" &&
              item.dataset.level === (chapters ? "0" : "1") &&
              index < items.length - 1,
            ...(index > 0 ? { objectPart: { index, node } } : {}),
          });
        });
        return;
      }
    }
    if (
      node.type.name === "latexRichPreview" &&
      node.attrs.kind === "table" &&
      (node.attrs.sourceMeta?.preserveStructure !== true || node.attrs.sourceMeta?.longtable) &&
      (rect.height / scale > contentHeight || node.attrs.tableKind === "long")
    ) {
      const rows = [...dom.querySelectorAll<HTMLElement>("tr[data-latex-table-row]")];
      const headHeight = measureLongTableBand(dom, "head", scale);
      const footHeight = measureLongTableBand(dom, "foot", scale);
      if (rows.length > 1) {
        rows.forEach((row, index) => {
          const rowRect = row.getBoundingClientRect();
          units.push({
            position: before,
            top: y(index === 0 ? rect.top : rowRect.top),
            bottom: y(index === rows.length - 1 ? rect.bottom : rowRect.bottom),
            keepWithNext: index === 0 && node.attrs.hasHeader === true,
            continuationHeaderHeight: index > 0 ? headHeight : 0,
            continuationFooterHeight: index < rows.length - 1 ? footHeight : 0,
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
        unchanged(dom) &&
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
      // A run-in heading floats on the paragraph's first line. Include the
      // paragraph's leading space in its unit, so moving the pair to a new
      // page does not insert a second gap before the paragraph.
      const followingParagraph =
        heading &&
        dom.matches("h4, h5") &&
        getComputedStyle(dom).float !== "none" &&
        dom.nextElementSibling?.tagName === "P"
          ? dom.nextElementSibling.getBoundingClientRect()
          : null;
      units.push({
        position: before,
        top: y(followingParagraph ? Math.min(rect.top, followingParagraph.top) : rect.top),
        bottom: y(rect.bottom),
        explicitBreak: node.type.name === "latexRichPreview" && node.attrs.kind === "pagebreak",
        breakBefore,
        stretch:
          node.type.name === "latexRichPreview" &&
          node.attrs.kind === "spacing" &&
          node.attrs.environment === "vfill",
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
  const context = JSON.stringify([font, chapters, references?.titlePage, dimensions]);
  view.state.doc.forEach((node, offset) => {
    const element = view.nodeDOM(offset);
    if (!(element instanceof HTMLElement)) return;
    const rect = element.getBoundingClientRect();
    const display = element.classList.contains("scient-latex-visual-display-math")
      ? element
      : element.querySelector<HTMLElement>(":scope > .scient-latex-visual-display-math");
    if (display)
      display.style.setProperty(
        "--scient-latex-block-height",
        `${display.getBoundingClientRect().height / scale}px`,
      );
    const top = y(rect.top);
    const cached = blocks.get(node);
    if (
      cached?.element === element &&
      cached.context === context &&
      Math.abs(cached.width - rect.width / scale) < 0.1 &&
      Math.abs(cached.height - rect.height / scale) < 0.1 &&
      unchanged(element)
    ) {
      for (const unit of cached.units)
        units.push({
          ...unit,
          position: offset + unit.position,
          top: top + unit.top,
          bottom: top + unit.bottom,
        });
      return;
    }
    const start = units.length;
    visit(node, offset);
    blocks.set(node, {
      element,
      width: rect.width / scale,
      height: rect.height / scale,
      context,
      units: units.slice(start).map((unit) => ({
        ...unit,
        position: unit.position - offset,
        top: unit.top - top,
        bottom: unit.bottom - top,
      })),
    });
  });
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

export function createLatexVisualPagination(onPageCount: (count: number) => void) {
  return new Plugin<PaginationState>({
    key: latexPaginationKey,
    state: {
      init: () => ({
        decorations: DecorationSet.empty,
        dimensions: { pageHeight: 1056, pageGap: 28, marginTop: 96, marginBottom: 96 },
        revision: 0,
        pages: [],
      }),
      apply(transaction, previous) {
        const update = transaction.getMeta(latexPaginationKey) as PaginationUpdate | undefined;
        let mapped = previous.decorations.map(transaction.mapping, transaction.doc);
        if (transaction.docChanged && !update) {
          // Replacing an atom's attributes can drop its node decoration. Restore
          // only the same object and row/item identities, never a new structure.
          const objects = previous.decorations.find().flatMap((decoration) => {
            const object = decoration.spec.latexObjectPagination as ObjectPagination | undefined;
            if (!object) return [];
            const position = transaction.mapping.map(decoration.from);
            const node = transaction.doc.nodeAt(position);
            return node && sameObjectStructure(object.node, node)
              ? [
                  Decoration.node(
                    position,
                    position + node.nodeSize,
                    {},
                    { latexObjectPagination: { ...object, node } },
                  ),
                ]
              : [];
          });
          mapped = mapped.remove(
            mapped.find().filter((decoration) => decoration.spec.latexObjectPagination),
          );
          mapped = mapped.add(transaction.doc, objects);
        }
        return {
          decorations: update && "decorations" in update ? update.decorations : mapped,
          dimensions: update && "dimensions" in update ? update.dimensions : previous.dimensions,
          revision: previous.revision + (update && "dimensions" in update ? 1 : 0),
          pages:
            update && "pages" in update
              ? update.pages
              : transaction.docChanged
                ? previous.pages.map((entry) => ({
                    ...entry,
                    position: transaction.mapping.map(entry.position),
                  }))
                : previous.pages,
        };
      },
    },
    props: { decorations: (state) => latexPaginationKey.getState(state)?.decorations },
    view(view) {
      let cancelPagination: (() => void) | null = null;
      let refreshObservedBlocks = false;
      let settle: ReturnType<typeof setTimeout> | undefined;
      let lastInput = 0;
      let disposed = false;
      let measuring = false;
      let composing = false;
      let generation = 0;
      let requested = false;
      let cancelYield: (() => void) | undefined;
      let signature = "";
      let measuredDocument: DocumentNode | null = null;
      let typography = "";
      let lineCache = new WeakMap<DocumentNode, CachedLines>();
      let spacingCache: ParagraphSpacingCache = new WeakMap();
      let blockCache = new WeakMap<DocumentNode, CachedUnits>();
      const dirtyBlocks = new Set<Element>();
      const noteHeights = new Map<string, number>();
      const layoutTask = createEditorBackgroundTask(180, 1200);
      const root = view.dom;
      const topBlock = (element: Element | null): Element | null => {
        let current = element;
        while (current && current.parentElement !== root) current = current.parentElement;
        return current;
      };
      const markDirty = (element: Element | null) => {
        const block = topBlock(element);
        if (!block) return;
        dirtyBlocks.add(block);
        if (block.previousElementSibling) dirtyBlocks.add(block.previousElementSibling);
        if (block.nextElementSibling) dirtyBlocks.add(block.nextElementSibling);
      };
      const unchanged = (element: HTMLElement) => !dirtyBlocks.has(topBlock(element)!);
      const invalidate = () => {
        lineCache = new WeakMap();
        spacingCache = new WeakMap();
        blockCache = new WeakMap();
        noteHeights.clear();
      };
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
      const paginate = async () => {
        cancelPagination = null;
        if (refreshObservedBlocks) {
          refreshObservedBlocks = false;
          observe();
        }
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
        requested = false;
        const owner = generation;
        const documentBefore = view.state.doc;
        const stillCurrent = () =>
          !disposed &&
          owner === generation &&
          view.state.doc === documentBefore &&
          !view.composing &&
          !composing &&
          root.isConnected;
        const yieldLayout = () => {
          // Restore the displayed page layout before yielding. Never paint a
          // document with its page gaps hidden, or publish a stale plan.
          delete root.dataset.latexColumnMeasuring;
          delete root.dataset.latexMeasuring;
          return new Promise<boolean>((resolve) => {
            const cancel = afterEditorPaint(() => {
              cancelYield = undefined;
              resolve(stillCurrent());
            });
            cancelYield = () => {
              cancel();
              cancelYield = undefined;
              resolve(false);
            };
          });
        };
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
          const style = getComputedStyle(root);
          const currentTypography = JSON.stringify([
            style.font,
            style.textAlign,
            style.textIndent,
            style.letterSpacing,
          ]);
          if (currentTypography !== typography) {
            typography = currentTypography;
            invalidate();
          }
          const spacing = latexParagraphSpacing(view, spacingCache, unchanged);
          const previousSpacing = state.decorations
            .find()
            .filter((item) => item.spec.latexParagraphSpacing !== undefined);
          const spacingSignature = (items: readonly Decoration[]) =>
            JSON.stringify(
              items.map((item) => [item.from, item.to, item.spec.latexParagraphSpacing]),
            );
          if (spacingSignature(spacing) !== spacingSignature(previousSpacing)) {
            // Word-spacing changes affect the corresponding paragraph and its
            // neighbors, not every cached line in the document.
            const oldSpacing = new Map(
              previousSpacing.map((item) => [item.from, item.spec.latexParagraphSpacing]),
            );
            const newSpacing = new Map(
              spacing.map((item) => [item.from, item.spec.latexParagraphSpacing]),
            );
            for (const position of new Set([...oldSpacing.keys(), ...newSpacing.keys()])) {
              if (oldSpacing.get(position) === newSpacing.get(position)) continue;
              const node = view.state.doc.nodeAt(position);
              if (node) lineCache.delete(node);
              const element = view.nodeDOM(position);
              if (element instanceof Element) markDirty(element);
            }
            view.dispatch(
              view.state.tr
                .setMeta(latexPaginationKey, {
                  pages: state.pages,
                  decorations: state.decorations
                    .remove(previousSpacing)
                    .add(view.state.doc, spacing),
                })
                .setMeta("addToHistory", false),
            );
            schedule();
            return;
          }
          if (!(await yieldLayout())) return;
          root.dataset.latexMeasuring = "true";
          root.dataset.latexColumnMeasuring = "true";
          const columnBreaks = latexInlineColumnBreakPositions(view);
          delete root.dataset.latexColumnMeasuring;
          const previousColumnBreaks = state.decorations
            .find(0, view.state.doc.content.size, (spec) => spec.latexColumnBreak === true)
            .map((decoration) => decoration.from);
          const columnBreaksChanged =
            JSON.stringify(previousColumnBreaks) !== JSON.stringify(columnBreaks);
          const units = measureDocument(view, lineCache, state.dimensions, blockCache, unchanged);
          dirtyBlocks.clear();
          const rootStyle = getComputedStyle(root);
          const rootBox = root.getBoundingClientRect();
          const scale = rootBox.width / (Number.parseFloat(rootStyle.width) || root.offsetWidth);
          const notes = [...(latexEquationReferencesKey.getState(view.state)?.footnotes ?? [])].map(
            ([position, note]) => {
              const row = document.createElement("div");
              row.className = "scient-latex-page-footnote";
              const marker = document.createElement("sup");
              marker.textContent = note.number ?? "*";
              row.append(marker);
              const text = document.createElement("span");
              appendLatexProsePreview(text, note.body);
              row.append(text);
              const measure = document.createElement("div");
              measure.className = "scient-latex-page-footnotes";
              measure.style.left = rootStyle.paddingLeft;
              measure.style.right = rootStyle.paddingRight;
              measure.style.top = "0";
              measure.style.visibility = "hidden";
              measure.contentEditable = "false";
              measure.append(row);
              let height = 0;
              const noteKey = JSON.stringify([
                note.body,
                note.number,
                rootStyle.font,
                rootStyle.width,
                state.dimensions,
              ]);
              const cachedHeight = noteHeights.get(noteKey);
              // Measure beside the editor, never insert temporary children into
              // ProseMirror's source-owned content DOM.
              const host = document.createElement("div");
              host.className = "scient-latex-visual-document";
              host.contentEditable = "false";
              Object.assign(host.style, {
                position: "absolute",
                visibility: "hidden",
                pointerEvents: "none",
                width: rootStyle.width,
                minHeight: "0",
                height: "0",
                padding: "0",
                font: rootStyle.font,
              });
              host.append(measure);
              if (cachedHeight === undefined) root.parentElement?.append(host);
              try {
                height = cachedHeight ?? measure.getBoundingClientRect().height / scale;
                if (cachedHeight === undefined) {
                  if (noteHeights.size >= 256) noteHeights.clear();
                  noteHeights.set(noteKey, height);
                }
              } finally {
                host.remove();
              }
              const unitIndex = units.findLastIndex((unit) => unit.position <= position);
              if (unitIndex >= 0) {
                const unit = units[unitIndex]!;
                units[unitIndex] = { ...unit, footnoteHeight: (unit.footnoteHeight ?? 0) + height };
              }
              return { position, row, height, unitIndex, body: note.body, number: note.number };
            },
          );
          if (!(await yieldLayout())) return;
          const plan = planLatexVisualPagination(units, state.dimensions);
          const notesByPage = new Map<number, typeof notes>();
          for (const note of notes) {
            const page = plan.placements[note.unitIndex]?.page;
            if (page === undefined) continue;
            const list = notesByPage.get(page) ?? [];
            list.push(note);
            notesByPage.set(page, list);
          }
          const objects = new Map<
            number,
            {
              node: DocumentNode;
              gaps: Record<number, number>;
              continuation?: { head: number; foot: number };
            }
          >();
          const gaps = plan.placements.flatMap((placement, index) => {
            const unit = units[index]!;
            if (unit.objectPart) {
              if (placement.offset > 0.5) {
                const object: {
                  node: DocumentNode;
                  gaps: Record<number, number>;
                  continuation?: { head: number; foot: number };
                } = objects.get(unit.position) ?? {
                  node: unit.objectPart.node,
                  gaps: {},
                };
                object.gaps[unit.objectPart.index] = Math.round(placement.offset * 100) / 100;
                object.continuation = {
                  head: unit.continuationHeaderHeight ?? 0,
                  foot: units[index - 1]?.continuationFooterHeight ?? 0,
                };
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
          const paragraphHeights: { position: number; size: number; height: number }[] = [];
          view.state.doc.descendants((node, position) => {
            if (node.type.name !== "paragraph") return !node.isAtom;
            const cached = lineCache.get(node);
            if (!cached) return false;
            paragraphHeights.push({
              position,
              size: node.nodeSize,
              height:
                cached.height +
                gaps.reduce(
                  (sum, gap) =>
                    sum +
                    (gap.position > position && gap.position < position + node.nodeSize
                      ? gap.height
                      : 0),
                  0,
                ),
            });
            return false;
          });
          const nextSignature = JSON.stringify([
            paragraphHeights,
            columnBreaks,
            gaps,
            [...objects].map(([position, object]) => [position, object.gaps, object.continuation]),
            plan.placements.map((placement, index) => [units[index]!.position, placement.page]),
            [...notesByPage].map(([page, items]) => [
              page,
              items.map((item) => [item.position, item.height, item.body, item.number]),
            ]),
          ]);
          if (signature !== nextSignature || measuredDocument !== view.state.doc) {
            signature = nextSignature;
            measuredDocument = view.state.doc;
            view.dispatch(
              view.state.tr
                .setMeta(latexPaginationKey, {
                  pages: plan.placements.map((placement, index) => ({
                    position: units[index]!.position,
                    page: placement.page,
                  })),
                  decorations: DecorationSet.create(view.state.doc, [
                    ...spacing,
                    // ProseMirror must own paragraph attributes. Direct style
                    // writes make its DOM observer reparse embedded math views.
                    ...paragraphHeights.map(({ position, size, height }) =>
                      Decoration.node(
                        position,
                        position + size,
                        { style: `--scient-latex-block-height:${height}px` },
                        { latexReadingHeight: true },
                      ),
                    ),
                    ...columnBreaks.map((position) =>
                      Decoration.widget(
                        position,
                        () => {
                          const gap = document.createElement("span");
                          gap.className = "scient-latex-column-break-gap";
                          gap.contentEditable = "false";
                          gap.setAttribute("aria-hidden", "true");
                          return gap;
                        },
                        {
                          side: -1,
                          key: `column:${position}`,
                          ignoreSelection: true,
                          latexColumnBreak: true,
                        },
                      ),
                    ),
                    ...[...notesByPage].map(([page, items]) =>
                      Decoration.widget(
                        view.state.doc.content.size,
                        () => {
                          const band = document.createElement("div");
                          band.className = "scient-latex-page-footnotes";
                          band.contentEditable = "false";
                          band.setAttribute("aria-label", `Footnotes on page ${page + 1}`);
                          band.style.left = rootStyle.paddingLeft;
                          band.style.right = rootStyle.paddingRight;
                          band.style.top = `${page * (state.dimensions.pageHeight + state.dimensions.pageGap) + state.dimensions.pageHeight - state.dimensions.marginBottom - items.reduce((height, item) => height + item.height, 0)}px`;
                          for (const item of items) {
                            item.row.tabIndex = 0;
                            item.row.setAttribute("role", "button");
                            item.row.setAttribute(
                              "aria-label",
                              `Return to footnote ${item.number ?? ""} marker`,
                            );
                            item.row.dataset.latexFootnotePosition = String(item.position);
                            const edit = () => {
                              const note = view.state.doc.nodeAt(item.position);
                              if (
                                note?.type.name !== "latexInlineCommand" ||
                                note.attrs.name !== "footnote"
                              )
                                return;
                              view.dispatch(
                                view.state.tr.setSelection(
                                  NodeSelection.create(view.state.doc, item.position),
                                ),
                              );
                              navigateToFootnote(view, item.position, false);
                            };
                            item.row.addEventListener("click", (event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              edit();
                            });
                            item.row.addEventListener("keydown", (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                edit();
                              }
                            });
                            band.append(item.row);
                          }
                          return band;
                        },
                        {
                          key: `footnotes:${page}:${view.state.doc.content.size}:${JSON.stringify(items.map((item) => [item.position, item.body, item.number, item.height]))}`,
                          ignoreSelection: true,
                        },
                      ),
                    ),
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
            if (columnBreaksChanged) schedule();
          }
          root.style.setProperty(
            "--scient-latex-document-height",
            `${plan.pageCount * state.dimensions.pageHeight + (plan.pageCount - 1) * state.dimensions.pageGap}px`,
          );
          root.dataset.latexWindowed = "true";
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
            else if (box.top < visible.top + 20) viewport.scrollTop += box.top - visible.top - 20;
          }
        } finally {
          delete root.dataset.latexColumnMeasuring;
          delete root.dataset.latexMeasuring;
          measuring = false;
          if (requested && !disposed) schedule();
        }
      };
      const schedule = () => {
        if (measuring) {
          requested = true;
          return;
        }
        if (disposed || cancelPagination) return;
        clearTimeout(settle);
        const delay = Math.max(0, 220 - (performance.now() - lastInput));
        if (delay > 0) settle = setTimeout(schedule, delay);
        else cancelPagination = afterEditorPaint(paginate);
      };
      // Formula previews, fonts and image sizes settle in bursts. Measure once
      // after a quiet interval, with a bounded wait, rather than after every
      // DOM batch. Typing still owns the longer 220 ms quiet interval above.
      const layoutChanged = (event?: Event) => {
        generation++;
        if (event?.target instanceof Element) markDirty(event.target);
        if (!disposed) layoutTask.schedule(schedule);
      };
      const typing = (event: Event) => {
        if (event.target instanceof Element) markDirty(event.target);
        lastInput = performance.now();
        cancelPagination?.();
        cancelPagination = null;
        layoutChanged();
      };
      const fontsChanged = () => {
        invalidate();
        layoutChanged();
      };
      const compositionStart = () => {
        generation++;
        composing = true;
      };
      const compositionEnd = () => {
        composing = false;
        schedule();
      };
      const resize =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver((entries) => {
              for (const entry of entries) markDirty(entry.target);
              layoutChanged();
            });
      const observed = new Set<Element>();
      const observe = () => {
        const next = new Set<Element>([root]);
        for (const child of root.children) {
          if (
            !child.classList.contains("scient-latex-pagination-gap") &&
            !child.classList.contains("scient-latex-page-footnotes")
          )
            next.add(child);
        }
        // Re-observing every child emits a fresh resize entry for every block,
        // even when typing only changed one paragraph. Retain existing targets.
        for (const element of observed) {
          if (next.has(element)) continue;
          resize?.unobserve(element);
          observed.delete(element);
        }
        for (const element of next) {
          if (observed.has(element)) continue;
          resize?.observe(element);
          observed.add(element);
        }
      };
      observe();
      root.addEventListener("load", layoutChanged, true);
      root.addEventListener("scient-latex-math-preview", layoutChanged);
      root.addEventListener("scient-latex-math-mounted", layoutChanged);
      root.addEventListener("beforeinput", typing, true);
      root.addEventListener("input", layoutChanged, true);
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
            generation++;
            refreshObservedBlocks = true;
            const beforeNodes = new Set(previous.doc.content.content);
            view.state.doc.forEach((node, position) => {
              if (beforeNodes.has(node)) return;
              const element = view.nodeDOM(position);
              if (element instanceof Element) markDirty(element);
            });
            if (latexReferenceLayoutChanged(previous, view.state)) invalidate();
            schedule();
          } else if (
            before?.revision !== after?.revision ||
            latexReferenceLayoutChanged(previous, view.state)
          ) {
            generation++;
            invalidate();
            schedule();
          }
        },
        destroy() {
          disposed = true;
          delete root.dataset.latexWindowed;
          cancelYield?.();
          layoutTask.cancel();
          cancelPagination?.();
          clearTimeout(settle);
          resize?.disconnect();
          root.removeEventListener("load", layoutChanged, true);
          root.removeEventListener("scient-latex-math-preview", layoutChanged);
          root.removeEventListener("scient-latex-math-mounted", layoutChanged);
          root.removeEventListener("beforeinput", typing, true);
          root.removeEventListener("input", layoutChanged, true);
          root.removeEventListener("compositionstart", compositionStart, true);
          root.removeEventListener("compositionend", compositionEnd, true);
          document.fonts?.removeEventListener("loadingdone", fontsChanged);
        },
      };
    },
  });
}

export const LatexVisualPagination = Extension.create<{ onPageCount: (count: number) => void }>({
  name: "latexVisualPagination",
  addOptions() {
    return { onPageCount: () => {} };
  },
  addProseMirrorPlugins() {
    return [createLatexVisualPagination(this.options.onPageCount)];
  },
});
