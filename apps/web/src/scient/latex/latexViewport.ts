import { latexReadingCacheBudget, latexReadingContextIdentity } from "./latexReadingCache";
import {
  Extension,
  getRenderedAttributes,
  type NodeViewRenderer,
  type NodeViewRendererProps,
} from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view";
import { scientMarkdownSearchState } from "../markdownEditor/prosemirror/search";
import { afterEditorPaint } from "./afterEditorPaint";
import { mathReadingPreviewReady, hasMathReadingPreview } from "./mathReadingPreview";
import { mathReadingPreparationKeys } from "./mathReadingNodeView";
import { latexReferencePresentation } from "./latexEquationReferences";
import { createLatexViewportRetention } from "./latexViewportRetention";
import { latexReadingViewWeight } from "./latexReadingViewWeight";
import { latexTypographyKey } from "./latexTypography";
import {
  latexReadingFontKey,
  latexReadingFontsReady,
  prepareLatexReadingFonts,
} from "./latexReadingFonts";

export interface ViewportLine {
  readonly position: number;
  readonly top: number;
  readonly bottom: number;
  readonly keepWithNext?: boolean | undefined;
}

export interface ViewportMeasurement {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly ViewportLine[];
  readonly wordSpacing?: number | undefined;
  readonly displayContentHeight?: number | undefined;
  readonly mathKeys?: readonly string[];
  readonly mathFallbacks?: number;
}

interface Unit {
  readonly node: DocumentNode;
  readonly position: number;
}

interface ViewportState {
  readonly enabled: boolean;
  readonly opening: boolean;
  readonly visible: ReadonlySet<DocumentNode>;
  readonly warm: ReadonlySet<DocumentNode>;
  readonly preparing: ReadonlySet<DocumentNode>;
  readonly pinned: ReadonlySet<DocumentNode>;
  readonly presented: ReadonlySet<DocumentNode>;
  readonly pageDemand: ReadonlySet<DocumentNode>;
  readonly fallback: ReadonlySet<DocumentNode>;
  readonly print: boolean;
  readonly revision: number;
  readonly pending: number;
  readonly geometryRevisions: ReadonlyMap<DocumentNode, number>;
}

interface ViewportUpdate {
  readonly opening?: boolean;
  readonly visible?: ReadonlySet<DocumentNode>;
  readonly warm?: ReadonlySet<DocumentNode>;
  readonly preparing?: ReadonlySet<DocumentNode>;
  readonly pinned?: ReadonlySet<DocumentNode>;
  readonly presented?: ReadonlySet<DocumentNode>;
  readonly pageDemand?: ReadonlySet<DocumentNode>;
  readonly fallback?: ReadonlySet<DocumentNode>;
  readonly print?: boolean;
  readonly refresh?: boolean;
  readonly pending?: number;
  readonly refreshNodes?: ReadonlySet<DocumentNode>;
}

const key = new PluginKey<ViewportState>("scientLatexViewport");
const units = new WeakMap<DocumentNode, readonly Unit[]>();
const unitPositions = new WeakMap<DocumentNode, ReadonlyMap<number, DocumentNode>>();
const signatures = new WeakMap<DocumentNode, string>();
const readingSignatures = new WeakMap<DocumentNode, string>();
const measurements = new WeakMap<DocumentNode, Map<string, ViewportMeasurement>>();
const retained = latexReadingCacheBudget.cache<ViewportMeasurement>("geometry");

interface Member {
  readonly dom: HTMLElement;
  readonly node: () => DocumentNode;
  readonly position: () => number | undefined;
  readonly mounted: boolean;
}

const members = new WeakMap<EditorView, Set<Member>>();
const owners = new WeakMap<EditorView, ReturnType<typeof createOwner>>();
const contexts = new WeakMap<
  EditorView,
  {
    document: DocumentNode;
    owner: string;
    values: Map<number, { node: DocumentNode; value: string }>;
  }
>();
const memberElements = new WeakMap<Element, Member>();
const readingPositions = new Map<
  string,
  { position: number; signature: string; offset: number; top: number }
>();
const closedGeometry = new WeakMap<
  HTMLElement,
  {
    node: DocumentNode;
    measurement: ViewportMeasurement | null;
    inner: NodeViewRendererProps["innerDecorations"];
  }
>();

function documentUnits(doc: DocumentNode): readonly Unit[] {
  let cached = units.get(doc);
  if (cached) return cached;
  const found: Unit[] = [];
  doc.descendants((node, position) => {
    // Multi-column/minipage flow cannot be reproduced by a vertical spacer.
    // Those layouts retain their existing DOM until a column-aware adapter exists.
    if (
      node.type.name === "latexScientific" &&
      node.attrs.layout &&
      node.attrs.layout.kind !== "direction" &&
      !(node.attrs.layout.kind === "colorBox" && node.attrs.layout.breakable)
    )
      return false;
    if (node.type.name === "paragraph" || node.type.name === "latexDisplayMath") {
      const point = doc.resolve(position);
      const previous = point.index() > 0 ? point.parent.child(point.index() - 1) : null;
      if (previous?.type.name === "heading" && [4, 5].includes(previous.attrs.level)) return false;
      found.push({ node, position });
      return false;
    }
    return !node.isAtom;
  });
  cached = found;
  units.set(doc, cached);
  unitPositions.set(doc, new Map(found.map((unit) => [unit.position, unit.node])));
  return cached;
}

export function latexViewportUnit(view: EditorView, node: DocumentNode, position: number): boolean {
  return Boolean(
    key.getState(view.state)?.enabled && unitPositions.get(view.state.doc)?.get(position) === node,
  );
}

function sourceSignature(node: DocumentNode): string {
  let signature = signatures.get(node);
  if (signature === undefined) {
    signature = JSON.stringify(node.toJSON());
    signatures.set(node, signature);
  }
  return signature;
}

/** Reading history keeps a compact fingerprint, never another copy of source. */
function readingSignature(node: DocumentNode) {
  let value = readingSignatures.get(node);
  if (value !== undefined) return value;
  const source = sourceSignature(node);
  let first = 2166136261,
    second = 5381;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  value = `${source.length}:${first >>> 0}:${second >>> 0}`;
  readingSignatures.set(node, value);
  return value;
}

export function latexViewportContext(
  view: EditorView,
  node: DocumentNode,
  position: number,
): string {
  const owner = owners.get(view)?.context() ?? "";
  let cached = contexts.get(view);
  if (cached?.document !== view.state.doc || cached.owner !== owner) {
    cached = { document: view.state.doc, owner, values: new Map() };
    contexts.set(view, cached);
  }
  const previous = cached.values.get(position);
  if (previous?.node === node) return previous.value;
  const point = view.state.doc.resolve(position);
  const parents: unknown[] = [];
  for (let depth = 1; depth <= point.depth; depth++) {
    const parent = point.node(depth);
    parents.push([parent.type.name, parent.attrs, parent.firstChild === node]);
  }
  const value = `${owner}|${JSON.stringify(parents)}`;
  // Immutable document/position identity includes ancestor attributes and the
  // first-child role. Keep only the current document and layout generation.
  cached.values.set(position, { node, value });
  return value;
}

export function latexViewportMeasurement(
  view: EditorView,
  node: DocumentNode,
  position: number,
): ViewportMeasurement | null {
  const context = latexViewportContext(view, node, position);
  const local = measurements.get(node)?.get(context);
  if (local) {
    if (owners.get(view)?.reading(node)) {
      const signature = `${context}|${sourceSignature(node)}`;
      retained.get(signature, true);
    }
    return local;
  }
  const signature = `${context}|${sourceSignature(node)}`;
  const previous = retained.get(signature, owners.get(view)?.reading(node) ?? false);
  if (!previous) return null;
  let byContext = measurements.get(node);
  if (!byContext) measurements.set(node, (byContext = new Map()));
  byContext.clear();
  byContext.set(context, previous);
  return previous;
}

/** Publish geometry only after natural-flow measurement; viewport changes never edit source. */
export function recordLatexViewportMeasurement(
  view: EditorView,
  node: DocumentNode,
  position: number,
  measurement: ViewportMeasurement,
  expectedContext = latexViewportContext(view, node, position),
): void {
  if (!latexViewportUnit(view, node, position) || latexViewportClosed(view, position)) return;
  if (view.state.doc.nodeAt(position) !== node) return;
  const context = latexViewportContext(view, node, position);
  if (context !== expectedContext) return;
  const element = view.nodeDOM(position);
  const previews =
    element instanceof Element ? [...element.querySelectorAll(".scient-latex-math-preview")] : [];
  const fallbacks = previews.filter((preview) =>
    preview.hasAttribute("data-math-preview-fallback"),
  );
  measurement = {
    ...measurement,
    mathKeys: mathReadingPreparationKeys(
      previews.filter((preview) => !preview.hasAttribute("data-math-preview-fallback")),
    ),
    mathFallbacks: fallbacks.length,
  };
  let byContext = measurements.get(node);
  if (!byContext) measurements.set(node, (byContext = new Map()));
  const previous = byContext.get(context);
  if (
    previous?.width === measurement.width &&
    previous.height === measurement.height &&
    previous.wordSpacing === measurement.wordSpacing &&
    previous.displayContentHeight === measurement.displayContentHeight &&
    JSON.stringify(previous.mathKeys) === JSON.stringify(measurement.mathKeys) &&
    previous.mathFallbacks === measurement.mathFallbacks &&
    previous.lines.length === measurement.lines.length &&
    previous.lines.every((line, index) => {
      const next = measurement.lines[index]!;
      return (
        line.position === next.position &&
        line.top === next.top &&
        line.bottom === next.bottom &&
        line.keepWithNext === next.keepWithNext
      );
    })
  )
    return;
  // A node can survive width/font changes. Keep only its current geometry.
  byContext.clear();
  byContext.set(context, measurement);
  owners.get(view)?.recorded(node);
  const signature = `${context}|${sourceSignature(node)}`;
  retained.put(
    signature,
    measurement,
    JSON.stringify(measurement).length * 2,
    owners.get(view)?.reading(node) ?? false,
    owners.get(view)?.reading(node) ? "replace" : "available",
  );
}

/** Preparation survives live-DOM eviction, but not source/layout changes or
 * the eviction of a required formula result from the shared byte budget.
 */
export function latexViewportPrepared(view: EditorView, node: DocumentNode, position: number) {
  const measurement = latexViewportMeasurement(view, node, position);
  if (!measurement) return false;
  const mounted = view.nodeDOM(position);
  // Interactive math owns its live geometry and is pinned by the viewport.
  // Its passive cache key is recorded again after returning to reading mode.
  if (mounted instanceof Element && mounted.querySelector("math-field")) return true;
  let formulas = node.type.name === "latexDisplayMath" ? 1 : 0;
  node.descendants((child) => {
    if (child.type.name === "latexInlineMath") formulas++;
  });
  if (mounted instanceof Element && !mounted.hasAttribute("data-latex-viewport-closed")) {
    const previews = [...mounted.querySelectorAll(".scient-latex-math-preview")];
    if (previews.length >= formulas && previews.every(mathReadingPreviewReady)) return true;
  }
  return (
    (measurement.mathKeys?.length ?? 0) + (measurement.mathFallbacks ?? 0) >= formulas &&
    (measurement.mathKeys ?? []).every(hasMathReadingPreview)
  );
}

export function latexViewportClosed(view: EditorView, position: number): boolean {
  const dom = view.nodeDOM(position);
  return dom instanceof HTMLElement && dom.hasAttribute("data-latex-viewport-closed");
}

export function latexViewportOpening(view: EditorView): boolean {
  return key.getState(view.state)?.opening ?? false;
}

/** Explicit navigation supersedes restoration even if scrollTop is unchanged. */
export function navigateLatexViewport(view: EditorView, position?: number) {
  anchorSettlements.get(view)?.();
  anchorSettlements.delete(view);
  readingAnchors.delete(view);
  owners.get(view)?.navigate(position);
}

const anchorSettlements = new WeakMap<EditorView, () => void>();
const readingAnchors = new WeakMap<
  EditorView,
  {
    document: DocumentNode;
    selection: EditorState["selection"];
    node: DocumentNode;
    position: number;
    viewport: HTMLElement;
    offset: number;
    expectedTop: number;
  }
>();

/** Anchor a viewport exchange to the latest visible source block, not a stale caret. */
export function captureLatexViewportAnchor(view: EditorView, incoming?: ReadonlySet<DocumentNode>) {
  const viewport = view.dom.closest<HTMLElement>(".scient-latex-visual-scroll");
  if (!viewport || !view.dom.isConnected || viewport.clientHeight <= 0) return null;
  const box = viewport.getBoundingClientRect();
  const previous = readingAnchors.get(view);
  const retained =
    previous &&
    previous.document === view.state.doc &&
    previous.selection.eq(view.state.selection) &&
    previous.viewport === viewport &&
    Math.abs(previous.expectedTop - viewport.scrollTop) < 1 &&
    view.state.doc.nodeAt(previous.position) === previous.node;
  const previousElement = retained ? view.nodeDOM(previous.position) : null;
  let target: Element | null = null;
  if (!(previousElement instanceof HTMLElement)) {
    const paper = view.dom.getBoundingClientRect();
    target = view.dom.ownerDocument.elementFromPoint(
      Math.min(box.right - 20, Math.max(box.left + 20, paper.left + paper.width / 2)),
      box.top + Math.min(60, box.height / 3),
    );
  }
  let element =
    previousElement instanceof HTMLElement
      ? previousElement
      : target?.closest<HTMLElement>("[data-latex-viewport]");
  let member = element && memberElements.get(element);
  // During cold preparation a partially visible predecessor can change its
  // height. Prefer the first whole visible source block so publishing that
  // height cannot move the content the reader is about to enter.
  let firstTop = box.top + Math.min(350, box.height / 2);
  let sibling = element?.nextElementSibling;
  for (
    let index = 0;
    !retained && sibling && index < 8;
    index++, sibling = sibling.nextElementSibling
  ) {
    const candidate = memberElements.get(sibling);
    if (!candidate) continue;
    const rect = candidate.dom.getBoundingClientRect();
    if (rect.top < box.top + 20 || rect.top >= firstTop) continue;
    firstTop = rect.top;
    member = candidate;
    element = candidate.dom;
  }
  const viewportState = key.getState(view.state);
  const relevant = (candidate: Member) =>
    candidate.dom.isConnected &&
    (candidate.mounted ||
      viewportState?.visible.has(candidate.node()) ||
      viewportState?.pageDemand.has(candidate.node()) ||
      incoming?.has(candidate.node()));
  for (const candidate of members.get(view) ?? []) {
    if (retained || !relevant(candidate)) continue;
    const rect = candidate.dom.getBoundingClientRect();
    if (rect.top < box.top + 20 || rect.top >= firstTop) continue;
    firstTop = rect.top;
    member = candidate;
    element = candidate.dom;
  }
  // Headings, title whitespace and page gaps need a nearby source unit too.
  // Search mounted and incoming/observed cold views; distant opaque units
  // need no layout reads. Keep one source identity throughout preparation.
  if (!member) {
    let nearest = Infinity;
    for (const candidate of members.get(view) ?? []) {
      if (!relevant(candidate)) continue;
      const rect = candidate.dom.getBoundingClientRect();
      if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
      const distance = Math.abs(rect.top - (box.top + Math.min(60, box.height / 3)));
      if (distance >= nearest) continue;
      nearest = distance;
      member = candidate;
      element = candidate.dom;
    }
  }
  const position = member?.position();
  if (!member || position === undefined || !element) return null;
  const top = retained ? box.top + previous.offset : element.getBoundingClientRect().top;
  const node = member.node();
  if (!retained) {
    anchorSettlements.get(view)?.();
    anchorSettlements.delete(view);
  }
  const readingAnchor = retained
    ? previous
    : {
        document: view.state.doc,
        selection: view.state.selection,
        node,
        position,
        viewport,
        offset: top - box.top,
        expectedTop: viewport.scrollTop,
      };
  readingAnchors.set(view, readingAnchor);
  return {
    position,
    top,
    viewport,
    restore() {
      // Callers fence async scroll intent before this synchronous DOM exchange.
      // Native browser anchoring inside dispatch is presentation, not new input.
      if (view.isDestroyed || view.state.doc.nodeAt(position) !== node) return;
      const next = view.nodeDOM(position);
      if (!(next instanceof HTMLElement)) return;
      const delta = next.getBoundingClientRect().top - top;
      viewport.scrollTop += delta;
      readingAnchor.expectedTop = viewport.scrollTop;
      // Layout can settle after a scroll correction. Correct that once, only
      // while navigation, source and selection remain unchanged.
      if (Math.abs(delta) < 0.5) return;
      anchorSettlements.get(view)?.();
      const document = view.state.doc;
      const selection = view.state.selection;
      const expectedTop = viewport.scrollTop;
      const cancel = afterEditorPaint(() => {
        anchorSettlements.delete(view);
        if (
          view.isDestroyed ||
          readingAnchors.get(view) !== readingAnchor ||
          !viewport.isConnected ||
          view.state.doc !== document ||
          !view.state.selection.eq(selection) ||
          viewport.scrollTop !== expectedTop
        )
          return;
        const settled = view.nodeDOM(position);
        if (settled instanceof HTMLElement) {
          viewport.scrollTop += settled.getBoundingClientRect().top - top;
          readingAnchor.expectedTop = viewport.scrollTop;
        }
      });
      anchorSettlements.set(view, cancel);
    },
  };
}

/** Natural geometry for a source-backed paragraph in the current layout. */
export function latexViewportParagraphMeasurement(view: EditorView, element: Element) {
  const member = memberElements.get(element);
  const position = member?.position();
  if (
    !member ||
    member.node().type.name !== "paragraph" ||
    position === undefined ||
    element.parentElement !== view.dom
  )
    return null;
  return latexViewportMeasurement(view, member.node(), position);
}

/** A remounted unit may use geometry from the same source/layout generation. */
export function latexViewportPreparedElement(view: EditorView, element: Element): boolean {
  const member = memberElements.get(element);
  const position = member?.position();
  return Boolean(
    member && position !== undefined && latexViewportMeasurement(view, member.node(), position),
  );
}

export function finishLatexViewportMeasurements(view: EditorView): void {
  owners.get(view)?.measured();
}

/** Source units touching complete pages, including paragraphs split across sheets. */
const orderedPagePlacements = new WeakMap<
  readonly { position: number; page: number }[],
  readonly { position: number; page: number }[]
>();
const pageUnits = new WeakMap<
  readonly { position: number; page: number }[],
  WeakMap<DocumentNode, Map<number, readonly Unit[]>>
>();
const unitPages = new WeakMap<
  readonly { position: number; page: number }[],
  WeakMap<DocumentNode, Map<DocumentNode, Set<number>>>
>();

export function latexViewportPageNodes(
  view: EditorView,
  pages: ReadonlySet<number>,
  placements: readonly { position: number; page: number }[],
) {
  let ordered = orderedPagePlacements.get(placements);
  if (!ordered) {
    ordered = [...placements].sort((a, b) => a.position - b.position);
    orderedPagePlacements.set(placements, ordered);
  }
  let documents = pageUnits.get(placements);
  if (!documents) pageUnits.set(placements, (documents = new WeakMap()));
  let index = documents.get(view.state.doc);
  if (!index) {
    index = new Map();
    const membership = new Map<DocumentNode, Set<number>>();
    let cursor = 0;
    for (const unit of documentUnits(view.state.doc)) {
      while (cursor < ordered.length && ordered[cursor]!.position <= unit.position) cursor++;
      const touching = new Set<number>();
      if (cursor) touching.add(ordered[cursor - 1]!.page + 1);
      for (
        let point = cursor;
        point < ordered.length && ordered[point]!.position < unit.position + unit.node.nodeSize;
        point++
      )
        touching.add(ordered[point]!.page + 1);
      for (const page of touching) index.set(page, [...(index.get(page) ?? []), unit]);
      membership.set(unit.node, touching);
    }
    documents.set(view.state.doc, index);
    let byDocument = unitPages.get(placements);
    if (!byDocument) unitPages.set(placements, (byDocument = new WeakMap()));
    byDocument.set(view.state.doc, membership);
  }
  const found = new Set<Unit>();
  for (const page of pages) for (const unit of index.get(page) ?? []) found.add(unit);
  return [...found].sort((a, b) => a.position - b.position);
}

/** Known offscreen source members have no visible membership; their completion
 * must not invalidate an unrelated reading page.
 */
export function latexViewportMemberPages(
  view: EditorView,
  element: Element,
  placements: readonly { position: number; page: number }[],
) {
  const member = memberElements.get(element);
  if (!member) return null;
  latexViewportPageNodes(view, new Set(), placements);
  return unitPages.get(placements)?.get(view.state.doc)?.get(member.node()) ?? new Set<number>();
}

export function demandLatexViewportPages(view: EditorView, nodes: ReadonlySet<DocumentNode>) {
  owners.get(view)?.demand(nodes);
}

export function updateLatexOpeningPageReadiness(view: EditorView, ready: boolean) {
  owners.get(view)?.pageReady(ready);
}

/** Diagnostic admission accounting; excludes live working/selected views and
 * is an estimate, not browser heap or physical memory. */
export function latexViewportReadingRetention(view: EditorView) {
  return owners.get(view)?.readingRetention();
}

export function fallbackLatexViewportPage(
  view: EditorView,
  nodes: ReadonlySet<DocumentNode>,
  enabled: boolean,
) {
  owners.get(view)?.fallback(nodes, enabled);
}

/** Thumbnail pages are independent of the reading viewport, but share its model. */
export function presentLatexViewportPages(
  view: EditorView,
  pages: ReadonlySet<number>,
  placements: readonly { position: number; page: number }[],
): boolean {
  if (view.isDestroyed || !key.getState(view.state)?.enabled) return true;
  const presented = new Set<DocumentNode>();
  for (const unit of documentUnits(view.state.doc)) {
    let preceding: (typeof placements)[number] | undefined;
    let intersects = false;
    for (const placement of placements) {
      if (placement.position <= unit.position) preceding = placement;
      if (
        placement.position >= unit.position &&
        placement.position < unit.position + unit.node.nodeSize &&
        pages.has(placement.page + 1)
      )
        intersects = true;
    }
    if (intersects || (preceding && pages.has(preceding.page + 1))) presented.add(unit.node);
  }
  owners.get(view)?.present(presented);
  const currentMembers = [...(members.get(view) ?? [])];
  return [...presented].every((node) =>
    currentMembers.some(
      (member) =>
        member.node() === node &&
        member.mounted &&
        member.dom.isConnected &&
        [...member.dom.querySelectorAll(".scient-latex-math-preview")].every(
          mathReadingPreviewReady,
        ),
    ),
  );
}

function mounted(state: EditorState, node: DocumentNode, position: number): boolean {
  const viewport = key.getState(state);
  if (!viewport?.enabled || viewport.print) return true;
  if (unitPositions.get(state.doc)?.get(position) !== node) return true;
  if (
    viewport.visible.has(node) ||
    viewport.warm.has(node) ||
    viewport.preparing.has(node) ||
    viewport.pinned.has(node) ||
    viewport.presented.has(node) ||
    viewport.pageDemand.has(node)
  )
    return true;
  const contains = (point: number) => point > position && point < position + node.nodeSize;
  if (contains(state.selection.anchor) || contains(state.selection.head)) return true;
  if (state.selection instanceof NodeSelection && state.selection.from === position) return true;
  const search = scientMarkdownSearchState(state);
  const match = search?.matches[search.activeIndex];
  return Boolean(match && (contains(match.from) || contains(match.to)));
}

function register(view: EditorView, member: Member): () => void {
  let set = members.get(view);
  if (!set) members.set(view, (set = new Set()));
  set.add(member);
  memberElements.set(member.dom, member);
  owners.get(view)?.observe(member);
  return () => {
    owners.get(view)?.unobserve(member);
    set.delete(member);
    memberElements.delete(member.dom);
  };
}

function estimatedHeight(node: DocumentNode): string {
  if (node.type.name === "latexDisplayMath") {
    const rows = String(node.attrs.tex ?? "").split(/\\\\/u).length;
    return `${Math.min(20, Math.max(1, rows)) * 2.2}em`;
  }
  return `${Math.max(1, Math.ceil(node.textContent.length / 80)) * 1.3}em`;
}

/** An isolated pass cannot populate Chromium's remembered live layout sizes.
 * Seed mounted offscreen units with their prepared geometry, including inline
 * page gaps, instead of letting the browser use the generic 100px estimate.
 */
function applyMountedGeometry(
  props: NodeViewRendererProps,
  dom: HTMLElement,
  node: DocumentNode,
  position: number,
): void {
  const measurement = latexViewportMeasurement(props.view, node, position);
  dom.style.setProperty("--scient-latex-viewport-estimate", estimatedHeight(node));
  const selection = props.view.state.selection;
  const contains = (point: number) => point >= position && point <= position + node.nodeSize;
  dom.dataset.latexViewportEditing = String(
    props.view.hasFocus() && (contains(selection.anchor) || contains(selection.head)),
  );
  const paragraph = node.type.name === "paragraph";
  const body = paragraph
    ? dom
    : dom.querySelector<HTMLElement>(".scient-latex-visual-display-math");
  let height = paragraph ? measurement?.height : measurement?.displayContentHeight;
  if (height !== undefined && paragraph)
    props.innerDecorations.forEachSet((set) => {
      for (const decoration of set.find())
        height! += (decoration.spec.latexPageGap as { height: number } | undefined)?.height ?? 0;
    });
  let maths = 0;
  node.descendants((child) => {
    if (child.type.name === "latexInlineMath" || child.type.name === "latexDisplayMath") maths++;
  });
  if (node.type.name === "latexDisplayMath") maths++;
  const previews = [...dom.querySelectorAll(".scient-latex-math-preview")];
  const rendering = previews.length < maths || !previews.every(mathReadingPreviewReady);
  dom.dataset.latexViewportRendering = String(rendering);
  const prepared = body !== null && height !== undefined && Number.isFinite(height) && height >= 0;
  if (dom.dataset.latexViewportPrepared !== String(prepared))
    dom.dataset.latexViewportPrepared = String(prepared);
  if (body) {
    if (prepared) {
      const value = `${height}px`;
      if (body.style.getPropertyValue("--scient-latex-block-height") !== value)
        body.style.setProperty("--scient-latex-block-height", value);
    } else body.style.removeProperty("--scient-latex-block-height");
  }
}

function applyClosedGeometry(
  props: NodeViewRendererProps,
  dom: HTMLElement,
  node: DocumentNode,
  position: number,
): void {
  const measurement = latexViewportMeasurement(props.view, node, position);
  const previous = closedGeometry.get(dom);
  if (
    previous?.node === node &&
    previous.measurement === measurement &&
    previous.inner === props.innerDecorations
  )
    return;
  closedGeometry.set(dom, { node, measurement, inner: props.innerDecorations });
  dom.style.setProperty(
    "--scient-latex-viewport-natural-height",
    measurement ? `${measurement.height}px` : estimatedHeight(node),
  );
  if (node.type.name === "latexDisplayMath")
    dom.style.setProperty(
      "--scient-latex-viewport-display-height",
      measurement?.displayContentHeight !== undefined
        ? `${measurement.displayContentHeight}px`
        : estimatedHeight(node),
    );
  dom.dataset.latexViewportPrepared = String(Boolean(measurement));
  const gaps: { height: number; offset: number; explicit: boolean; inline: boolean }[] = [];
  props.innerDecorations.forEachSet((set) => {
    for (const decoration of set.find()) {
      const gap = decoration.spec.latexPageGap as
        | { height: number; explicit: boolean; inline: boolean }
        | undefined;
      if (!gap) continue;
      const line = measurement?.lines.find((line) => line.position >= decoration.from + 1);
      gaps.push({ ...gap, offset: line?.top ?? 0 });
    }
  });
  for (const previous of dom.querySelectorAll(":scope > .scient-latex-pagination-gap"))
    previous.remove();
  let total = 0;
  for (const gap of gaps) {
    const spacer = document.createElement("span");
    spacer.className = "scient-latex-pagination-gap";
    spacer.setAttribute("aria-hidden", "true");
    spacer.contentEditable = "false";
    spacer.style.top = `${gap.offset + total}px`;
    spacer.style.height = `${gap.height}px`;
    if (gap.explicit) spacer.dataset.explicit = "true";
    if (gap.inline) spacer.dataset.inline = "true";
    dom.append(spacer);
    total += gap.height;
  }
  dom.style.setProperty("--scient-latex-viewport-gap-height", `${total}px`);
}

/** An opaque offscreen view retains model positions, including all of its inline atoms. */
export function latexViewportNodeView(fallback?: NodeViewRenderer): NodeViewRenderer {
  return (initialProps) => {
    let props = initialProps;
    const position = () => {
      try {
        return props.getPos();
      } catch {
        return undefined;
      }
    };
    const initialPosition = position();
    if (initialPosition === undefined)
      return fallback?.(props) ?? { dom: document.createElement("p"), update: () => false };
    const open = mounted(props.view.state, props.node, initialPosition);
    const delegated = open && fallback ? fallback(props) : null;
    const dom =
      delegated?.dom ?? document.createElement(props.node.type.name === "paragraph" ? "p" : "div");
    if (!(dom instanceof HTMLElement)) throw Error("Viewport view must expose an HTML element");
    const paragraph = props.node.type.name === "paragraph";
    const contentDOM = open && paragraph ? dom : (delegated?.contentDOM ?? null);
    let attributes = new Set<string>();
    const refreshAttributes = () => {
      if (!paragraph) return;
      const next = getRenderedAttributes(props.node, props.editor.extensionManager.attributes);
      for (const name of attributes) if (!(name in next)) dom.removeAttribute(name);
      for (const [name, value] of Object.entries(next)) {
        if (dom.getAttribute(name) !== String(value)) dom.setAttribute(name, String(value));
      }
      attributes = new Set(Object.keys(next));
    };
    refreshAttributes();
    if (!open) {
      dom.dataset.latexViewportClosed = "true";
      dom.contentEditable = "false";
      if (!paragraph) dom.className = "react-renderer node-latexDisplayMath";
      const accessible = document.createElement("span");
      accessible.className = "scient-latex-viewport-accessible";
      accessible.textContent = paragraph
        ? props.node.textBetween(0, props.node.content.size, " ", (node) =>
            String(node.attrs.tex ?? node.attrs.argument ?? ""),
          )
        : String(props.node.attrs.tex ?? "");
      dom.append(accessible);
      if (!paragraph) {
        const body = document.createElement("div");
        body.className = "scient-latex-visual-display-math";
        body.setAttribute("aria-hidden", "true");
        dom.append(body);
      }
      applyClosedGeometry(props, dom, props.node, initialPosition);
    } else applyMountedGeometry(props, dom, props.node, initialPosition);
    const member: Member = {
      dom,
      node: () => props.node,
      position,
      mounted: open,
    };
    const unregister = register(props.view, member);
    const result: NodeView = {
      dom,
      contentDOM,
      update(node, decorations, innerDecorations) {
        const currentPosition = position();
        if (
          node.type !== props.node.type ||
          currentPosition === undefined ||
          mounted(props.view.state, node, currentPosition) !== open
        )
          return false;
        props = { ...props, node, decorations, innerDecorations };
        refreshAttributes();
        if (!open) {
          const text = paragraph
            ? node.textBetween(0, node.content.size, " ", (child) =>
                String(child.attrs.tex ?? child.attrs.argument ?? ""),
              )
            : String(node.attrs.tex ?? "");
          const accessible = dom.querySelector(".scient-latex-viewport-accessible")!;
          if (accessible.textContent !== text) accessible.textContent = text;
          applyClosedGeometry(props, dom, node, currentPosition);
        }
        const accepted = delegated?.update?.(node, decorations, innerDecorations) ?? true;
        if (open && accepted) applyMountedGeometry(props, dom, node, currentPosition);
        return accepted;
      },
      selectNode() {
        dom.classList.add("ProseMirror-selectednode");
        delegated?.selectNode?.();
      },
      deselectNode() {
        dom.classList.remove("ProseMirror-selectednode");
        delegated?.deselectNode?.();
      },
      stopEvent(event) {
        return delegated?.stopEvent?.(event) ?? false;
      },
      ignoreMutation(mutation) {
        if (!open) return mutation.type !== "selection";
        return (
          delegated?.ignoreMutation?.(mutation) ??
          (mutation.type === "attributes" && mutation.target === dom)
        );
      },
      destroy() {
        unregister();
        delegated?.destroy?.();
      },
    };
    return result;
  };
}

function createOwner(
  view: EditorView,
  sourceContext: () => string,
  readingKey: () => string,
  onOpeningChange: (opening: boolean) => void,
) {
  let disposed = false;
  let observer: IntersectionObserver | undefined;
  let observedRoot: HTMLElement | null = null;
  let overscan = "";
  let velocity = 0;
  let scrollTop = 0;
  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let contextValue = "";
  let contextIdentity = 0;
  let contextReferences: ReturnType<typeof latexReferencePresentation>;
  let referenceValue = "";
  let visible = new Set<DocumentNode>();
  let lastInput = 0;
  let preparing = new Set<DocumentNode>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let measurementRequested = false;
  let cachePressure = latexReadingCacheBudget.statistics();
  let idleWarmCapacity = true;
  let refreshRequested = false;
  const refreshNodes = new Set<DocumentNode>();
  let previousDocument = view.state.doc;
  const retention = createLatexViewportRetention<DocumentNode>();
  const readiness = new WeakMap<HTMLElement, boolean>();
  const readingWeights = new WeakMap<
    HTMLElement,
    { node: DocumentNode; context: string; weight: number }
  >();
  const sourceWeights = new WeakMap<DocumentNode, number>();
  const mountedWeights = new WeakMap<DocumentNode, number>();
  const visited = new WeakSet<DocumentNode>();
  let layoutReady = false;
  let loadingFonts = false;
  let openingPagesReady = true;
  let stableOpeningFrames = 0;
  let previousOpeningGeometry: string | null = null;
  const resetOpeningFrames = () => {
    stableOpeningFrames = 0;
    previousOpeningGeometry = null;
  };
  const keepOpening = (ready: boolean, geometry: string) => {
    if (!key.getState(view.state)?.opening) return false;
    if (!ready || !openingPagesReady) {
      resetOpeningFrames();
      return true;
    }
    stableOpeningFrames = previousOpeningGeometry === geometry ? stableOpeningFrames + 1 : 1;
    previousOpeningGeometry = geometry;
    if (stableOpeningFrames < 2) {
      schedule();
      return true;
    }
    return false;
  };
  let openingLocation = readingPositions.get(readingKey());
  if (
    openingLocation &&
    readingSignature(view.state.doc.nodeAt(openingLocation.position) ?? view.state.doc) !==
      openingLocation.signature
  )
    openingLocation = undefined;
  let openingTop = openingLocation?.top ?? 0;
  let requiredNodes = new Set<DocumentNode>();
  let lastScroll = 0;
  const status = document.createElement("div");
  status.className = "scient-latex-viewport-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  const statusLabel = document.createElement("span");
  status.append(statusLabel);
  const context = () => String(contextIdentity);
  const root = () => view.dom.closest<HTMLElement>(".scient-latex-visual-scroll");
  const restoreOpening = () => {
    const scroll = root();
    if (!scroll || !key.getState(view.state)?.opening) return;
    const element = openingLocation && view.nodeDOM(openingLocation.position);
    if (element instanceof HTMLElement)
      scroll.scrollTop +=
        element.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        openingLocation!.offset;
    else scroll.scrollTop = openingTop;
  };
  const saveReadingPosition = () => {
    if (!readingKey() || key.getState(view.state)?.opening) return;
    const anchor = captureLatexViewportAnchor(view);
    if (!anchor) return;
    const node = view.state.doc.nodeAt(anchor.position);
    if (!node) return;
    readingPositions.delete(readingKey());
    readingPositions.set(readingKey(), {
      position: anchor.position,
      signature: readingSignature(node),
      offset: anchor.top - anchor.viewport.getBoundingClientRect().top,
      top: anchor.viewport.scrollTop,
    });
    if (readingPositions.size > 32) readingPositions.delete(readingPositions.keys().next().value!);
  };
  const publish = (update: ViewportUpdate) => {
    if (disposed || view.isDestroyed) return;
    const previous = key.getState(view.state);
    if (!previous) return;
    const same = (left: ReadonlySet<DocumentNode>, right: ReadonlySet<DocumentNode>) =>
      left.size === right.size && [...left].every((node) => right.has(node));
    if (
      !update.refresh &&
      !update.refreshNodes?.size &&
      (!update.visible || same(update.visible, previous.visible)) &&
      (!update.warm || same(update.warm, previous.warm)) &&
      (!update.preparing || same(update.preparing, previous.preparing)) &&
      (!update.pinned || same(update.pinned, previous.pinned)) &&
      (!update.presented || same(update.presented, previous.presented)) &&
      (!update.pageDemand || same(update.pageDemand, previous.pageDemand)) &&
      (!update.fallback || same(update.fallback, previous.fallback)) &&
      (update.pending === undefined || update.pending === previous.pending) &&
      (update.opening === undefined || update.opening === previous.opening) &&
      (update.print === undefined || update.print === previous.print)
    )
      return;
    const anchor = previous.opening
      ? null
      : captureLatexViewportAnchor(view, update.pageDemand ?? update.visible);
    view.dispatch(view.state.tr.setMeta(key, update).setMeta("addToHistory", false));
    if (update.opening !== undefined && update.opening !== previous.opening)
      onOpeningChange(update.opening);
    anchor?.restore();
  };
  const configure = () => {
    const scroll = root();
    if (!scroll || !view.dom.isConnected) return false;
    if (status.parentElement !== scroll) scroll.prepend(status);
    if (scroll !== observedRoot) {
      observedRoot?.removeEventListener("scroll", scrolled);
      if (observedRoot) resize.unobserve(observedRoot);
      observedRoot = scroll;
      scroll.addEventListener("scroll", scrolled, { passive: true });
      resize.observe(scroll);
    }
    const height = scroll.clientHeight;
    if (height <= 0 || scroll.clientWidth <= 0) {
      // Source/PDF retain this editor while hiding its pane. Its unresolved
      // width is not a new layout; ResizeObserver resumes preparation on show.
      clearTimeout(timeout);
      return false;
    }
    const style = getComputedStyle(view.dom);
    const references = latexReferencePresentation(view.state);
    if (contextReferences !== references) {
      contextReferences = references;
      referenceValue =
        JSON.stringify(references, (_key, item: unknown) =>
          item instanceof Map ? [...item] : item,
        ) ?? "";
    }
    const nextContext = JSON.stringify([
      sourceContext(),
      latexTypographyKey(style),
      style.width,
      style.lineHeight,
      style.textIndent,
      style.letterSpacing,
      style.direction,
      referenceValue,
      latexReadingFontKey(view.dom),
    ]);
    if (nextContext !== contextValue) {
      contextValue = nextContext;
      contextIdentity = latexReadingContextIdentity(nextContext);
      resetOpeningFrames();
      retention.clear();
      layoutReady = false;
      measurementRequested = false;
      refreshRequested = true;
      idleWarmCapacity = true;
      cachePressure = latexReadingCacheBudget.statistics();
    }
    if (!latexReadingFontsReady(view.dom)) {
      statusLabel.textContent = key.getState(view.state)?.opening
        ? openingTop > 0 || openingLocation
          ? "Preparing reading view…"
          : "Preparing first page…"
        : "Preparing page layout…";
      status.hidden = key.getState(view.state)?.opening ?? true;
      resetOpeningFrames();
      if (!loadingFonts) {
        loadingFonts = true;
        void prepareLatexReadingFonts(view.dom).then(() => {
          loadingFonts = false;
          if (!disposed) schedule();
        });
      }
      return false;
    }
    restoreOpening();
    const scale = view.dom.getBoundingClientRect().width / Number.parseFloat(style.width);
    const paperHeight =
      Number.parseFloat(style.getPropertyValue("--scient-latex-paper-height")) * scale;
    const openingMargin = key.getState(view.state)?.opening
      ? Math.max(height, paperHeight) -
        height +
        paperHeight +
        Number.parseFloat(style.getPropertyValue("--scient-latex-page-gap")) * scale +
        200
      : 0;
    const margin = Math.max(750, height * 1.5, openingMargin || 0);
    const ahead =
      performance.now() - lastScroll < 180
        ? Math.min(3, Math.floor((Math.abs(velocity) * 320) / height) / 2) * height
        : 0;
    const nextOverscan = `${margin + (velocity < 0 ? ahead : 0)}px 0px ${margin + (velocity > 0 ? ahead : 0)}px 0px`;
    if (scroll !== observedRoot || nextOverscan !== overscan) {
      observer?.disconnect();
      observedRoot?.removeEventListener("scroll", scrolled);
      if (observedRoot) resize.unobserve(observedRoot);
      observedRoot = scroll;
      overscan = nextOverscan;
      scroll.addEventListener("scroll", scrolled, { passive: true });
      resize.observe(scroll);
      observer = new IntersectionObserver(
        (entries) => {
          let changed = false;
          for (const entry of entries) {
            const member = memberElements.get(entry.target);
            if (!member || !member.dom.isConnected) continue;
            const node = member.node();
            if (entry.isIntersecting && !visible.has(node)) {
              visible.add(node);
              changed = true;
            } else if (!entry.isIntersecting && visible.delete(node)) changed = true;
          }
          if (changed) schedule();
        },
        { root: scroll, rootMargin: overscan },
      );
      for (const member of members.get(view) ?? []) observer.observe(member.dom);
    }
    return true;
  };
  const schedule = () => {
    if (disposed || cancel) return;
    cancel = afterEditorPaint(tick);
  };
  const tick = () => {
    cancel = undefined;
    if (disposed || !configure()) {
      if (!disposed && (!root() || !view.dom.isConnected)) schedule();
      return;
    }
    const viewport = key.getState(view.state);
    if (!viewport) return;
    if (!viewport.enabled) {
      const ready =
        layoutReady &&
        [...view.dom.querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady);
      const scroll = root()!;
      const rect = view.dom.getBoundingClientRect();
      const opening = keepOpening(
        ready,
        JSON.stringify([
          contextValue,
          scroll.scrollTop,
          scroll.clientWidth,
          scroll.clientHeight,
          rect.width,
          rect.height,
        ]),
      );
      if (viewport.opening && !opening) publish({ opening: false });
      statusLabel.textContent = ready
        ? ""
        : viewport.opening
          ? "Preparing first page…"
          : "Preparing page layout…";
      status.hidden = opening || ready;
      return;
    }
    const all = documentUnits(view.state.doc);
    const currentNodes = new Set(all.map((unit) => unit.node));
    visible = new Set([...visible].filter((node) => currentNodes.has(node)));
    const liveMembers = [...(members.get(view) ?? [])].filter(
      (member) => member.mounted && member.dom.isConnected,
    );
    const byNode = new Map(liveMembers.map((member) => [member.node(), member]));
    const scroll = root()!;
    const box = scroll.getBoundingClientRect();
    const style = getComputedStyle(view.dom);
    const scale = view.dom.getBoundingClientRect().width / Number.parseFloat(style.width);
    const bottom = viewport.opening
      ? box.top +
        Math.max(
          box.height,
          Number.parseFloat(style.getPropertyValue("--scient-latex-paper-height")) * scale,
        ) +
        (Number.parseFloat(style.getPropertyValue("--scient-latex-paper-height")) +
          Number.parseFloat(style.getPropertyValue("--scient-latex-page-gap"))) *
          scale +
        200
      : box.bottom + 200;
    const reading = new Set<DocumentNode>();
    const required = new Set<DocumentNode>();
    for (const member of members.get(view) ?? []) {
      if (
        !member.dom.isConnected ||
        (!visible.has(member.node()) && !viewport.presented.has(member.node()))
      )
        continue;
      const rect = member.dom.getBoundingClientRect();
      if (rect.bottom <= box.top || rect.top >= bottom) continue;
      required.add(member.node());
      if (rect.top < box.bottom) {
        reading.add(member.node());
        if (member.mounted) visited.add(member.node());
      }
    }
    for (const node of viewport.pageDemand) required.add(node);
    const completed = new Set(
      liveMembers
        .filter((member) => {
          const position = member.position();
          return position !== undefined && latexViewportPrepared(view, member.node(), position);
        })
        .map((member) => member.node()),
    );
    const warm = retention.update(
      reading,
      currentNodes,
      (node) => {
        const element = byNode.get(node)?.dom;
        const cached = element && readingWeights.get(element);
        if (cached?.node === node && cached.context === contextValue) return cached.weight;
        let base = sourceWeights.get(node);
        if (base === undefined) {
          base = node.nodeSize * 2 + JSON.stringify(node.attrs).length * 2;
          sourceWeights.set(node, base);
        }
        if (!element) return mountedWeights.get(node) ?? base + 1024;
        const weight = latexReadingViewWeight(element, base);
        readingWeights.set(element, { node, context: contextValue, weight });
        mountedWeights.set(node, weight);
        return weight;
      },
      completed,
    );
    requiredNodes = required;
    if (viewport.opening && !openingLocation && openingTop > 0) {
      const target = [...(members.get(view) ?? [])].find((member) => reading.has(member.node()));
      const position = target?.position();
      if (target && position !== undefined)
        openingLocation = {
          position,
          signature: readingSignature(target.node()),
          offset: target.dom.getBoundingClientRect().top - box.top,
          top: scroll.scrollTop,
        };
    }
    for (const member of liveMembers) {
      const position = member.position();
      const selection = view.state.selection;
      const editing =
        position !== undefined &&
        view.hasFocus() &&
        [selection.anchor, selection.head].some(
          (point) => point >= position && point <= position + member.node().nodeSize,
        );
      if (member.dom.dataset.latexViewportEditing !== String(editing))
        refreshNodes.add(member.node());
      const ready = [...member.dom.querySelectorAll(".scient-latex-math-preview")].every(
        mathReadingPreviewReady,
      );
      if (readiness.get(member.dom) !== ready) {
        readiness.set(member.dom, ready);
        refreshNodes.add(member.node());
      }
    }
    const pinned = new Set<DocumentNode>();
    for (const member of members.get(view) ?? []) {
      if (member.dom.contains(document.activeElement) || member.dom.querySelector("math-field"))
        pinned.add(member.node());
    }
    if (
      view.composing ||
      performance.now() - lastInput < 180 ||
      (
        navigator as Navigator & { scheduling?: { isInputPending(): boolean } }
      ).scheduling?.isInputPending()
    ) {
      publish({
        visible: new Set(visible),
        warm,
        pinned,
        refresh: refreshRequested,
        refreshNodes: new Set(refreshNodes),
      });
      refreshRequested = false;
      refreshNodes.clear();
      clearTimeout(timeout);
      timeout = setTimeout(schedule, 180);
      return;
    }
    // Wait for the currently prepared nodes to receive accurate natural geometry.
    const capacity = latexReadingCacheBudget.statistics();
    if (capacity.spaceGeneration !== cachePressure.spaceGeneration) idleWarmCapacity = true;
    else if (capacity.capacityRejections > cachePressure.capacityRejections)
      idleWarmCapacity = false;
    cachePressure = capacity;
    preparing = new Set(
      [...preparing].filter((node) => {
        const unit = all.find((unit) => unit.node === node);
        return unit && !latexViewportPrepared(view, node, unit.position);
      }),
    );
    const pending = all.filter(
      (unit) =>
        !viewport.fallback.has(unit.node) && !latexViewportPrepared(view, unit.node, unit.position),
    );
    const readingPending = pending.filter((unit) => required.has(unit.node));
    const urgent = readingPending.length
      ? readingPending
      : pending.filter((unit) => viewport.presented.has(unit.node));
    const candidates = (urgent.length ? urgent : idleWarmCapacity ? pending : []).filter(
      () => urgent.length || performance.now() - lastScroll > 180,
    );
    candidates.sort(
      (a, b) =>
        Number(reading.has(b.node)) - Number(reading.has(a.node)) ||
        Number(visible.has(b.node)) - Number(visible.has(a.node)) ||
        a.position - b.position,
    );
    // A new visible demand preempts the background cohort. It never waits for
    // unrelated previews; idle work still amortizes full-flow measurement.
    const desired = new Set(candidates.slice(0, urgent.length ? 32 : 64).map((unit) => unit.node));
    const previousPreparing = preparing;
    preparing = new Set([...preparing].filter((node) => desired.has(node)));
    if (preparing.size !== previousPreparing.size) measurementRequested = false;
    const target = desired.size;
    if (preparing.size < target) {
      measurementRequested = false;
      for (const unit of candidates
        .filter((unit) => !preparing.has(unit.node))
        .slice(0, Math.min(8, target - preparing.size)))
        preparing.add(unit.node);
      if (preparing.size < target) {
        if (candidates.length) schedule();
        else {
          clearTimeout(timeout);
          timeout = setTimeout(schedule, 140);
        }
      }
    }
    if (!target && pending.length && idleWarmCapacity) {
      clearTimeout(timeout);
      timeout = setTimeout(schedule, 190);
    }
    const visiblePending = readingPending.length > 0;
    const rendering = liveMembers.some(
      (member) => required.has(member.node()) && !readiness.get(member.dom),
    );
    const opening = keepOpening(
      layoutReady && !visiblePending && !rendering,
      viewport.opening
        ? JSON.stringify([
            contextValue,
            scroll.scrollTop,
            scroll.clientWidth,
            scroll.clientHeight,
            ...all
              .filter((unit) => required.has(unit.node))
              .map((unit) => {
                const element = view.nodeDOM(unit.position);
                const rect =
                  element instanceof HTMLElement ? element.getBoundingClientRect() : null;
                return [unit.position, rect ? rect.top - box.top : null, rect?.height];
              }),
          ])
        : "",
    );
    publish({
      opening,
      visible: new Set(visible),
      warm,
      preparing: new Set(preparing),
      pinned,
      pending: pending.length,
      refresh: refreshRequested,
      refreshNodes: new Set(refreshNodes),
    });
    refreshRequested = false;
    refreshNodes.clear();
    const preparedMembers = [...(members.get(view) ?? [])].filter(
      (member) => preparing.has(member.node()) && member.mounted && member.dom.isConnected,
    );
    const readyMembers = preparedMembers.filter((member) =>
      [...member.dom.querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady),
    );
    // Wait for this bounded cohort's previews before measuring its natural flow.
    // During scrolling, visible members own admission; idle work resumes.
    if (
      readyMembers.length &&
      !measurementRequested &&
      readyMembers.length === preparedMembers.length &&
      preparing.size >= target
    ) {
      measurementRequested = true;
      view.dom.dispatchEvent(
        new CustomEvent("scient-latex-viewport-measure", {
          bubbles: true,
          detail: readyMembers.map((member) => member.dom),
        }),
      );
    }
    if (
      !urgent.length &&
      (!pending.length || !idleWarmCapacity) &&
      performance.now() - lastScroll > 180
    ) {
      const cachedClosed: Unit[] = [];
      let reserved = 0;
      for (const unit of all) {
        if (
          byNode.has(unit.node) ||
          warm.has(unit.node) ||
          !latexViewportPrepared(view, unit.node, unit.position)
        )
          continue;
        const known = mountedWeights.get(unit.node);
        const cost =
          known ?? unit.node.nodeSize * 2 + JSON.stringify(unit.node.attrs).length * 2 + 1024;
        if (!retention.canAdmit(cost, reserved)) continue;
        cachedClosed.push(unit);
        reserved += cost;
        // Unknown DOM weight gets one exploratory mount, then an accurate
        // charge. Known compatible views share a cumulatively reserved batch.
        if (known === undefined || cachedClosed.length >= 8) break;
      }
      if (cachedClosed.length) {
        // Mount through the existing admission lane. On the next paint its
        // complete DOM weight is charged before it can remain retained.
        publish({ preparing: new Set(cachedClosed.map((unit) => unit.node)) });
        schedule();
      }
    }
    const label = opening
      ? openingTop > 0 || openingLocation
        ? "Preparing reading view…"
        : "Preparing first page…"
      : visiblePending
        ? "Preparing page layout…"
        : rendering
          ? "Rendering content…"
          : "";
    if (statusLabel.textContent !== label) statusLabel.textContent = label;
    status.hidden = opening || !!view.dom.closest("[data-latex-page-presentation]") || !label;
    saveReadingPosition();
  };
  const typing = () => {
    lastInput = performance.now();
    measurementRequested = false;
    schedule();
  };
  const scrolled = () => {
    const now = performance.now();
    const top = root()?.scrollTop ?? 0;
    velocity = (top - scrollTop) / Math.max(16, now - lastScroll);
    scrollTop = top;
    lastScroll = now;
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(schedule, 190);
    schedule();
  };
  const changed = (event?: Event) => {
    if (event?.target instanceof Element) {
      const element = event.target.closest<HTMLElement>("[data-latex-viewport]");
      if (element) readingWeights.delete(element);
    }
    if (
      key.getState(view.state)?.opening &&
      event?.target instanceof Element &&
      view.dom.contains(event.target)
    ) {
      const element = event.target.closest("[data-latex-viewport]");
      const member = element && memberElements.get(element);
      const cached =
        event instanceof CustomEvent &&
        event.detail?.cached &&
        member &&
        member.position() !== undefined &&
        latexViewportMeasurement(view, member.node(), member.position()!);
      if (!cached && (!member || requiredNodes.has(member.node()))) layoutReady = false;
    }
    measurementRequested = false;
    schedule();
  };
  let editorWidth = -1;
  let scrollWidth = -1;
  let scrollHeight = -1;
  const resize = new ResizeObserver((entries) => {
    let dirty = false;
    for (const entry of entries) {
      if (entry.target === view.dom && entry.contentRect.width !== editorWidth) {
        editorWidth = entry.contentRect.width;
        dirty = true;
      } else if (
        entry.target === observedRoot &&
        (entry.contentRect.width !== scrollWidth || entry.contentRect.height !== scrollHeight)
      ) {
        scrollWidth = entry.contentRect.width;
        scrollHeight = entry.contentRect.height;
        dirty = true;
      }
    }
    if (dirty) changed();
  });
  resize.observe(view.dom);
  // Mount on the capture path, before native mousedown/caret hit testing. The
  // overscan handles ordinary interaction; this covers a jump followed by a click.
  const revealAtPointer = (event: PointerEvent) => {
    if (
      !view.editable ||
      event.button > 0 ||
      (event.type === "pointermove" && !(event.buttons & 1))
    )
      return;
    if (!(event.target instanceof Element) || !view.dom.contains(event.target)) return;
    const target = event.target.closest<HTMLElement>(
      '[data-latex-viewport-closed], [data-latex-viewport="mounted"][data-latex-viewport-prepared="false"]:not([data-latex-viewport-editing="true"])',
    );
    const member = target && memberElements.get(target);
    if (!member || (member.mounted && member.node().type.name !== "paragraph")) return;
    const position = member.position();
    if (position === undefined) return;
    visible.add(member.node());
    const selectionAnchor = view.state.selection.anchor;
    const pointerBox = target!.getBoundingClientRect();
    const pointerOffset = { x: event.clientX - pointerBox.left, y: event.clientY - pointerBox.top };
    if (member.node().type.name === "paragraph" && event.type === "pointerdown") {
      // Reveal a cold prose placeholder before native caret hit testing.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position + 1)));
      view.focus();
      publish({ visible: new Set(visible), refreshNodes: new Set([member.node()]) });
    } else publish({ visible: new Set(visible) });
    if (
      event.type === "pointerdown" &&
      member.node().type.name === "latexDisplayMath" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const target = view.nodeDOM(position);
      if (target instanceof HTMLElement) {
        event.preventDefault();
        event.stopImmediatePropagation();
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            composed: true,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            isPrimary: event.isPrimary,
            button: event.button,
            buttons: event.buttons,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }
      return;
    }
    const revealed = view.nodeDOM(position);
    const nextBox = revealed instanceof HTMLElement ? revealed.getBoundingClientRect() : pointerBox;
    const hit = view.posAtCoords({
      left: nextBox.left + pointerOffset.x,
      top: nextBox.top + Math.min(nextBox.height - 1, pointerOffset.y),
    });
    if (hit && event.type === "pointerdown" && member.node().type.name === "paragraph") {
      const point = Math.max(
        position + 1,
        Math.min(position + member.node().nodeSize - 1, hit.pos),
      );
      const selection = TextSelection.between(
        view.state.doc.resolve(event.shiftKey ? selectionAnchor : point),
        view.state.doc.resolve(point),
      );
      view.dispatch(view.state.tr.setSelection(selection));
      view.focus();
      event.preventDefault();
    }
  };
  const beforePrint = () => publish({ print: true });
  const afterPrint = () => {
    publish({ print: false });
    schedule();
  };
  view.dom.addEventListener("beforeinput", typing, true);
  view.dom.addEventListener("compositionstart", typing, true);
  view.dom.addEventListener("compositionend", typing, true);
  view.dom.addEventListener("scient-latex-math-preview", changed);
  view.dom.addEventListener("scient-latex-math-ready", changed);
  view.dom.addEventListener("scient-latex-math-mounted", changed);
  view.dom.addEventListener("load", changed, true);
  view.dom.ownerDocument.addEventListener("pointerdown", revealAtPointer, true);
  view.dom.ownerDocument.addEventListener("pointermove", revealAtPointer, true);
  document.fonts?.addEventListener("loadingdone", changed);
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  const unsubscribeSpace = latexReadingCacheBudget.subscribeSpace(() => {
    if (!idleWarmCapacity) schedule();
  });
  schedule();
  return {
    context,
    readingRetention: () => retention.statistics(),
    navigate(position?: number) {
      if (key.getState(view.state)?.opening) {
        resetOpeningFrames();
        openingLocation = undefined;
        openingTop = root()?.scrollTop ?? 0;
        const unit =
          position === undefined
            ? undefined
            : documentUnits(view.state.doc).findLast(
                (unit) =>
                  unit.position <= position && position <= unit.position + unit.node.nodeSize,
              );
        const element = unit && view.nodeDOM(unit.position);
        const scroll = root();
        if (unit && element instanceof HTMLElement && scroll)
          openingLocation = {
            position: unit.position,
            signature: readingSignature(unit.node),
            offset: element.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
            top: openingTop,
          };
      }
      schedule();
    },
    reading(node: DocumentNode) {
      return (
        visited.has(node) ||
        requiredNodes.has(node) ||
        !!key.getState(view.state)?.presented.has(node)
      );
    },
    observe(member: Member) {
      observer?.observe(member.dom);
      schedule();
    },
    unobserve(member: Member) {
      observer?.unobserve(member.dom);
    },
    measured() {
      layoutReady = true;
      restoreOpening();
      measurementRequested = false;
      // Node-view attributes belong to the next ProseMirror update. Mutating
      // them here makes its DOM observer re-read native selection and force
      // layout after every preparation batch.
      schedule();
      view.dom.dispatchEvent(new CustomEvent("scient-latex-page-layout-ready"));
    },
    recorded(node: DocumentNode) {
      refreshNodes.add(node);
    },
    demand(pageDemand: ReadonlySet<DocumentNode>) {
      publish({ pageDemand });
      schedule();
    },
    pageReady(ready: boolean) {
      if (openingPagesReady === ready) return;
      openingPagesReady = ready;
      resetOpeningFrames();
      schedule();
    },
    fallback(nodes: ReadonlySet<DocumentNode>, enabled: boolean) {
      if (enabled) layoutReady = true;
      if (!enabled) {
        for (const unit of documentUnits(view.state.doc))
          if (nodes.has(unit.node)) {
            measurements.delete(unit.node);
            retained.delete(
              `${latexViewportContext(view, unit.node, unit.position)}|${sourceSignature(unit.node)}`,
            );
          }
      }
      const fallback = new Set(key.getState(view.state)?.fallback);
      for (const node of nodes)
        if (enabled) fallback.add(node);
        else fallback.delete(node);
      publish({ fallback, refreshNodes: new Set(nodes) });
      schedule();
    },
    present(presented: ReadonlySet<DocumentNode>) {
      publish({ presented });
    },
    update(previous: EditorState) {
      if (
        key.getState(view.state)?.opening &&
        previous.doc === view.state.doc &&
        !previous.selection.eq(view.state.selection)
      )
        this.navigate(view.state.selection.head);
      if (previousDocument !== view.state.doc) {
        readingAnchors.delete(view);
        anchorSettlements.get(view)?.();
        anchorSettlements.delete(view);
        previousDocument = view.state.doc;
        resetOpeningFrames();
        const viewport = key.getState(view.state);
        visible = new Set(viewport?.visible);
        preparing = new Set(viewport?.preparing);
        measurementRequested = false;
        if (
          openingLocation &&
          readingSignature(view.state.doc.nodeAt(openingLocation.position) ?? view.state.doc) !==
            openingLocation.signature
        ) {
          openingLocation = undefined;
          openingTop = root()?.scrollTop ?? 0;
        }
      }
      schedule();
    },
    destroy() {
      saveReadingPosition();
      unsubscribeSpace();
      disposed = true;
      cancel?.();
      clearTimeout(timeout);
      clearTimeout(scrollIdleTimer);
      retention.clear();
      readingAnchors.delete(view);
      anchorSettlements.get(view)?.();
      anchorSettlements.delete(view);
      status.remove();
      observer?.disconnect();
      resize.disconnect();
      observedRoot?.removeEventListener("scroll", scrolled);
      view.dom.removeEventListener("beforeinput", typing, true);
      view.dom.removeEventListener("compositionstart", typing, true);
      view.dom.removeEventListener("compositionend", typing, true);
      view.dom.removeEventListener("scient-latex-math-preview", changed);
      view.dom.removeEventListener("scient-latex-math-ready", changed);
      view.dom.removeEventListener("scient-latex-math-mounted", changed);
      view.dom.removeEventListener("load", changed, true);
      view.dom.ownerDocument.removeEventListener("pointerdown", revealAtPointer, true);
      view.dom.ownerDocument.removeEventListener("pointermove", revealAtPointer, true);
      document.fonts?.removeEventListener("loadingdone", changed);
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    },
  };
}

export const LatexViewport = Extension.create<{
  sourceContext: () => string;
  readingKey: () => string;
  onOpeningChange: (opening: boolean) => void;
}>({
  name: "latexViewport",
  addOptions() {
    return { sourceContext: () => "", readingKey: () => "", onOpeningChange: () => {} };
  },
  addProseMirrorPlugins() {
    const sourceContext = this.options.sourceContext;
    const readingKey = this.options.readingKey;
    const onOpeningChange = this.options.onOpeningChange;
    return [
      new Plugin<ViewportState>({
        key,
        state: {
          init(_config, state) {
            const all = documentUnits(state.doc);
            return {
              enabled: all.length > 24,
              opening: true,
              visible: new Set(all.slice(0, 12).map((unit) => unit.node)),
              warm: new Set(),
              preparing: new Set(),
              pinned: new Set(),
              presented: new Set(),
              pageDemand: new Set(),
              fallback: new Set(),
              print: false,
              revision: 0,
              pending: all.length > 24 ? all.length : 0,
              geometryRevisions: new Map(),
            };
          },
          apply(transaction, previous, before) {
            const update = transaction.getMeta(key) as ViewportUpdate | undefined;
            const { refreshNodes: recordedNodes, refresh, ...presentation } = update ?? {};
            const all = documentUnits(transaction.doc);
            const current = new Set(all.map((unit) => unit.node));
            let geometryRevisions = previous.geometryRevisions;
            if (transaction.docChanged || recordedNodes?.size) {
              const revisions = new Map(
                [...geometryRevisions].filter(([node]) => current.has(node)),
              );
              for (const node of recordedNodes ?? [])
                if (current.has(node)) revisions.set(node, (revisions.get(node) ?? 0) + 1);
              geometryRevisions = revisions;
            }
            const map = (values: ReadonlySet<DocumentNode>) => {
              if (!transaction.docChanged) return values;
              const mapped = new Set<DocumentNode>();
              for (const unit of documentUnits(before.doc)) {
                if (!values.has(unit.node)) continue;
                if (current.has(unit.node)) mapped.add(unit.node);
                else {
                  const node = transaction.doc.nodeAt(transaction.mapping.map(unit.position, 1));
                  if (node?.type === unit.node.type && current.has(node)) mapped.add(node);
                }
              }
              return mapped;
            };
            return {
              ...previous,
              visible: map(previous.visible),
              warm: map(previous.warm),
              preparing: map(previous.preparing),
              pinned: map(previous.pinned),
              presented: map(previous.presented),
              pageDemand: map(previous.pageDemand),
              fallback: transaction.docChanged ? new Set() : previous.fallback,
              ...presentation,
              enabled: all.length > 24,
              revision: previous.revision + (refresh ? 1 : 0),
              geometryRevisions,
            };
          },
        },
        props: {
          attributes(state) {
            return {
              "data-latex-viewport-pending": String(key.getState(state)?.pending ?? 0),
              "data-latex-opening": String(key.getState(state)?.opening ?? true),
              "aria-busy": String(key.getState(state)?.opening ?? true),
            };
          },
          decorations(state) {
            const viewport = key.getState(state);
            if (!viewport?.enabled) return null;
            return DecorationSet.create(
              state.doc,
              documentUnits(state.doc).map(({ node, position }) =>
                Decoration.node(
                  position,
                  position + node.nodeSize,
                  {
                    "data-latex-viewport": mounted(state, node, position) ? "mounted" : "closed",
                    "data-latex-viewport-fallback": String(viewport.fallback.has(node)),
                  },
                  {
                    revision: viewport.revision,
                    geometryRevision: viewport.geometryRevisions.get(node) ?? 0,
                  },
                ),
              ),
            );
          },
        },
        view(view) {
          const owner = createOwner(view, sourceContext, readingKey, onOpeningChange);
          owners.set(view, owner);
          return {
            update(_view, previous) {
              owner.update(previous);
            },
            destroy() {
              owner.destroy();
              owners.delete(view);
              members.delete(view);
            },
          };
        },
      }),
    ];
  },
});
