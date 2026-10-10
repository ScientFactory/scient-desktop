import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { afterEditorPaint } from "./afterEditorPaint";
import { createEditorBackgroundTask } from "./editorBackgroundTask";
import { latexParagraphSpacing, type ParagraphSpacingCache } from "./latexParagraphSpacing";
import { copyLatexTypography, latexTypographyKey } from "./latexTypography";
import {
  createLatexParagraphTextWalker,
  hasUnchangedParagraphMath,
  measureLatexParagraph,
  measureLatexTextLines,
} from "./latexParagraphMeasurement";
import { latexCounterLabel } from "./latexDocumentStructure";
import { latexGapHeightIndex } from "./latexGapHeightIndex";
import {
  finishLatexViewportMeasurements,
  latexViewportContext,
  latexViewportMeasurement,
  latexViewportUnit,
  recordLatexViewportMeasurement,
  type ViewportMeasurement,
} from "./latexViewport";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import {
  createLatexMeasurementSnapshot,
  type LatexMeasurementGeometry,
} from "./latexMeasurementSnapshot";
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
  readonly pageCount: number;
}

type PaginationUpdate =
  | { readonly dimensions: LatexVisualPaginationOptions }
  | {
      readonly decorations: DecorationSet;
      readonly pages: PaginationState["pages"];
      readonly pageCount?: number;
    };

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

interface NaturalBlock {
  readonly node: DocumentNode;
  readonly position: number;
  readonly top: number;
  readonly measurement: CachedUnits;
}

interface ViewportSnapshot {
  readonly node: DocumentNode;
  readonly position: number;
  readonly context: string;
  readonly measurement: ViewportMeasurement;
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
  positionAtDOM: (text: globalThis.Node, offset: number) => number = (text, offset) =>
    view.posAtDOM(text, offset),
  nodeAtDOM: (position: number) => globalThis.Node | null = (position) => view.nodeDOM(position),
): TextFragment[] {
  const fragments: TextFragment[] = [];
  const atoms: TextFragment[] = [];
  const range = element.ownerDocument.createRange();
  const walker = createLatexParagraphTextWalker(element);
  let text: globalThis.Node | null;
  while ((text = walker.nextNode())) {
    for (const line of measureLatexTextLines(text, range))
      fragments.push({
        position: positionAtDOM(text, line.offset),
        top: line.top,
        bottom: line.bottom,
      });
  }
  node.forEach((child, offset) => {
    if (child.isText) return;
    const dom = nodeAtDOM(position + 1 + offset);
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

/** Natural-flow geometry cursor. A resumed batch can supply the current root
 * viewport origin; all retained units remain in document coordinates. */
export function* measureLatexDocument(
  view: EditorView,
  cache: WeakMap<DocumentNode, CachedLines>,
  dimensions: LatexVisualPaginationOptions,
  blocks: WeakMap<DocumentNode, CachedUnits>,
  unchanged: (element: HTMLElement) => boolean,
  naturalBlocks: NaturalBlock[],
  viewportSnapshots: ViewportSnapshot[] = [],
  geometry?: LatexMeasurementGeometry,
): Generator<void, MeasuredUnit[], number | undefined> {
  const root = geometry?.root ?? view.dom;
  const nodeDOM = (position: number) => geometry?.nodeDOM(position) ?? view.nodeDOM(position);
  const sourceElement = (element: HTMLElement) => geometry?.sourceElement(element) ?? element;
  const bounds = root.getBoundingClientRect();
  const width = Number.parseFloat(getComputedStyle(root).width) || root.offsetWidth;
  const scale = width > 0 ? bounds.width / width : 1;
  if (!Number.isFinite(scale) || scale <= 0) return [];
  const units: MeasuredUnit[] = [];
  const references = latexEquationReferencesKey.getState(view.state);
  const chapters = ["report", "book"].includes(references?.documentClass ?? "");
  const computed = getComputedStyle(root);
  const font = `${latexTypographyKey(computed)}|${computed.textAlign}|${computed.textIndent}|${computed.letterSpacing}`;
  let originTop = bounds.top;
  const y = (value: number) => (value - originTop) / scale;
  function* checkpoint(): Generator<void, void, number | undefined> {
    const nextOrigin = yield;
    if (nextOrigin !== undefined) originTop = nextOrigin;
  }
  function* visit(
    node: DocumentNode,
    position: number,
    before: number = position,
  ): Generator<void, void, number | undefined> {
    yield* checkpoint();
    const dom = nodeDOM(position);
    if (!(dom instanceof HTMLElement)) return;
    if (
      node.type.name === "bulletList" ||
      node.type.name === "orderedList" ||
      node.type.name === "listItem"
    ) {
      let offset = 0;
      for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index);
        yield* visit(child, position + 1 + offset, index === 0 ? before : position + 1 + offset);
        offset += child.nodeSize;
      }
      return;
    }
    const rect = dom.getBoundingClientRect();
    const naturalTop = y(rect.top),
      naturalBottom = y(rect.bottom);
    if (dom.hasAttribute("data-latex-viewport-closed")) {
      const geometry = latexViewportMeasurement(view, node, position);
      if (node.type.name === "paragraph")
        cache.set(node, {
          width: rect.width / scale,
          height: rect.height / scale,
          font: "viewport",
          lines: [],
        });
      if (geometry) {
        geometry.lines.forEach((line, index) =>
          units.push({
            keepWithNext: line.keepWithNext ?? false,
            position: index === 0 ? before : position + line.position,
            top: naturalTop + line.top,
            bottom: naturalTop + line.bottom,
          }),
        );
      } else units.push({ position: before, top: naturalTop, bottom: naturalBottom });
      return;
    }
    const firstViewportUnit = units.length;
    const rememberViewport = () => {
      if (node.type.name !== "paragraph" && node.type.name !== "latexDisplayMath") return;
      if (!latexViewportUnit(view, node, position)) return;
      if (![...dom.querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady))
        return;
      viewportSnapshots.push({
        node,
        position,
        context: latexViewportContext(view, node, position),
        measurement: {
          width: rect.width / scale,
          height: rect.height / scale,
          wordSpacing: Number.parseFloat(getComputedStyle(dom).wordSpacing) || 0,
          displayContentHeight:
            node.type.name === "latexDisplayMath"
              ? dom
                  .querySelector<HTMLElement>(".scient-latex-visual-display-math")!
                  .getBoundingClientRect().height / scale
              : undefined,
          lines: units.slice(firstViewportUnit).map((unit, index) => ({
            position: index === 0 ? 0 : unit.position - position,
            top: unit.top - naturalTop,
            bottom: unit.bottom - naturalTop,
            keepWithNext: unit.keepWithNext,
          })),
        },
      });
    };
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
          top: naturalTop,
          bottom: y(headingRect.bottom),
          keepWithNext: true,
        });
      }
      let offset = 0;
      for (const child of node.content.content) {
        yield* visit(child, position + 1 + offset);
        offset += child.nodeSize;
      }
      const lastUnit = units.length - 1;
      if (
        (dom.dataset.proofEnd === "square" || node.attrs.layout?.kind === "colorBox") &&
        lastUnit >= firstUnit
      ) {
        // Include the generated ending when a proof finishes with a display/list.
        units[lastUnit] = {
          ...units[lastUnit]!,
          bottom: Math.max(units[lastUnit]!.bottom, naturalBottom),
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
        for (const [index, item] of items.entries()) {
          yield* checkpoint();
          const itemRect = item.getBoundingClientRect();
          units.push({
            position: before,
            top: index === 0 ? naturalTop : y(itemRect.top),
            bottom: index === items.length - 1 ? naturalBottom : y(itemRect.bottom),
            breakBefore: index === 0 && breakBefore,
            keepWithNext:
              node.attrs.kind === "toc" &&
              item.dataset.level === (chapters ? "0" : "1") &&
              index < items.length - 1,
            ...(index > 0 ? { objectPart: { index, node } } : {}),
          });
        }
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
        for (const [index, row] of rows.entries()) {
          yield* checkpoint();
          const rowRect = row.getBoundingClientRect();
          units.push({
            position: before,
            top: index === 0 ? naturalTop : y(rowRect.top),
            bottom: index === rows.length - 1 ? naturalBottom : y(rowRect.bottom),
            keepWithNext: index === 0 && node.attrs.hasHeader === true,
            continuationHeaderHeight: index > 0 ? headHeight : 0,
            continuationFooterHeight: index < rows.length - 1 ? footHeight : 0,
            ...(index > 0 ? { objectPart: { index, node } } : {}),
          });
        }
        return;
      }
    }
    const heading = node.type.name === "heading";
    let lines: TextFragment[] = [];
    if (node.type.name === "paragraph") {
      const cached = cache.get(node);
      if (
        cached &&
        unchanged(sourceElement(dom)) &&
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
        lines = measureLines(view, node, position, dom, geometry?.posAtDOM, nodeDOM);
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
      rememberViewport();
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
    rememberViewport();
  }
  const context = JSON.stringify([font, chapters, references?.titlePage, dimensions]);
  const readingHeights: [HTMLElement, string][] = [];
  let offset = 0;
  for (const node of view.state.doc.content.content) {
    yield* checkpoint();
    const position = offset;
    offset += node.nodeSize;
    const element = nodeDOM(position);
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    const display = element.classList.contains("scient-latex-visual-display-math")
      ? element
      : element.querySelector<HTMLElement>(
          ":scope > .scient-latex-visual-display-math, :scope > .react-renderer > .scient-latex-visual-display-math",
        );
    // Viewport node views apply these heights through their geometry refresh.
    // Keep direct writes for the legacy full-DOM path only.
    if (display && !latexViewportUnit(view, node, position))
      readingHeights.push([
        sourceElement(display),
        `${display.getBoundingClientRect().height / scale}px`,
      ]);
    const top = y(rect.top);
    const cached = blocks.get(node);
    if (
      cached?.element === sourceElement(element) &&
      cached.context === context &&
      Math.abs(cached.width - rect.width / scale) < 0.1 &&
      Math.abs(cached.height - rect.height / scale) < 0.1 &&
      unchanged(sourceElement(element))
    ) {
      naturalBlocks.push({ node, position, top, measurement: cached });
      for (const unit of cached.units)
        units.push({
          ...unit,
          position: position + unit.position,
          top: top + unit.top,
          bottom: top + unit.bottom,
        });
      continue;
    }
    const start = units.length;
    yield* visit(node, position);
    const measurement: CachedUnits = {
      element: sourceElement(element),
      width: rect.width / scale,
      height: rect.height / scale,
      context,
      units: units.slice(start).map((unit) => ({
        ...unit,
        position: unit.position - position,
        top: unit.top - top,
        bottom: unit.bottom - top,
      })),
    };
    blocks.set(node, measurement);
    naturalBlocks.push({ node, position, top, measurement });
  }
  // Finish geometry reads before changing intrinsic reading heights. Writing
  // between formula reads can force repeated style/layout recalculation.
  for (const [display, height] of readingHeights) {
    if (display.style.getPropertyValue("--scient-latex-block-height") !== height)
      display.style.setProperty("--scient-latex-block-height", height);
  }
  return units;
}

/** Reuse natural flow for unchanged blocks; only ordinary edited paragraphs
 * need fresh line measurements. Structural/opaque layout changes use the full
 * measurement path. Paragraph margins remain stable when siblings and markup
 * are unchanged, so a height delta translates every following natural block.
 */
function measureLocalParagraphs(
  view: EditorView,
  previous: readonly NaturalBlock[],
  lines: WeakMap<DocumentNode, CachedLines>,
  blocks: WeakMap<DocumentNode, CachedUnits>,
  dirty: ReadonlySet<Element>,
  font: string,
): { units: MeasuredUnit[]; naturalBlocks: NaturalBlock[] } {
  const units: MeasuredUnit[] = [];
  const naturalBlocks: NaturalBlock[] = [];
  let displacement = 0;
  view.state.doc.forEach((node, position, index) => {
    const old = previous[index]!;
    let measurement = old.measurement;
    if (node !== old.node || dirty.has(measurement.element)) {
      measurement = measureLatexParagraph(
        view,
        measurement.element,
        (copy, positionAtDOM, nodeAtDOM) => {
          const rect = copy.getBoundingClientRect();
          const fragments = measureLines(view, node, position, copy, positionAtDOM, nodeAtDOM);
          lines.set(node, {
            width: rect.width,
            height: rect.height,
            font,
            lines: fragments.map((line) => ({
              position: line.position - position,
              top: line.top - rect.top,
              bottom: line.bottom - rect.top,
            })),
          });
          const boundaries = [
            rect.top,
            ...fragments.slice(1).map((line, i) => (fragments[i]!.bottom + line.top) / 2),
            rect.bottom,
          ];
          return {
            ...measurement,
            width: rect.width,
            height: rect.height,
            units:
              fragments.length < 2
                ? [{ position: 0, top: 0, bottom: rect.height }]
                : fragments.map((line, i) => ({
                    position: i === 0 ? 0 : line.position - position,
                    top: boundaries[i]! - rect.top,
                    bottom: boundaries[i + 1]! - rect.top,
                    keepWithNext: i === 0 || i === fragments.length - 2,
                  })),
          };
        },
      );
      blocks.set(node, measurement);
    }
    const top = old.top + displacement;
    for (const unit of measurement.units)
      units.push({
        ...unit,
        position: position + unit.position,
        top: top + unit.top,
        bottom: top + unit.bottom,
      });
    naturalBlocks.push({ node, position, top, measurement });
    displacement += measurement.height - old.measurement.height;
  });
  return { units, naturalBlocks };
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
    {
      side: -1,
      key: `page:${position}:${height}:${explicit}:${inline}`,
      ignoreSelection: true,
      latexPageGap: { height, explicit, inline },
    },
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
        pageCount: 0,
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
          pageCount:
            update && "pageCount" in update
              ? (update.pageCount ?? previous.pageCount)
              : previous.pageCount,
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
    props: {
      decorations: (state) => latexPaginationKey.getState(state)?.decorations,
      attributes(state) {
        const pagination = latexPaginationKey.getState(state);
        if (!pagination?.pageCount) return {};
        const { pageCount, dimensions } = pagination;
        const height = pageCount * dimensions.pageHeight + (pageCount - 1) * dimensions.pageGap;
        return {
          "data-latex-windowed": "true",
          style: `--scient-latex-document-height:${height}px`,
        };
      },
    },
    view(view) {
      let cancelPagination: (() => void) | null = null;
      let refreshObservedBlocks = false;
      let settle: ReturnType<typeof setTimeout> | undefined;
      let lastInput = 0;
      let disposed = false;
      let measuring = false;
      let snapshot: Awaited<ReturnType<typeof createLatexMeasurementSnapshot>> = null;
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
      let naturalBlocks: NaturalBlock[] | null = null;
      let naturalWidth = "";
      const dirtyBlocks = new Set<Element>();
      const directDirtyBlocks = new Set<Element>();
      const intrinsicDirtyBlocks = new Set<Element>();
      const measuringResizes = new Set<Element>();
      const resizeSizes = new WeakMap<Element, { width: number; height: number }>();
      const noteHeights = new Map<string, number>();
      const layoutTask = createEditorBackgroundTask(180, 1200);
      const root = view.dom;
      const topBlock = (element: Element | null): Element | null => {
        let current = element;
        while (current && current.parentElement !== root) current = current.parentElement;
        return current;
      };
      const markDirty = (element: Element | null, intrinsic = false) => {
        const block = topBlock(element);
        if (!block) return;
        directDirtyBlocks.add(block);
        if (intrinsic) intrinsicDirtyBlocks.add(block);
        dirtyBlocks.add(block);
        if (block.previousElementSibling) dirtyBlocks.add(block.previousElementSibling);
        if (block.nextElementSibling) dirtyBlocks.add(block.nextElementSibling);
      };
      const unchanged = (element: HTMLElement) => !dirtyBlocks.has(topBlock(element)!);
      const invalidate = () => {
        lineCache = new WeakMap();
        spacingCache = new WeakMap();
        blockCache = new WeakMap();
        naturalBlocks = null;
        noteHeights.clear();
      };
      const localMeasurementBlocks = (width: string): Set<Element> | null => {
        if (
          !naturalBlocks ||
          width !== naturalWidth ||
          naturalBlocks.length !== view.state.doc.childCount
        )
          return null;
        const changed = new Set<Element>();
        const supported =
          naturalBlocks.every((old, index) => {
            const node = view.state.doc.child(index);
            const element = old.measurement.element;
            if (!element.isConnected || element.parentElement !== root) return false;
            if (node === old.node && !directDirtyBlocks.has(element)) return true;
            // Resize notifications also follow our page widgets and focus/style
            // updates on unchanged object views. Reuse their natural geometry
            // when only ordinary page gaps contribute the added height. Objects
            // with repeated table bands or separate object gaps retain the full
            // measurement path. Actual preview/load events always bypass reuse.
            if (
              node === old.node &&
              !intrinsicDirtyBlocks.has(element) &&
              !element.querySelector(
                ".scient-latex-table-page-gap, .scient-latex-object-page-gap, tr[data-latex-longtable-band]",
              )
            ) {
              const scale = root.getBoundingClientRect().width / Number.parseFloat(width);
              const box = element.getBoundingClientRect();
              const gaps = [
                ...element.querySelectorAll<HTMLElement>(".scient-latex-pagination-gap"),
              ].reduce((height, gap) => height + (Number.parseFloat(gap.style.height) || 0), 0);
              if (
                Math.abs(box.width / scale - old.measurement.width) < 0.1 &&
                Math.abs(box.height / scale - gaps - old.measurement.height) < 0.1
              )
                return true;
            }
            if (
              node.type.name !== "paragraph" ||
              !node.sameMarkup(old.node) ||
              !node.childCount ||
              !old.node.childCount ||
              !hasUnchangedParagraphMath(old.node, node)
            )
              return false;
            // Run-in headings share a line with their following paragraph. That
            // flow cannot be reproduced by an isolated paragraph measurement.
            const previous = element.previousElementSibling;
            if (previous && getComputedStyle(previous).float !== "none") return false;
            const style = getComputedStyle(element);
            changed.add(element);
            const maths = [
              ...element.querySelectorAll<HTMLElement>('[data-math-reading-view="true"]'),
            ];
            const objects = node.content.content.filter((child) => !child.isText);
            return (
              style.display === "block" &&
              style.float === "none" &&
              style.writingMode === "horizontal-tb" &&
              style.columnCount === "auto" &&
              !element.querySelector("math-field") &&
              maths.length === objects.length &&
              maths.every((math) => {
                const preview = math.querySelector(".scient-latex-math-preview");
                return (
                  preview?.hasAttribute("data-math-preview-ready") ||
                  preview?.shadowRoot
                    ?.querySelector("[data-math-preview-content]")
                    ?.hasAttribute("data-math-preview-ready")
                );
              })
            );
          }) &&
          [...directDirtyBlocks].every((element) =>
            naturalBlocks!.some((block) => block.measurement.element === element),
          );
        return supported ? changed : null;
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
        measuringResizes.clear();
        requested = false;
        const owner = generation;
        const documentBefore = view.state.doc;
        // Temporary layout switches belong outside ProseMirror's observed DOM.
        // Otherwise each switch asks its DOM observer to read native selection,
        // forcing another layout even though the document did not change.
        const measureScope = root.parentElement ?? root;
        const stillCurrent = () =>
          !disposed &&
          owner === generation &&
          view.state.doc === documentBefore &&
          !view.composing &&
          !composing &&
          root.isConnected &&
          (root.parentElement ?? root) === measureScope;
        const yieldLayout = () => {
          // Restore the displayed page layout before yielding. Never paint a
          // document with its page gaps hidden, or publish a stale plan.
          if (!snapshot) {
            delete measureScope.dataset.latexColumnMeasuring;
            delete measureScope.dataset.latexMeasuring;
          }
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
        const scrollBefore = scroll();
        const scrollTopBefore = scrollBefore?.scrollTop;
        const scrollLeftBefore = scrollBefore?.scrollLeft;
        const viewportBefore = scrollBefore?.getBoundingClientRect();
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
          const style = getComputedStyle(root);
          const currentTypography = JSON.stringify([
            latexTypographyKey(style),
            style.textAlign,
            style.textIndent,
            style.letterSpacing,
          ]);
          if (currentTypography !== typography) {
            typography = currentTypography;
            invalidate();
          }
          const localBlocks = localMeasurementBlocks(style.width);
          const local = localBlocks !== null;
          // Paragraph fitting reads horizontal metrics only. Page gaps and
          // continuation bands do not change those widths, so keep the paper's
          // displayed layout here. Natural-flow measurement below owns the
          // switch that exposes distant math and hides pagination widgets.
          const spacing = latexParagraphSpacing(view, spacingCache, unchanged, local);
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
          const previousColumnBreaks = state.decorations
            .find(0, view.state.doc.content.size, (spec) => spec.latexColumnBreak === true)
            .map((decoration) => decoration.from);
          if (!local) {
            snapshot = await createLatexMeasurementSnapshot(view, yieldLayout);
            if (!stillCurrent()) return;
            if (!snapshot) {
              measureScope.dataset.latexMeasureVisible = "true";
              measureScope.dataset.latexMeasuring = "true";
              measureScope.dataset.latexColumnMeasuring = "true";
            }
          }
          const columnBreaks = local ? previousColumnBreaks : latexInlineColumnBreakPositions(view);
          delete measureScope.dataset.latexColumnMeasuring;
          const columnBreaksChanged =
            JSON.stringify(previousColumnBreaks) !== JSON.stringify(columnBreaks);
          const nextBlocks: NaturalBlock[] = [];
          const viewportSnapshots: ViewportSnapshot[] = [];
          const measured = local
            ? measureLocalParagraphs(
                view,
                naturalBlocks!,
                lineCache,
                blockCache,
                localBlocks!,
                `${latexTypographyKey(style)}|${style.textAlign}|${style.textIndent}|${style.letterSpacing}`,
              )
            : null;
          let units: MeasuredUnit[];
          if (measured) units = measured.units;
          else {
            const measurement = measureLatexDocument(
              view,
              lineCache,
              state.dimensions,
              blockCache,
              unchanged,
              nextBlocks,
              viewportSnapshots,
              snapshot ?? undefined,
            );
            let started = performance.now();
            let next = measurement.next();
            while (!next.done) {
              const pendingInput = (
                navigator as Navigator & { scheduling?: { isInputPending(): boolean } }
              ).scheduling?.isInputPending();
              if (pendingInput || performance.now() - started >= 8) {
                if (!(await yieldLayout())) {
                  measurement.return([]);
                  return;
                }
                // Each batch measures natural flow, but the displayed page map
                // is restored before input and paint. Scrolling during the yield
                // changes viewport coordinates, never document coordinates.
                if (!snapshot) measureScope.dataset.latexMeasuring = "true";
                const origin = (snapshot?.root ?? root).getBoundingClientRect().top;
                started = performance.now();
                next = measurement.next(origin);
              } else next = measurement.next();
            }
            units = next.value;
          }
          // Revealing distant content for a batch can resize its containers.
          // Validate those snapshots in natural flow rather than cancelling
          // every pass on its own temporary presentation changes. Explicit
          // input, fonts, preview events and root width changes still cancel.
          if (measuringResizes.size && !local && !snapshot) {
            const scale = root.getBoundingClientRect().width / Number.parseFloat(style.width);
            const stale = nextBlocks.some(({ measurement }) => {
              if (!measuringResizes.has(measurement.element)) return false;
              const box = measurement.element.getBoundingClientRect();
              return (
                Math.abs(box.width / scale - measurement.width) >= 0.1 ||
                Math.abs(box.height / scale - measurement.height) >= 0.1
              );
            });
            if (stale) {
              generation++;
              requested = true;
              return;
            }
          }
          naturalBlocks = measured?.naturalBlocks ?? nextBlocks;
          naturalWidth = style.width;
          dirtyBlocks.clear();
          directDirtyBlocks.clear();
          intrinsicDirtyBlocks.clear();
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
                latexTypographyKey(rootStyle),
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
              });
              copyLatexTypography(rootStyle, host.style);
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
          for (const snapshot of viewportSnapshots)
            recordLatexViewportMeasurement(
              view,
              snapshot.node,
              snapshot.position,
              snapshot.measurement,
              snapshot.context,
            );
          if (measured)
            for (const block of measured.naturalBlocks) {
              if (
                block.node.type.name !== "paragraph" ||
                !latexViewportUnit(view, block.node, block.position)
              )
                continue;
              recordLatexViewportMeasurement(view, block.node, block.position, {
                width: block.measurement.width,
                height: block.measurement.height,
                lines: block.measurement.units.map((unit) => ({
                  position: unit.position,
                  top: unit.top,
                  bottom: unit.bottom,
                  keepWithNext: unit.keepWithNext,
                })),
                wordSpacing:
                  Number.parseFloat(getComputedStyle(block.measurement.element).wordSpacing) || 0,
              });
            }
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
          delete measureScope.dataset.latexMeasuring;
          const gapHeight = latexGapHeightIndex(gaps);
          const paragraphHeights: { position: number; size: number; height: number }[] = [];
          view.state.doc.descendants((node, position) => {
            if (node.type.name !== "paragraph") return !node.isAtom;
            const cached = lineCache.get(node);
            if (!cached) return false;
            paragraphHeights.push({
              position,
              size: node.nodeSize,
              height: cached.height + gapHeight(position, position + node.nodeSize),
            });
            return false;
          });
          // A user can scroll while the measurement stages yield. Preserve
          // that newer intent instead of returning to the earlier caret/view.
          const followViewport =
            scrollBefore?.scrollTop === scrollTopBefore &&
            scrollBefore?.scrollLeft === scrollLeftBefore;
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
                  pageCount: plan.pageCount,
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
          onPageCount(plan.pageCount);
          finishLatexViewportMeasurements(view);
          if (pinned && followViewport && root.isConnected)
            pinned.viewport.scrollTop += view.coordsAtPos(pinned.position).top - pinned.top;
          const active = document.activeElement;
          const viewport = scroll();
          if (
            keepObjectVisible &&
            followViewport &&
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
          snapshot?.destroy();
          snapshot = null;
          measuringResizes.clear();
          delete measureScope.dataset.latexMeasureVisible;
          delete measureScope.dataset.latexColumnMeasuring;
          delete measureScope.dataset.latexMeasuring;
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
        if (event?.target instanceof Element) markDirty(event.target, true);
        if (!disposed) layoutTask.schedule(schedule);
      };
      const typing = (event: Event) => {
        if (event.target instanceof Element) markDirty(event.target, true);
        lastInput = performance.now();
        cancelPagination?.();
        cancelPagination = null;
        layoutChanged();
      };
      const fontsChanged = () => {
        invalidate();
        layoutChanged();
      };
      const viewportChanged = (event: Event) => {
        const elements: unknown = event instanceof CustomEvent ? event.detail : null;
        if (Array.isArray(elements))
          for (const element of elements) if (element instanceof Element) markDirty(element, true);
        refreshObservedBlocks = true;
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
              let changed = false;
              let snapshots: Map<Element, DocumentNode> | undefined;
              let currentNodes: Set<DocumentNode> | undefined;
              for (const entry of entries) {
                const previousSize = resizeSizes.get(entry.target);
                const { width, height } = entry.contentRect;
                // Intrinsic reading sizes round to layout subpixels. Nested
                // formulas can accumulate those fractions across a wrapper.
                // Keep the accepted baseline so successive real changes still
                // cross the tolerance; explicit preview/font/input events do
                // not depend on this resize filter.
                if (
                  previousSize &&
                  Math.abs(previousSize.width - width) < 0.1 &&
                  Math.abs(previousSize.height - height) <= 0.125
                )
                  continue;
                resizeSizes.set(entry.target, { width, height });
                if (
                  measuring &&
                  (root.parentElement ?? root).hasAttribute("data-latex-measure-visible") &&
                  !(
                    entry.target === root &&
                    previousSize !== undefined &&
                    Math.abs(previousSize.width - width) >= 0.1
                  )
                ) {
                  measuringResizes.add(entry.target);
                  continue;
                }
                // observe() emits an initial entry even when a block has not
                // changed. An existing natural snapshot already measured that
                // exact DOM/node; establish the observation without dirtying it.
                // New content and intrinsic preview/load changes still measure.
                if (
                  previousSize === undefined &&
                  naturalBlocks &&
                  !intrinsicDirtyBlocks.has(entry.target)
                ) {
                  snapshots ??= new Map(
                    naturalBlocks.map((block) => [block.measurement.element, block.node]),
                  );
                  const node = snapshots.get(entry.target);
                  if (node) {
                    currentNodes ??= new Set(view.state.doc.content.content);
                    if (currentNodes.has(node)) continue;
                  }
                }
                markDirty(entry.target);
                changed = true;
              }
              if (changed) layoutChanged();
            });
      const observed = new Set<Element>();
      const sourceElements = () => {
        const next = new Set<Element>([root]);
        view.state.doc.forEach((_node, position) => {
          const element = view.nodeDOM(position);
          if (element instanceof Element) {
            const block = topBlock(element);
            if (block) next.add(block);
          }
        });
        return next;
      };
      const observe = () => {
        const next = sourceElements();
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
      // Admission and editing-context changes can replace a node view's DOM
      // without changing its document node. Keep resize observation attached
      // to the current source blocks, excluding our own pagination widgets.
      const blockChanges = new MutationObserver(() => {
        if (disposed) return;
        const next = sourceElements();
        if (next.size === observed.size && [...next].every((element) => observed.has(element)))
          return;
        refreshObservedBlocks = true;
        layoutChanged();
      });
      blockChanges.observe(root, { childList: true });
      root.addEventListener("load", layoutChanged, true);
      root.addEventListener("scient-latex-math-preview", layoutChanged);
      root.addEventListener("scient-latex-math-mounted", layoutChanged);
      root.addEventListener("scient-latex-viewport-measure", viewportChanged);
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
              if (element instanceof Element) {
                markDirty(element);
              }
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
          cancelYield?.();
          layoutTask.cancel();
          cancelPagination?.();
          clearTimeout(settle);
          resize?.disconnect();
          blockChanges.disconnect();
          root.removeEventListener("load", layoutChanged, true);
          root.removeEventListener("scient-latex-math-preview", layoutChanged);
          root.removeEventListener("scient-latex-math-mounted", layoutChanged);
          root.removeEventListener("scient-latex-viewport-measure", viewportChanged);
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
