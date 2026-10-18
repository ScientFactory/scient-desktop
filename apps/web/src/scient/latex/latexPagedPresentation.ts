import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { observeResize } from "~/lib/observeResize";
import {
  measureNatural,
  naturalTextLines,
  resetNaturalMeasurement,
} from "./latexNaturalMeasurement";
import { planPagedFlow, type PagedPlan, type PagedUnit } from "./latexPagedFlow";
import { latexVisualLayoutProfile, CSS_PIXELS_PER_INCH } from "./latexVisualLayout";
import { appendLatexProsePreview } from "./LatexProsePreview";
import { latexRunningPageFields, latexRunningPageStyle } from "./latexPageLayouts";
import { latexBlockFootnotes, latexEquationReferencesKey } from "./latexEquationReferences";
import { documentLayoutSettings } from "./latexDocumentLayoutSettings";
import { latexPreambleEnd } from "./latexSourceSyntax";

import {
  passiveBoundary,
  applyPassivePageGaps,
  type PassiveBoundary,
} from "./latexPassivePagination";

import { presentPagedSheets, pagedPageNumbering } from "./latexPagedSheets";

interface Part {
  readonly unit: PagedUnit;
  readonly from: number;
  readonly to: number;
  readonly naturalTop: number;
  readonly row?: number | undefined;
  readonly passive?: PassiveBoundary | undefined;
}
interface Measurement {
  readonly parts: readonly Part[];
  readonly height: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly wordSpacing?: number;
  readonly lastLineEnd?: number;
  readonly displayIndent?: number;
  readonly nestedDisplays?: readonly { from: number; to: number }[];
}
interface Region {
  readonly node: DocumentNode;
  readonly position: number;
  readonly element: HTMLElement;
}
interface Entry {
  readonly node: DocumentNode;
  readonly position: number;
  readonly element: HTMLElement;
  readonly measurement: Measurement;
  readonly region?: Region | undefined;
}
import {
  latexPagedKey,
  pagedLayoutProgress,
  type PageGeometry,
  type Presentation,
} from "./latexPagedGeometry";
export { latexPagedKey, visualPageAt } from "./latexPagedGeometry";

function measured(
  view: EditorView,
  entry: Omit<Entry, "measurement">,
  capacity: number,
): Measurement {
  const { node, position, element } = entry;
  const style = getComputedStyle(element);
  const preceding = view.state.doc.resolve(position).nodeBefore;
  const followsRunIn =
    node.type.name === "paragraph" &&
    preceding?.type.name === "heading" &&
    [4, 5].includes(Number(preceding.attrs.level));
  const canMeasureLive =
    (node.type.name === "paragraph" || node.type.name === "latexDisplayMath") &&
    !entry.region &&
    (node.type.name !== "paragraph" || element.checkVisibility({ contentVisibilityAuto: true })) &&
    !followsRunIn &&
    !element.style.getPropertyValue("--scient-paged-display-shrink") &&
    !element.querySelector(
      ".scient-latex-pagination-gap,.scient-paged-line,[data-paged-repeat],math-field",
    ) &&
    (node.type.name !== "paragraph" ||
      node.textContent.length * parseFloat(style.fontSize) >= element.clientWidth * 3);
  return measureNatural(
    view,
    element,
    (copy, sourceAt, copied) => {
      const scale = canMeasureLive
        ? view.dom.getBoundingClientRect().width / view.dom.offsetWidth
        : 1;
      const naturalRect = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top / scale, bottom: rect.bottom / scale, height: rect.height / scale };
      };
      if (followsRunIn) {
        copy.style.paddingTop = style.paddingTop;
        const heading = view.nodeDOM(position - preceding!.nodeSize);
        if (heading instanceof HTMLElement) {
          const zoom = view.dom.getBoundingClientRect().width / view.dom.offsetWidth;
          const style = getComputedStyle(heading);
          copy.style.textIndent = `${heading.getBoundingClientRect().width / zoom + (parseFloat(style.marginInlineEnd) || 0)}px`;
        }
      }
      let wordSpacing: number | undefined;
      // TeX can shrink interword glue slightly instead of stranding a short formula on a second line.
      if (
        node.type.name === "paragraph" &&
        style.textAlign === "justify" &&
        node.textContent.length * parseFloat(style.fontSize) < parseFloat(copy.style.width) * 3 &&
        !node.content.content.some((child) => child.type.name === "hardBreak")
      ) {
        copy.style.wordSpacing = "normal";
        const width = copy.getBoundingClientRect().width;
        const originalWhiteSpace = copy.style.whiteSpace;
        copy.style.whiteSpace = "pre";
        const range = document.createRange();
        range.selectNodeContents(copy);
        const intrinsic = range.getBoundingClientRect().width + (parseFloat(style.textIndent) || 0);
        copy.style.whiteSpace = originalWhiteSpace;
        const spaces = (node.textContent.match(/ /gu) ?? []).length;
        const shrink = spaces ? (intrinsic - width + 1) / spaces : 0;
        if (
          intrinsic > width &&
          intrinsic < width * 1.03 &&
          shrink > 0 &&
          shrink <= parseFloat(style.fontSize) / 12
        ) {
          const limit = parseFloat(style.fontSize) / 12;
          const singleLine = (amount: number) => {
            copy.style.wordSpacing = `${-amount}px`;
            const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
            const tops: number[] = [];
            let text: globalThis.Node | null;
            while ((text = walker.nextNode())) {
              range.selectNodeContents(text);
              for (const rect of range.getClientRects())
                if (rect.width > 0 && !tops.some((top) => Math.abs(top - rect.top) < 2))
                  tops.push(rect.top);
            }
            return tops.length <= 1;
          };
          if (singleLine(limit)) {
            let low = 0,
              high = limit;
            for (let step = 0; step < 6; step++) {
              const middle = (low + high) / 2;
              if (singleLine(middle)) high = middle;
              else low = middle;
            }
            // Fractional zoom and inline atom baselines can round the live line differently.
            wordSpacing = -Math.min(limit, high + 0.05);
            copy.style.wordSpacing = `${wordSpacing}px`;
          } else copy.style.wordSpacing = "normal";
        }
      }
      const nestedDisplays: { from: number; to: number }[] = [];
      // The same display glue applies inside proofs, statements and framed bodies.
      for (const math of copy.querySelectorAll(".node-latexDisplayMath"))
        math.removeAttribute("data-short-display");
      node.descendants((child, offset) => {
        if (child.type.name !== "latexDisplayMath") return;
        const at = position + 1 + offset;
        const previous = view.state.doc.resolve(at).nodeBefore;
        if (previous?.type.name !== "paragraph") return;
        const previousDOM = view.nodeDOM(at - previous.nodeSize),
          mathDOM = view.nodeDOM(at);
        const paragraph = previousDOM instanceof HTMLElement ? copied(previousDOM) : undefined;
        const math = mathDOM instanceof HTMLElement ? copied(mathDOM) : undefined;
        const formula = math?.querySelector(".scient-latex-math-preview,math-field");
        if (!paragraph || !math || !formula) return;
        const leading = parseFloat(getComputedStyle(paragraph).lineHeight);
        const range = paragraph.ownerDocument.createRange();
        range.selectNodeContents(paragraph);
        const rectangles = [...range.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0 && rect.height < leading * 1.8,
        );
        if (!rectangles.length) return;
        const bottom = Math.max(...rectangles.map((rect) => rect.bottom));
        const right = Math.max(
          ...rectangles.filter((rect) => rect.bottom > bottom - 4).map((rect) => rect.right),
        );
        if (
          right + 2 * parseFloat(getComputedStyle(math).fontSize) <
          formula.getBoundingClientRect().left
        ) {
          math.setAttribute("data-short-display", "true");
          nestedDisplays.push({ from: offset + 1, to: offset + 1 + child.nodeSize });
        }
      });
      const bounds = naturalRect(copy);
      const leftEdge = copy.getBoundingClientRect().left / scale;
      let lastLineEnd: number | undefined;
      const runIn = node.type.name === "heading" && [4, 5].includes(Number(node.attrs.level));
      const pieces: {
        from: number;
        to: number;
        top: number;
        bottom: number;
        row?: number;
        keep?: boolean;
        passive?: PassiveBoundary | undefined;
      }[] = [];
      const paragraphs: { node: DocumentNode; position: number; element: HTMLElement }[] = [];
      const collect = (child: DocumentNode, at: number) => {
        if (!child.isTextblock) return true;
        const live = view.nodeDOM(at);
        const target = live instanceof HTMLElement ? copied(live) : undefined;
        if (target) paragraphs.push({ node: child, position: at, element: target });
        return false;
      };
      const indivisible =
        [
          "landscape",
          "titlepage",
          "framedFigure",
          "contentFloat",
          "basicBox",
          "minipage",
          "row",
          "columns",
        ].includes(String(node.attrs.layout?.kind)) ||
        (node.attrs.layout?.kind === "colorBox" && !node.attrs.layout.breakable);
      if (node.isTextblock) paragraphs.push({ node, position, element: copy });
      else if (!node.isAtom && !indivisible)
        node.descendants((child, offset) => collect(child, position + 1 + offset));
      for (const paragraph of paragraphs) {
        const rect = naturalRect(paragraph.element);
        let sourceMacro = false;
        paragraph.node.forEach((child) => {
          if (child.type.name === "latexInlineCommand" && child.attrs.name === "proseMacro")
            sourceMacro = true;
        });
        const walker = document.createTreeWalker(
          paragraph.element,
          NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
          {
            acceptNode: (item) =>
              item instanceof Element
                ? item.matches(".scient-latex-math-preview,.node-latexInlineMath")
                  ? NodeFilter.FILTER_REJECT
                  : sourceMacro &&
                      (item.closest('[data-paged-passive-root="macro"]') ||
                        item.querySelector('[data-paged-passive-root="macro"]'))
                    ? NodeFilter.FILTER_SKIP
                    : item.matches('[contenteditable="false"],.node-latexInlineCommand')
                      ? NodeFilter.FILTER_REJECT
                      : NodeFilter.FILTER_SKIP
                : NodeFilter.FILTER_ACCEPT,
          },
        );
        const range = document.createRange();
        const lines: {
          from: number;
          top: number;
          bottom: number;
          passive?: PassiveBoundary | undefined;
          right?: number;
        }[] = [];
        let text: globalThis.Node | null;
        while ((text = walker.nextNode())) {
          for (const rawLine of naturalTextLines(text, range)) {
            const line = {
              ...rawLine,
              top: rawLine.top / scale,
              bottom: rawLine.bottom / scale,
              right: rawLine.right / scale,
            };
            let from: number;
            const macro = text.parentElement?.closest('[data-paged-passive-root="macro"]');
            let passive: PassiveBoundary | undefined;
            try {
              from = macro ? sourceAt(macro, 0) : sourceAt(text, line.offset);
              if (macro) passive = passiveBoundary(macro, text, line.offset, from);
            } catch {
              continue;
            }
            const prior = lines.find((item) => Math.abs(item.top - line.top) < 2);
            if (prior) {
              prior.from = Math.min(prior.from, from);
              prior.bottom = Math.max(prior.bottom, line.bottom);
              prior.right = Math.max(prior.right ?? 0, line.right);
            } else
              lines.push({ from, top: line.top, bottom: line.bottom, passive, right: line.right });
          }
        }
        // Inline fractions and scripts can extend beyond the prose glyphs.
        // Their complete ink belongs to the same line when choosing a page cut.
        // A macro's printed characters have no independent model offsets.
        // Keep its paragraph together rather than create page cuts inside its call.
        for (const atom of sourceMacro
          ? []
          : paragraph.element.querySelectorAll(".node-latexInlineMath")) {
          const box = atom.getBoundingClientRect();
          if (!box.height || !box.width) continue;
          let from: number;
          try {
            from = sourceAt(atom, 0);
          } catch {
            continue;
          }
          const top = box.top / scale,
            bottom = box.bottom / scale;
          const nearest = lines
            .filter((line) => line.top < bottom && line.bottom > top)
            .sort(
              (a, b) =>
                Math.abs(a.top + a.bottom - top - bottom) -
                Math.abs(b.top + b.bottom - top - bottom),
            )[0];
          if (nearest) {
            nearest.from = Math.min(nearest.from, from);
            nearest.top = Math.min(nearest.top, top);
            nearest.bottom = Math.max(nearest.bottom, bottom);
            nearest.right = Math.max(nearest.right ?? 0, box.right / scale);
          } else lines.push({ from, top, bottom });
        }
        lines.sort((a, b) => a.top - b.top);
        if (paragraph.node === node && lines.at(-1)?.right !== undefined)
          lastLineEnd = lines.at(-1)!.right! - leftEdge;
        if (!lines.length)
          lines.push({ from: paragraph.position + 1, top: rect.top, bottom: rect.bottom });
        const edges = [
          rect.top,
          ...lines.slice(1).map((line, index) => (lines[index]!.bottom + line.top) / 2),
          rect.bottom,
        ];
        const following = view.state.doc.resolve(
          paragraph.position + paragraph.node.nodeSize,
        ).nodeAfter;
        lines.forEach((line, index) =>
          pieces.push({
            from: (index === 0 ? paragraph.position + 1 : line.from) - position,
            to: line.passive
              ? line.from + 1 - position
              : (lines[index + 1]?.from ?? paragraph.position + paragraph.node.nodeSize - 1) -
                position,
            passive: line.passive,
            top: edges[index]! - bounds.top,
            bottom: edges[index + 1]! - bounds.top,
            keep:
              paragraph.node.type.name === "heading" ||
              (lines.length > 1 && (index === 0 || index === lines.length - 2)) ||
              (lines.length === 1 && following?.type.name === "latexDisplayMath"),
          }),
        );
      }
      if (node.attrs.kind === "toc") {
        for (const row of copy.querySelectorAll<HTMLElement>("li[data-latex-toc-entry]")) {
          const rect = naturalRect(row);
          pieces.push({
            from: 0,
            to: node.nodeSize,
            top: rect.top - bounds.top,
            bottom: rect.bottom - bounds.top,
            passive: passiveBoundary(
              copy.querySelector('[data-paged-passive-root="contents"]')!,
              row,
              0,
              position,
            ),
          });
        }
      }
      const longtable = element.querySelector('figure[data-table-kind="long"]');
      if (longtable) {
        for (const row of copy.querySelectorAll<HTMLElement>("tr[data-latex-table-row]")) {
          const rect = naturalRect(row);
          pieces.push({
            from: 0,
            to: node.nodeSize,
            top: rect.top - bounds.top,
            bottom: rect.bottom - bounds.top,
            row: Number(row.dataset.latexTableRow),
          });
        }
      }
      if (!pieces.length)
        pieces.push({
          from: 0,
          to: node.nodeSize,
          top: 0,
          bottom: bounds.height,
          keep: node.attrs.layout?.kind === "macroHeading",
        });
      pieces.sort((a, b) => a.top - b.top);
      const headHeight = [
        ...copy.querySelectorAll<HTMLElement>(
          '[data-paged-measurement] [data-latex-longtable-band="head"]',
        ),
      ].reduce((sum, row) => sum + row.offsetHeight, 0);
      const footHeight = [
        ...copy.querySelectorAll<HTMLElement>(
          '[data-paged-measurement] [data-latex-longtable-band="foot"]',
        ),
      ].reduce((sum, row) => sum + row.offsetHeight, 0);
      let bottom = 0;
      const parts = pieces.map((piece, index): Part => {
        const end =
          index === pieces.length - 1 ? Math.max(piece.bottom, bounds.height) : piece.bottom;
        const first = index === 0;
        const gap = Math.max(0, piece.top - bottom);
        const height = Math.max(0, end - (first ? 0 : piece.top));
        bottom = end;
        const pagebreak = node.type.name === "latexRichPreview" && node.attrs.kind === "pagebreak";
        return {
          from: piece.from,
          to: piece.to,
          naturalTop: first ? 0 : piece.top,
          row: piece.row,
          passive: piece.passive,
          unit: {
            key: {},
            height:
              pagebreak || runIn ? 0 : node.attrs.layout?.kind === "landscape" ? capacity : height,
            gap,
            keepWithNext: piece.keep,
            breakBefore:
              first &&
              ((node.type.name === "heading" && node.attrs.latexCommand === "chapter") ||
                ["titlepage", "landscape"].includes(String(node.attrs.layout?.kind)) ||
                ["titlepage", "landscape"].includes(String(preceding?.attrs.layout?.kind))),
            break: pagebreak
              ? "page"
              : node.type.name === "latexScientific" && node.attrs.layout?.command === "columnbreak"
                ? "column"
                : undefined,
            stretch: node.attrs.layout?.command === "vfill" || node.attrs.environment === "vfill",
            continuationHead: headHeight,
            continuationFoot: footHeight,
            // Display glue belongs to the outer node margins, not the ink box.
            // TeX discards trailing glue and fits the final baseline before its depth.
            depth:
              node.type.name === "latexDisplayMath"
                ? (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2) * 0.5
                : 0,
          },
        };
      });
      return {
        parts,
        height: bounds.height,
        marginTop:
          followsRunIn || runIn
            ? 0
            : node.type.name === "latexDisplayMath"
              ? parseFloat(style.fontSize) * 0.9 -
                (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2) * 0.2
              : parseFloat(style.marginTop) || 0,
        marginBottom:
          node.type.name === "latexDisplayMath"
            ? parseFloat(style.fontSize) * 0.9
            : parseFloat(style.marginBottom) || 0,
        ...(wordSpacing === undefined ? {} : { wordSpacing }),
        ...(lastLineEnd === undefined ? {} : { lastLineEnd }),
        ...(nestedDisplays.length ? { nestedDisplays } : {}),
        ...(node.type.name === "latexDisplayMath"
          ? {
              displayIndent:
                (copy
                  .querySelector(".scient-latex-math-preview,math-field")
                  ?.getBoundingClientRect().left ?? 0) /
                  scale -
                leftEdge,
            }
          : {}),
      };
    },
    canMeasureLive,
  );
}

/** Page sheets are outside ProseMirror; one live model owns every visible fragment. */
export const LatexPagedPresentation = Extension.create<{ source: () => string }>({
  name: "latexPagedPresentation",
  addOptions() {
    return { source: () => "" };
  },
  addProseMirrorPlugins() {
    const source = this.options.source;
    return [
      new Plugin<Presentation>({
        key: latexPagedKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, plan: null, geometry: [], revision: 0 }),
          apply(tr, previous) {
            const next = tr.getMeta(latexPagedKey) as Presentation | undefined;
            return (
              next ??
              (tr.docChanged
                ? {
                    ...previous,
                    decorations: previous.decorations.map(tr.mapping, tr.doc),
                    geometry: previous.geometry.map((part) => ({
                      ...part,
                      from: tr.mapping.map(part.from),
                      to: tr.mapping.map(part.to),
                    })),
                  }
                : previous)
            );
          },
        },
        props: { decorations: (state) => latexPagedKey.getState(state)?.decorations ?? null },
        view(view) {
          const progress = { pending: true };
          pagedLayoutProgress.set(view, progress);
          let frame = 0,
            epoch = 0,
            disposed = false;
          const mathFonts = [...(document.fonts ?? [])].filter((face) =>
            /^['"]?KaTeX/u.test(face.family),
          );
          let fontsReady = mathFonts.every(
            (face) => face.status === "loaded" || face.status === "error",
          );
          let running = false;
          let refresh = false;
          let previousPlan: PagedPlan | undefined;
          let previousPlacements = new WeakMap<object, PagedPlan["placements"][number]>();
          let cachedProfile = "";
          let publishedPreamble: string | undefined;
          let cache = new WeakMap<DocumentNode, Measurement>();
          let frozenHeights = new WeakMap<object, number>();
          let frozenUnits = new WeakMap<PagedUnit, PagedUnit>();
          const stableUnit = (unit: PagedUnit) => {
            const height = frozenHeights.get(unit.key);
            if (height === undefined || !unit.shrink) return unit;
            let stable = frozenUnits.get(unit);
            if (!stable) frozenUnits.set(unit, (stable = { ...unit, height, shrink: 0 }));
            return stable;
          };
          const adjusted = new WeakMap<PagedUnit, Map<string, PagedUnit>>();
          const transitions = new WeakMap<HTMLElement, { start: PagedUnit; end: PagedUnit }>();
          const layer = document.createElement("div");
          const sheetsByPage = new Map<number, { element: HTMLElement; signature: string }>();
          layer.className = "scient-latex-page-sheets";
          layer.setAttribute("aria-hidden", "true");
          const dirty = new WeakSet<DocumentNode>();
          let visibilityChangedFrom = Infinity;
          let visibilityRevision = 0;
          const measurementContexts = new WeakMap<
            DocumentNode,
            { previous: WeakRef<DocumentNode> | "block" | null; layout: unknown }
          >();
          let measuredElements = new WeakMap<
            HTMLElement,
            { node: DocumentNode; measurement: Measurement; layout: unknown; previous: unknown }
          >();
          const schedule = (cancel = true) => {
            progress.pending = true;
            if (!cancel && running) {
              refresh = true;
              return;
            }
            refresh = false;
            epoch++;
            if (!frame && !disposed) frame = requestAnimationFrame(start);
          };
          const invalidate = (event: Event) => {
            const element = event.target instanceof Element ? event.target : null;
            if (element)
              try {
                const at = view.posAtDOM(element, 0);
                const resolved = view.state.doc.resolve(at);
                const root = resolved.depth ? resolved.node(1) : view.state.doc.nodeAt(at);
                const node =
                  root?.attrs.layout?.kind === "sourceColumns"
                    ? resolved.depth > 1
                      ? resolved.node(2)
                      : (resolved.nodeAfter ?? root)
                    : root;
                if (node) dirty.add(node);
              } catch {
                /* Replaced node views no longer own a measurement. */
              }
            // Preview completions share a follow-up pass; source/configuration edits cancel immediately.
            schedule(false);
          };
          const gaps = (unit: PagedUnit, gap: number, gapShrink = unit.gapShrink ?? 0) => {
            if (unit.gap === gap && (unit.gapShrink ?? 0) === gapShrink) return unit;
            let values = adjusted.get(unit);
            if (!values) adjusted.set(unit, (values = new Map()));
            const key = `${gap}:${gapShrink}`;
            let result = values.get(key);
            if (!result) values.set(key, (result = { ...unit, gap, gapShrink }));
            return result;
          };
          function* work(doc: DocumentNode, generation: number): Generator<void, void> {
            const paper = view.dom.closest<HTMLElement>(".scient-latex-visual-paper");
            if (!paper) return;
            const setup = source();
            const profile = latexVisualLayoutProfile(setup);
            const context = JSON.stringify(profile);
            if (context !== cachedProfile) {
              resetNaturalMeasurement(view);
              cachedProfile = context;
              cache = new WeakMap();
              measuredElements = new WeakMap();
              frozenHeights = new WeakMap();
              frozenUnits = new WeakMap();
              previousPlan = undefined;
            }
            const dimensions = {
              height: profile.paperHeightIn * 96,
              gap: 24,
              top: profile.marginTopIn * 96,
              bottom: profile.marginBottomIn * 96,
            };
            const entries: Entry[] = [];
            // A changed natural height moves later DOM siblings even across an
            // unchanged planned page break. Their spacers must be republished.
            let flowChangedFrom = visibilityChangedFrom;
            const visibilityAtStart = visibilityRevision;
            const flowChanged = (position: number) => {
              flowChangedFrom = Math.min(flowChangedFrom, position);
              visibilityChangedFrom = Math.min(visibilityChangedFrom, position);
            };
            const regions: Region[] = [];
            const seenNodes = new Set<DocumentNode>();
            const duplicateNodes = new Set<DocumentNode>();
            const remember = (node: DocumentNode) => {
              if (seenNodes.has(node)) duplicateNodes.add(node);
              else seenNodes.add(node);
            };
            doc.forEach((node) => {
              remember(node);
              if (node.attrs.layout?.kind === "sourceColumns") node.forEach(remember);
            });
            // Index the mounted top-level descriptions once; repeated nodeDOM lookups
            // search the sibling list from its beginning for every source block.
            const elements = new Map<DocumentNode, HTMLElement>();
            interface MountedDescription {
              node?: DocumentNode;
              nodeDOM?: globalThis.Node;
              children?: readonly MountedDescription[];
            }
            const indexElements = (descriptions: readonly MountedDescription[]) => {
              for (const description of descriptions) {
                const node = description.node;
                if (node && description.nodeDOM instanceof HTMLElement && !duplicateNodes.has(node))
                  elements.set(node, description.nodeDOM);
                if (!node || node.attrs.layout?.kind === "sourceColumns")
                  indexElements(description.children ?? []);
              }
            };
            indexElements(
              (view as EditorView & { docView?: MountedDescription }).docView?.children ?? [],
            );
            const elementAt = (node: DocumentNode, position: number) => {
              const cached = elements.get(node);
              if (cached) return cached;
              const element = view.nodeDOM(position);
              if (!(element instanceof HTMLElement)) return null;
              return element;
            };
            const add = (
              node: DocumentNode,
              position: number,
              region: Region | undefined,
              previous: DocumentNode | null,
            ) => {
              const element = elementAt(node, position);
              if (!(element instanceof HTMLElement)) return;
              const before = measurementContexts.get(node);
              const layout = region?.node.attrs.layout ?? null;
              const previousContext =
                previous === null ? null : previous.type.name === "heading" ? previous : "block";
              const sameContext =
                !!before &&
                before.layout === layout &&
                (previousContext === null || previousContext === "block"
                  ? before.previous === previousContext
                  : before.previous !== "block" && before.previous?.deref() === previousContext);
              let measurement =
                !sameContext ||
                duplicateNodes.has(node) ||
                dirty.has(node) ||
                (region && dirty.has(region.node))
                  ? undefined
                  : cache.get(node);
              if (!measurement) {
                measurement = measured(
                  view,
                  { node, position, element, region },
                  dimensions.height - dimensions.top - dimensions.bottom,
                );
                const prior = measuredElements.get(element);
                if (
                  !prior ||
                  Math.abs(prior.measurement.height - measurement.height) > 0.5 ||
                  prior.measurement.marginTop !== measurement.marginTop ||
                  prior.measurement.marginBottom !== measurement.marginBottom
                )
                  flowChanged(position);
                // Typing within an existing line changes source offsets, but
                // not its flow unit. Keep that identity so the incremental
                // planner and the presentation can both reuse the line.
                if (
                  node.type.name === "paragraph" &&
                  prior?.node.sameMarkup(node) &&
                  prior.layout === layout &&
                  prior.previous === previousContext &&
                  prior.measurement.wordSpacing === measurement.wordSpacing &&
                  prior.measurement.parts.length === measurement.parts.length
                ) {
                  measurement = {
                    ...measurement,
                    parts: measurement.parts.map((part, index) => {
                      const before = prior.measurement.parts[index]!;
                      return Object.entries(part.unit).every(
                        ([key, value]) =>
                          key === "key" || before.unit[key as keyof PagedUnit] === value,
                      )
                        ? { ...part, unit: before.unit }
                        : part;
                    }),
                  };
                }
                measuredElements.set(element, {
                  node,
                  measurement,
                  layout,
                  previous: previousContext,
                });
                cache.set(node, measurement);
                // A restarted batch can reuse this fresh measurement immediately.
                dirty.delete(node);
                measurementContexts.set(node, {
                  previous:
                    previousContext === null || previousContext === "block"
                      ? previousContext
                      : new WeakRef(previousContext),
                  layout,
                });
              }
              entries.push({ node, position, element, measurement, region });
            };
            let offset = 0;
            let previousNode: DocumentNode | null = null;
            let deadline = performance.now() + 6;
            const collectEntry = function* (
              node: DocumentNode,
              position: number,
              previousNode: DocumentNode | null,
            ): Generator<void> {
              if (node.attrs.layout?.kind === "contentGroup") {
                let childPosition = position + 1;
                let preceding = previousNode;
                for (const child of node.content.content) {
                  yield* collectEntry(child, childPosition, preceding);
                  childPosition += child.nodeSize;
                  preceding = child;
                }
                return;
              }
              if (node.attrs.layout?.kind === "sourceColumns") {
                const element = elementAt(node, position);
                if (!(element instanceof HTMLElement)) return;
                const region = { node, position, element };
                if (dirty.has(node)) {
                  node.forEach((child) => cache.delete(child));
                  dirty.delete(node);
                }
                regions.push(region);
                let childOffset = position + 1;
                let previousChild: DocumentNode | null = null;
                for (const child of node.content.content) {
                  add(child, childOffset, region, previousChild);
                  childOffset += child.nodeSize;
                  previousChild = child;
                  if (performance.now() > deadline) {
                    yield;
                    deadline = performance.now() + 6;
                  }
                }
              } else add(node, position, undefined, previousNode);
              if (performance.now() > deadline) {
                yield;
                deadline = performance.now() + 6;
              }
            };
            for (const node of doc.content.content) {
              yield* collectEntry(node, offset, previousNode);
              offset += node.nodeSize;
              previousNode = node;
            }
            const units: PagedUnit[] = [];
            const owners: ({ entry: Entry; part: Part } | null)[] = [];
            let currentRegion: Region | undefined;
            let previousMargin = 0;
            let previousEntry: Entry | undefined;
            const shortDisplays = new Set<Entry>();
            const boundary = (region: Region, end: boolean) => {
              let pair = transitions.get(region.element);
              if (!pair)
                transitions.set(
                  region.element,
                  (pair = {
                    start: { key: {}, height: 0, gap: 0, columns: 2 },
                    end: { key: {}, height: 0, gap: 0, columns: 1 },
                  }),
                );
              units.push(end ? pair.end : pair.start);
              owners.push(null);
            };
            for (const entry of entries) {
              if (entry.region !== currentRegion) {
                if (currentRegion) boundary(currentRegion, true);
                currentRegion = entry.region;
                if (currentRegion) boundary(currentRegion, false);
                previousMargin = 0;
                previousEntry = undefined;
              }
              const display = entry.node.type.name === "latexDisplayMath";
              const font = display ? parseFloat(getComputedStyle(entry.element).fontSize) : 0;
              const short =
                display &&
                previousEntry?.node.type.name === "paragraph" &&
                previousEntry.measurement.lastLineEnd !== undefined &&
                previousEntry.measurement.lastLineEnd + 2 * font <
                  (entry.measurement.displayIndent ?? 0);
              if (short) shortDisplays.add(entry);
              if (display && entry.element.hasAttribute("data-short-display") !== short)
                flowChanged(entry.position);
              const precedingMath = previousEntry?.node.type.name === "latexDisplayMath";
              const gap = Math.max(
                display && !precedingMath ? 0 : previousMargin,
                display && short ? 0 : entry.measurement.marginTop,
              );
              const elasticGap =
                display || (precedingMath && previousMargin >= entry.measurement.marginTop);
              const shrinkPoints = precedingMath && shortDisplays.has(previousEntry!) ? 3 : 6;
              entry.measurement.parts.forEach((part, index) => {
                units.push(
                  index === 0
                    ? gaps(
                        stableUnit(part.unit),
                        gap,
                        elasticGap ? Math.min(gap, (shrinkPoints * 96) / 72.27) : 0,
                      )
                    : stableUnit(part.unit),
                );
                owners.push({ entry, part });
              });
              previousMargin = short ? font * 0.6 : entry.measurement.marginBottom;
              previousEntry = entry;
            }
            if (currentRegion) boundary(currentRegion, true);
            const notes: { row: HTMLElement; band: HTMLElement; height: number; index: number }[] =
              [];
            for (const band of view.dom.querySelectorAll<
              HTMLElement & { scientFootnoteEnd?: number }
            >(".scient-latex-footnotes")) {
              const end = band.scientFootnoteEnd;
              if (end === undefined || end > doc.content.size) continue;
              const block = doc.resolve(end).nodeBefore;
              if (!block) continue;
              const markers = latexBlockFootnotes(view.state, end - block.nodeSize, end);
              const rows = [...band.querySelectorAll<HTMLElement>(".scient-latex-footnote")];
              markers.forEach((position, marker) => {
                const row = rows[marker];
                if (!row) return;
                const index = owners.findIndex(
                  (owned) =>
                    owned &&
                    position >= owned.entry.position + owned.part.from &&
                    position < owned.entry.position + owned.part.to,
                );
                if (index < 0) return;
                const height =
                  row.offsetHeight + (band.hasAttribute("data-paged-footnote-band") ? 0 : 8);
                const base = units[index]!;
                units[index] = gaps(
                  { ...base, noteHeight: (base.noteHeight ?? 0) + height },
                  base.gap,
                );
                notes.push({ row, band, height, index });
              });
            }
            const virtualPlan = yield* planPagedFlow(units, dimensions, previousPlan);
            const landscape = new Set<number>();
            owners.forEach((owner, index) => {
              if (owner?.entry.node.attrs.layout?.kind === "landscape")
                landscape.add(virtualPlan.placements[index]!.page);
            });
            const settings = documentLayoutSettings(setup);
            const numbering = pagedPageNumbering(
              virtualPlan.pages,
              settings.pageNumbering,
              owners.flatMap((owner, index) =>
                owner?.entry.node.attrs.kind === "documentCommand"
                  ? [
                      {
                        page: virtualPlan.placements[index]!.page,
                        name: String(owner.entry.node.attrs.environment),
                        value: String(owner.entry.node.attrs.body),
                      },
                    ]
                  : [],
              ),
            );
            const plan = {
              ...presentPagedSheets(virtualPlan, profile.paperWidthIn * 96, landscape),
              labels: numbering.labels,
              numbers: numbering.numbers,
            };
            if (generation !== epoch || view.state.doc !== doc) return;
            const presentation = latexPagedKey.getState(view.state);
            if (
              previousPlan &&
              flowChangedFrom === Infinity &&
              publishedPreamble === setup.slice(0, latexPreambleEnd(setup)) &&
              units.length === previousPlan.units.length &&
              units.every((unit, index) => unit === previousPlan!.units[index])
            ) {
              let partIndex = 0;
              const unchanged = owners.every((owner, index) => {
                if (!owner) return true;
                const part = presentation?.geometry[partIndex++];
                const placement = plan.placements[index]!;
                return (
                  part?.from === owner.entry.position + owner.part.from &&
                  part.to === owner.entry.position + owner.part.to &&
                  part.page === placement.page &&
                  part.column === placement.column &&
                  part.top === placement.top
                );
              });
              if (unchanged && partIndex === presentation?.geometry.length) {
                // Decorations and navigation ranges were mapped by the input
                // transaction. No DOM styles or presentation transaction are
                // needed when every measured line remains in the same place.
                progress.pending = refresh;
                return;
              }
            }
            const decorations: Decoration[] = [];
            const geometry: PageGeometry[] = [];
            const scale = view.dom.getBoundingClientRect().width / (view.dom.offsetWidth || 1);
            const rootTop = view.dom.getBoundingClientRect().top;
            const offsets = new Map<
              Entry,
              { natural: number; placed: number; column: number; mirror: number; shift: number }
            >();
            const hints = new Map<Entry, { start: number; end: number }>();
            const reusable = new Set<Entry>();
            const previousGeometry = new Set(
              (presentation?.geometry ?? []).map(
                (part) => `${part.from}:${part.to}:${part.page}:${part.column}:${part.top}`,
              ),
            );
            // Offscreen estimates cannot change presentation in an unchanged prefix.
            const indicesByEntry = new Map<Entry, number[]>();
            owners.forEach((owner, index) => {
              if (!owner) return;
              const indices = indicesByEntry.get(owner.entry) ?? [];
              indices.push(index);
              indicesByEntry.set(owner.entry, indices);
            });
            for (const entry of entries) {
              if (entry.region || !previousPlan || entry.position >= flowChangedFrom) continue;
              const indices = indicesByEntry.get(entry) ?? [];
              if (
                indices.every((index) => {
                  const after = plan.placements[index]!;
                  const before = previousPlacements.get(units[index]!.key);
                  const part = owners[index]!.part;
                  return (
                    before?.top === after.top &&
                    before.height === after.height &&
                    before.gap === after.gap &&
                    before.page === after.page &&
                    before.column === after.column &&
                    previousGeometry.has(
                      `${entry.position + part.from}:${entry.position + part.to}:${after.page}:${after.column}:${after.top}`,
                    )
                  );
                })
              )
                reusable.add(entry);
            }
            const previousDecorations = latexPagedKey.getState(view.state)?.decorations;
            const fragments = new Map<Entry, Set<string>>();
            plan.placements.forEach((placement, index) => {
              const entry = owners[index]?.entry;
              if (entry?.region) {
                const locations = fragments.get(entry) ?? new Set<string>();
                locations.add(`${placement.page}:${placement.column}`);
                fragments.set(entry, locations);
              }
              if (!entry || entry.region) return;
              const hint = hints.get(entry) ?? { start: placement.top, end: placement.top };
              hint.end = Math.max(hint.end, placement.top + placement.height);
              hints.set(entry, hint);
            });
            const regionBounds = new Map<Region, { start: number; end: number }>();
            const passiveGaps = new Map<Entry, { boundary: PassiveBoundary; height: number }[]>();
            const tableBreaks = new Map<Entry, { row: number; height: number }[]>();
            const tableOffsets = new Map<Entry, { row: number; left: number }[]>();
            let displacement = 0;
            const insertGap = (position: number, offset: number, height: number) => {
              decorations.push(
                Decoration.widget(
                  position,
                  () => {
                    const gap = document.createElement("span");
                    gap.className = "scient-latex-pagination-gap";
                    gap.style.height = `${height}px`;
                    gap.dataset.position = String(offset);
                    gap.contentEditable = "false";
                    gap.setAttribute("aria-hidden", "true");
                    return gap;
                  },
                  {
                    side: -1,
                    key: `page-gap:${position}:${height}`,
                    pagedHeight: height,
                    ignoreSelection: true,
                  },
                ),
              );
              displacement += height;
            };
            const oldGaps = (latexPagedKey.getState(view.state)?.decorations.find() ?? [])
              .filter((decoration) => typeof decoration.spec.pagedHeight === "number")
              .sort((a, b) => a.from - b.from);
            const gapsByEntry = new Map<Entry, { internal: number; total: number }>();
            let entryIndex = 0;
            for (const gap of oldGaps) {
              while (
                entryIndex < entries.length &&
                gap.from >= entries[entryIndex]!.position + entries[entryIndex]!.node.nodeSize
              )
                entryIndex++;
              const entry = entries[entryIndex];
              if (!entry || gap.from < entry.position) continue;
              const heights = gapsByEntry.get(entry) ?? { internal: 0, total: 0 };
              const height = Number(gap.spec.pagedHeight);
              heights.total += height;
              if (gap.from > entry.position) heights.internal += height;
              gapsByEntry.set(entry, heights);
            }
            // Offscreen blocks retain their model and exact height while the browser skips their ink.
            // Natural measurements supply the height; old internal gaps remain until publication.
            const repeatedHeights = new Map<Entry, number>();
            for (const entry of entries)
              repeatedHeights.set(
                entry,
                [...entry.element.querySelectorAll<HTMLElement>("[data-paged-repeat]")].reduce(
                  (sum, row) => sum + row.offsetHeight,
                  0,
                ),
              );
            const measurementObserver = (
              view as EditorView & { domObserver: { stop(): void; start(): void } }
            ).domObserver;
            measurementObserver.stop();
            try {
              for (const entry of entries) {
                if (entry.region || reusable.has(entry)) continue;
                // Read origins with the margins this publication will actually paint.
                // Toggling short-display glue after measuring shifts the whole suffix.
                if (shortDisplays.has(entry))
                  entry.element.setAttribute("data-short-display", "true");
                else entry.element.removeAttribute("data-short-display");
                const internal = gapsByEntry.get(entry)?.internal ?? 0;
                const shrink =
                  2 *
                  (parseFloat(
                    entry.element.style.getPropertyValue("--scient-paged-display-shrink"),
                  ) || 0);
                const repeated = repeatedHeights.get(entry) ?? 0;
                const value = `auto ${Math.max(0, entry.measurement.height + internal + repeated - shrink)}px`;
                if (entry.element.style.containIntrinsicBlockSize !== value)
                  entry.element.style.containIntrinsicBlockSize = value;
              }
            } finally {
              measurementObserver.start();
            }
            let oldGapIndex = 0,
              oldGapHeight = 0,
              oldTableHeight = 0,
              oldCompressedHeight = 0,
              regionDelta = 0;
            let lastEntry: Entry | undefined;
            for (let index = 0; index < plan.placements.length; index++) {
              if (performance.now() > deadline) {
                yield;
                deadline = performance.now() + 6;
              }
              const owned = owners[index];
              if (!owned?.entry.region) continue;
              const placement = plan.placements[index]!;
              const region = owned.entry.region;
              const bounds = regionBounds.get(region) ?? {
                start: placement.top,
                end: placement.top,
              };
              bounds.end = Math.max(bounds.end, placement.top + placement.height);
              regionBounds.set(region, bounds);
            }
            const width =
              (profile.paperWidthIn - profile.marginLeftIn - profile.marginRightIn) *
              CSS_PIXELS_PER_INCH;
            const columnGap = (profile.columnGapPt * 96) / 72.27;
            const columnStep = (width + columnGap) / 2;
            const mirrorAt = (page: number) =>
              profile.twoSided && page % 2 === 1
                ? (profile.marginRightIn - profile.marginLeftIn) * 96
                : 0;
            for (let index = 0; index < plan.placements.length; index++) {
              if (performance.now() > deadline) {
                yield;
                deadline = performance.now() + 6;
              }
              const owned = owners[index];
              if (!owned) continue;
              const { entry, part } = owned;
              const placement = plan.placements[index]!;
              let origin = offsets.get(entry);
              if (!origin) {
                if (lastEntry) {
                  oldCompressedHeight +=
                    2 *
                    (parseFloat(
                      lastEntry.element.style.getPropertyValue("--scient-paged-display-shrink"),
                    ) || 0);
                  oldTableHeight += repeatedHeights.get(lastEntry) ?? 0;
                  if (lastEntry.region && lastEntry.region !== entry.region) {
                    const previousBounds = regionBounds.get(lastEntry.region)!;
                    const body = lastEntry.region.element.querySelector<HTMLElement>(
                      ".scient-latex-content-layout-body > div",
                    );
                    if (body)
                      regionDelta += previousBounds.end - previousBounds.start - body.offsetHeight;
                  }
                }
                lastEntry = entry;
                while (oldGapIndex < oldGaps.length && oldGaps[oldGapIndex]!.from <= entry.position)
                  oldGapHeight += Number(oldGaps[oldGapIndex++]!.spec.pagedHeight);
                const natural = reusable.has(entry)
                  ? 0
                  : (entry.element.getBoundingClientRect().top - rootTop) / scale -
                    oldGapHeight -
                    oldTableHeight +
                    oldCompressedHeight +
                    regionDelta -
                    (parseFloat(
                      entry.element.style.getPropertyValue("--scient-paged-flow-offset"),
                    ) || 0);
                origin = {
                  natural,
                  placed: placement.top,
                  column: placement.column,
                  mirror: mirrorAt(placement.page),
                  shift: 0,
                };
                offsets.set(entry, origin);
                if (reusable.has(entry)) {
                  decorations.push(
                    ...(previousDecorations
                      ?.find(entry.position, entry.position + entry.node.nodeSize)
                      .filter(
                        (decoration) =>
                          decoration.from >= entry.position &&
                          decoration.from < entry.position + entry.node.nodeSize,
                      ) ?? []),
                  );
                }
                if (shortDisplays.has(entry) && !reusable.has(entry))
                  decorations.push(
                    Decoration.node(entry.position, entry.position + entry.node.nodeSize, {
                      "data-short-display": "true",
                    }),
                  );
                if (!reusable.has(entry))
                  for (const math of entry.measurement.nestedDisplays ?? [])
                    decorations.push(
                      Decoration.node(entry.position + math.from, entry.position + math.to, {
                        "data-short-display": "true",
                      }),
                    );
                const compressed = part.unit.height - placement.height;
                if (compressed > 0.01 && !reusable.has(entry))
                  decorations.push(
                    Decoration.node(entry.position, entry.position + entry.node.nodeSize, {
                      style: `--scient-paged-display-shrink:${compressed / 2}px;`,
                    }),
                  );
                if (entry.measurement.wordSpacing !== undefined && !reusable.has(entry))
                  decorations.push(
                    Decoration.node(entry.position, entry.position + entry.node.nodeSize, {
                      "data-paged-glue": "",
                      style: `word-spacing:${entry.measurement.wordSpacing}px;`,
                    }),
                  );
                if (entry.region) {
                  const bounds = regionBounds.get(entry.region) ?? {
                    start: placement.top,
                    end: placement.top,
                  };
                  regionBounds.set(entry.region, bounds);
                  decorations.push(
                    Decoration.node(entry.position, entry.position + entry.node.nodeSize, {
                      class: `scient-paged-part${(fragments.get(entry)?.size ?? 0) > 1 ? " scient-paged-fragmented" : ""}`,
                      style: `--scient-paged-top:${placement.top - bounds.start}px;--scient-paged-left:${placement.column * columnStep + origin.mirror}px;contain-intrinsic-block-size:${entry.measurement.height}px;`,
                    }),
                  );
                } else if (origin.mirror && !reusable.has(entry))
                  decorations.push(
                    Decoration.node(entry.position, entry.position + entry.node.nodeSize, {
                      style: `position:relative;left:${origin.mirror}px;`,
                    }),
                  );
              }
              const from = entry.position + part.from,
                to = entry.position + part.to;
              geometry.push({
                page: placement.page,
                column: placement.column,
                from,
                to,
                top: placement.top,
              });
              if (reusable.has(entry)) {
                if (part === entry.measurement.parts[0])
                  displacement +=
                    (gapsByEntry.get(entry)?.total ?? 0) + (repeatedHeights.get(entry) ?? 0);
                displacement -= Math.max(0, part.unit.height - placement.height);
                continue;
              }
              if (entry.region) {
                const bounds = regionBounds.get(entry.region)!;
                bounds.end = Math.max(bounds.end, placement.top + placement.height);
                const shift = placement.top - origin.placed - part.naturalTop;
                const left =
                  (placement.column - origin.column) * columnStep +
                  mirrorAt(placement.page) -
                  origin.mirror;
                if (
                  part.row === undefined &&
                  (Math.abs(shift) > 0.1 || left) &&
                  from < to &&
                  entry.node.isTextblock
                )
                  decorations.push(
                    Decoration.inline(from, to, {
                      class: "scient-paged-line",
                      style: `position:relative;top:${shift}px;left:${left}px;`,
                    }),
                  );
              } else {
                const left = mirrorAt(placement.page) - origin.mirror;
                if (left && entry.node.isTextblock && from < to)
                  decorations.push(
                    Decoration.inline(from, to, { style: `position:relative;left:${left}px;` }),
                  );
                // Existing gaps already contribute to DOM positions; subtract them before adding a replacement.
                const naturalTop = origin.natural + part.naturalTop;
                const gapHeight = placement.top - naturalTop - displacement - origin.shift;
                if (gapHeight < -1 && part === entry.measurement.parts[0]) {
                  // Negative empty-block margins collapse with authored display/heading
                  // skips. Move this block's ink instead, leaving browser flow measurable.
                  origin.shift = gapHeight;
                  decorations.push(
                    Decoration.node(entry.position, entry.position + entry.node.nodeSize, {
                      style: `position:relative;top:${gapHeight}px;--scient-paged-flow-offset:${gapHeight}px;`,
                    }),
                  );
                } else if (gapHeight > 1 && part === entry.measurement.parts[0]) {
                  // Space before an entire table belongs outside its caption and
                  // original header; it must not create continuation furniture.
                  insertGap(entry.position, part.from, gapHeight);
                } else if (part.passive && part !== entry.measurement.parts[0] && gapHeight > 1) {
                  const gaps = passiveGaps.get(entry) ?? [];
                  gaps.push({ boundary: part.passive, height: gapHeight });
                  passiveGaps.set(entry, gaps);
                  displacement += gapHeight;
                } else if (part.row !== undefined) {
                  const offsets = tableOffsets.get(entry) ?? [];
                  offsets.push({ row: part.row, left });
                  tableOffsets.set(entry, offsets);
                  if (gapHeight > 1 && placement.continued) {
                    const breaks = tableBreaks.get(entry) ?? [];
                    breaks.push({
                      row: part.row,
                      height: Math.max(
                        0,
                        gapHeight -
                          (part.unit.continuationHead ?? 0) -
                          (part.unit.continuationFoot ?? 0),
                      ),
                    });
                    tableBreaks.set(entry, breaks);
                    displacement += gapHeight;
                  }
                } else if (gapHeight > 1) {
                  const position = part === entry.measurement.parts[0] ? entry.position : from;
                  insertGap(position, part.from, gapHeight);
                }
                displacement -= Math.max(0, part.unit.height - placement.height);
              }
            }
            for (const region of regions) {
              const bounds = regionBounds.get(region);
              if (bounds)
                decorations.push(
                  Decoration.node(region.position, region.position + region.node.nodeSize, {
                    "data-paged-region": "",
                    style: `--scient-paged-region-height:${bounds.end - bounds.start}px;`,
                  }),
                );
            }
            const revision = (latexPagedKey.getState(view.state)?.revision ?? 0) + 1;
            view.dispatch(
              view.state.tr
                .setMeta(latexPagedKey, {
                  decorations: DecorationSet.create(doc, decorations),
                  plan,
                  geometry,
                  revision,
                } satisfies Presentation)
                .setMeta("addToHistory", false),
            );
            plan.units.forEach((unit, index) => {
              if (unit.shrink) frozenHeights.set(unit.key, plan.placements[index]!.height);
            });
            previousPlacements = new WeakMap();
            plan.units.forEach((unit, index) =>
              previousPlacements.set(unit.key, plan.placements[index]!),
            );
            previousPlan = {
              ...virtualPlan,
              units: virtualPlan.units.map(stableUnit),
              placements: virtualPlan.placements.map((part) => ({
                ...part,
                after: { ...part.after, elastic: false },
              })),
            };
            publishedPreamble = setup.slice(0, latexPreambleEnd(setup));
            // The generated note rows keep their original return-to-marker handlers.
            const noteGroups = new Map<string, typeof notes>();
            for (const note of notes) {
              const placement = plan.placements[note.index]!;
              const groupKey = `${placement.page}:${placement.column}`;
              const group = noteGroups.get(groupKey) ?? [];
              group.push(note);
              noteGroups.set(groupKey, group);
            }
            const observer = (view as EditorView & { domObserver: { stop(): void; start(): void } })
              .domObserver;
            observer.stop();
            try {
              for (const entry of entries)
                if (!reusable.has(entry)) {
                  const byOwner = new Map<
                    number,
                    { boundary: PassiveBoundary; height: number }[]
                  >();
                  for (const gap of passiveGaps.get(entry) ?? []) {
                    const group = byOwner.get(gap.boundary.owner) ?? [];
                    group.push(gap);
                    byOwner.set(gap.boundary.owner, group);
                  }
                  entry.node.descendants((child, offset) => {
                    if (child.attrs.name !== "proseMacro") return;
                    const owner = entry.position + 1 + offset,
                      element = view.nodeDOM(owner);
                    if (element instanceof HTMLElement)
                      applyPassivePageGaps(element, byOwner.get(owner) ?? []);
                  });
                  if (entry.node.attrs.kind === "toc")
                    applyPassivePageGaps(entry.element, byOwner.get(entry.position) ?? []);
                }
              for (const region of regions) {
                const bounds = regionBounds.get(region);
                const body = region.element.querySelector<HTMLElement>(
                  ".scient-latex-content-layout-body > div,.scient-latex-page-layout-body > div",
                );
                if (bounds && body) body.style.height = `${bounds.end - bounds.start}px`;
              }
              // Height hints need no model decoration. Root node decorations make
              // ProseMirror scan every sibling's styles for each child during typing.
              for (const entry of entries) {
                const hint = hints.get(entry);
                if (!hint || reusable.has(entry)) continue;
                // Keep the browser's last rendered height. A fixed estimate can
                // move the entire suffix when a previously seen block is skipped.
                const value = `auto ${Math.max(0, hint.end - hint.start)}px`;
                if (entry.element.style.containIntrinsicBlockSize !== value)
                  entry.element.style.containIntrinsicBlockSize = value;
              }
              for (const group of noteGroups.values()) {
                const placement = plan.placements[group[0]!.index]!;
                let top =
                  plan.sheets![placement.page]!.top +
                  plan.sheets![placement.page]!.height -
                  dimensions.bottom -
                  group.reduce((sum, note) => sum + note.height, 0);
                group.forEach((note, index) => {
                  const columns = owners[note.index]?.entry.region ? 2 : 1;
                  note.band.dataset.pagedFootnoteBand = "true";
                  Object.assign(note.band.style, {
                    position: "absolute",
                    top: "0",
                    left: `${profile.marginLeftIn * 96}px`,
                    width: `${width}px`,
                  });
                  Object.assign(note.row.style, {
                    position: "absolute",
                    top: `${top}px`,
                    left: `${placement.column * columnStep + mirrorAt(placement.page)}px`,
                    width: `${columns === 2 ? (width - columnGap) / 2 : width}px`,
                    boxSizing: "border-box",
                    paddingTop: "8px",
                  });
                  note.row.toggleAttribute("data-paged-note-rule", index === 0);
                  top += note.height;
                });
              }
              // Write all note positions before asking for their resulting sizes.
              if (notes.some((note) => Math.abs(note.row.offsetHeight - note.height) > 1))
                schedule();
            } finally {
              observer.start();
            }
            for (const entry of entries)
              if (!reusable.has(entry) && entry.element.querySelector("tr[data-latex-table-row]"))
                entry.element.dispatchEvent(
                  new CustomEvent("scient-latex-pagination-table", {
                    bubbles: true,
                    detail: {
                      breaks: tableBreaks.get(entry) ?? [],
                      offsets: tableOffsets.get(entry) ?? [],
                    },
                  }),
                );
            if (layer.parentElement !== paper) paper.prepend(layer);
            paper.dataset.paged = "true";
            paper.style.setProperty(
              "--scient-paged-height",
              `${plan.sheets!.at(-1)!.top + plan.sheets!.at(-1)!.height}px`,
            );
            const running = latexRunningPageStyle(setup);
            const references = latexEquationReferencesKey.getState(view.state);
            const headings = (references?.contents ?? []).map((heading) => ({
              ...heading,
              page: geometry.find((part) => part.from >= heading.position)?.page ?? 0,
            }));
            let headingIndex = 0,
              left = "",
              right = "";
            const sheets: HTMLElement[] = [];
            for (let page = 0; page < plan.pages; page++) {
              while (headingIndex < headings.length && headings[headingIndex]!.page <= page) {
                const heading = headings[headingIndex++]!;
                if (heading.level === 0) left = heading.title;
                if (heading.level === 1) right = heading.title;
              }
              const firstStyle =
                settings.firstPageStyle === "same" ? running.style : settings.firstPageStyle;
              const titlePage = owners.some(
                (owner, index) =>
                  owner?.entry.node.attrs.layout?.kind === "titlepage" &&
                  plan.placements[index]?.page === page,
              );
              const style =
                numbering.styles.get(page) ??
                (titlePage
                  ? "empty"
                  : page === 0 && firstStyle !== "default"
                    ? firstStyle
                    : page === 0 && doc.firstChild?.attrs.kind === "title"
                      ? "plain"
                      : running.style);
              const fields = latexRunningPageFields(
                { ...running, style },
                plan.numbers[page]!,
                left,
                right,
                page === 0 && references?.titlePage ? null : plan.labels[page]!,
              );
              const physicalPage = plan.sheets![page]!;
              const pageOrigin = physicalPage.top;
              const separators =
                profile.columnRulePt > 0
                  ? regions.flatMap((region) => {
                      const bounds = regionBounds.get(region);
                      if (!bounds) return [];
                      const top = Math.max(dimensions.top, bounds.start - pageOrigin);
                      const bottom = Math.min(
                        physicalPage.height - dimensions.bottom,
                        bounds.end - pageOrigin,
                      );
                      return bottom > top ? [{ top, bottom }] : [];
                    })
                  : [];
              const signature = JSON.stringify([
                fields,
                separators,
                context,
                style,
                running.headHeightIn,
                running.headSepIn,
                running.footSkipIn,
                running.headRulePt,
                running.footRulePt,
                physicalPage,
                dimensions.gap,
                profile.twoSided,
                profile.marginLeftIn,
                profile.marginRightIn,
              ]);
              const cached = sheetsByPage.get(page);
              if (cached?.signature === signature) {
                sheets.push(cached.element);
                continue;
              }
              const sheet = document.createElement("div");
              sheet.className = "scient-latex-page-sheet";
              sheet.style.top = `${physicalPage.top}px`;
              sheet.style.left = `${physicalPage.left}px`;
              sheet.style.width = `${physicalPage.width}px`;
              sheet.style.height = `${physicalPage.height}px`;
              sheet.dataset.orientation = physicalPage.landscape ? "landscape" : "portrait";
              sheet.dataset.page = String(page + 1);
              for (const { top, bottom } of separators) {
                const rule = document.createElement("div");
                rule.className = "scient-latex-column-rule";
                Object.assign(rule.style, {
                  position: "absolute",
                  top: `${top}px`,
                  height: `${bottom - top}px`,
                  width: `${(profile.columnRulePt * 96) / 72.27}px`,
                  left: `${profile.marginLeftIn * 96 + mirrorAt(page) + width / 2}px`,
                  background: "currentColor",
                });
                sheet.append(rule);
              }
              for (const [kind, values] of [
                ["header", fields.head],
                ["footer", fields.foot],
              ] as const) {
                const band = document.createElement("div");
                band.className = `scient-latex-running-${kind}`;
                band.style.fontSize = `${(profile.fontSizePt * 96) / 72.27}px`;
                if (kind === "header") {
                  band.style.top = `${Math.max(0, dimensions.top - (running.headHeightIn + running.headSepIn) * 96)}px`;
                  if (style === "fancy" && running.headRulePt > 0)
                    band.style.borderBottom = `${(running.headRulePt * 96) / 72.27}px solid currentColor`;
                } else {
                  band.style.top = `${physicalPage.height - dimensions.bottom + running.footSkipIn * 96 - (profile.fontSizePt * 96) / 72.27}px`;
                  band.style.bottom = "auto";
                  if (style === "fancy" && running.footRulePt > 0)
                    band.style.borderTop = `${(running.footRulePt * 96) / 72.27}px solid currentColor`;
                }
                if (physicalPage.landscape) {
                  const originalTop =
                    kind === "header"
                      ? Math.max(
                          0,
                          dimensions.top - (running.headHeightIn + running.headSepIn) * 96,
                        )
                      : dimensions.height -
                        dimensions.bottom +
                        running.footSkipIn * 96 -
                        (profile.fontSizePt * 96) / 72.27;
                  Object.assign(band.style, {
                    width: `${(profile.paperWidthIn - profile.marginLeftIn - profile.marginRightIn) * 96}px`,
                    left: `${physicalPage.width - originalTop}px`,
                    right: "auto",
                    top: `${profile.marginLeftIn * 96}px`,
                    transform: "rotate(90deg)",
                    transformOrigin: "0 0",
                  });
                }
                if (profile.twoSided && page % 2 === 1 && !physicalPage.landscape) {
                  band.style.left = `${profile.marginRightIn * 96}px`;
                  band.style.right = `${profile.marginLeftIn * 96}px`;
                }
                for (const text of values) {
                  const slot = document.createElement("span");
                  if (!/[\\{}]/u.test(text)) slot.textContent = text;
                  else appendLatexProsePreview(slot, `{${text}}`, undefined, setup);
                  band.append(slot);
                }
                sheet.append(band);
              }
              sheets.push(sheet);
              sheetsByPage.set(page, { element: sheet, signature });
            }
            for (const page of sheetsByPage.keys())
              if (page >= plan.pages) sheetsByPage.delete(page);
            if (
              sheets.length !== layer.children.length ||
              sheets.some((sheet, index) => layer.children[index] !== sheet)
            )
              layer.replaceChildren(...sheets);
            if (generation === epoch && visibilityAtStart === visibilityRevision)
              visibilityChangedFrom = Infinity;
            progress.pending = generation !== epoch || refresh;
            view.dom.dispatchEvent(new CustomEvent("scient-latex-layout", { bubbles: true }));
          }
          function start() {
            frame = 0;
            if (disposed || view.isDestroyed) return;
            if (!fontsReady) return;
            if (view.composing || view.dom.hasAttribute("data-latex-loading")) {
              frame = requestAnimationFrame(start);
              return;
            }
            // Loading mutates the document every frame. Wait before requesting
            // geometry, otherwise the waiting loop lays out each growing slice.
            // Width observation resumes hidden panes and DOM-only tests.
            if (!view.dom.offsetWidth || !view.dom.getBoundingClientRect().width) return;
            const generation = epoch;
            const iterator = work(view.state.doc, generation);
            running = true;
            const resume = () => {
              frame = 0;
              if (disposed || view.isDestroyed) return;
              if (generation !== epoch) {
                iterator.return();
                running = false;
                start();
                return;
              }
              if (!iterator.next().done) frame = requestAnimationFrame(resume);
              else {
                running = false;
                if (refresh) schedule();
              }
            };
            resume();
          }
          view.dom.addEventListener("scient-latex-math-preview", invalidate);
          view.dom.addEventListener("scient-latex-content-resized", invalidate);
          const visibilityChanged = (event: Event) => {
            if ((event as Event & { skipped?: boolean }).skipped !== false) return;
            if (!(event.target instanceof HTMLElement)) return;
            if (event.target.classList.contains("scient-latex-pagination-gap")) return;
            try {
              const at = view.state.doc.resolve(view.posAtDOM(event.target, 0));
              visibilityChangedFrom = Math.min(
                visibilityChangedFrom,
                at.depth ? at.before(1) : at.pos,
              );
              visibilityRevision++;
              // Revealing a skipped block can replace its intrinsic-size estimate.
              // Re-anchor the suffix, retaining cached natural measurements.
              schedule(false);
            } catch {
              /* A replaced view no longer owns a document position. */
            }
          };
          view.dom.addEventListener("contentvisibilityautostatechange", visibilityChanged, true);
          view.dom.addEventListener("load", invalidate, true);
          const configurationChanged = () => {
            resetNaturalMeasurement(view);
            cache = new WeakMap();
            measuredElements = new WeakMap();
            frozenHeights = new WeakMap();
            frozenUnits = new WeakMap();
            schedule();
          };
          document.fonts?.addEventListener("loadingdone", configurationChanged);
          view.dom.addEventListener("scient-latex-layout-config", configurationChanged);
          const stopWidth = observeResize(view.dom, () => {
            const width = view.dom.offsetWidth;
            if (layer.dataset.width === String(width)) return;
            layer.dataset.width = String(width);
            cache = new WeakMap();
            measuredElements = new WeakMap();
            frozenHeights = new WeakMap();
            frozenUnits = new WeakMap();
            resetNaturalMeasurement(view);
            schedule();
          });
          if (!fontsReady)
            Promise.all(mathFonts.map((face) => face.load().catch(() => undefined))).then(() => {
              fontsReady = true;
              if (!disposed) schedule();
            });
          schedule();
          return {
            update(_view, before) {
              if (view.state.doc !== before.doc) schedule();
            },
            destroy() {
              pagedLayoutProgress.delete(view);
              disposed = true;
              epoch++;
              cancelAnimationFrame(frame);
              stopWidth();
              layer.remove();
              resetNaturalMeasurement(view);
              view.dom.removeEventListener("scient-latex-math-preview", invalidate);
              view.dom.removeEventListener("scient-latex-content-resized", invalidate);
              view.dom.removeEventListener(
                "contentvisibilityautostatechange",
                visibilityChanged,
                true,
              );
              view.dom.removeEventListener("load", invalidate, true);
              document.fonts?.removeEventListener("loadingdone", configurationChanged);
              view.dom.removeEventListener("scient-latex-layout-config", configurationChanged);
            },
          };
        },
      }),
    ];
  },
});
