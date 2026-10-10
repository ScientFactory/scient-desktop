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
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { latexReferencePresentation } from "./latexEquationReferences";
import { latexTypographyKey } from "./latexTypography";

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
}

interface Unit {
  readonly node: DocumentNode;
  readonly position: number;
}

interface ViewportState {
  readonly enabled: boolean;
  readonly visible: ReadonlySet<DocumentNode>;
  readonly preparing: ReadonlySet<DocumentNode>;
  readonly pinned: ReadonlySet<DocumentNode>;
  readonly presented: ReadonlySet<DocumentNode>;
  readonly print: boolean;
  readonly revision: number;
  readonly pending: number;
  readonly geometryRevisions: ReadonlyMap<DocumentNode, number>;
}

interface ViewportUpdate {
  readonly visible?: ReadonlySet<DocumentNode>;
  readonly preparing?: ReadonlySet<DocumentNode>;
  readonly pinned?: ReadonlySet<DocumentNode>;
  readonly presented?: ReadonlySet<DocumentNode>;
  readonly print?: boolean;
  readonly refresh?: boolean;
  readonly pending?: number;
  readonly refreshNodes?: ReadonlySet<DocumentNode>;
}

const key = new PluginKey<ViewportState>("scientLatexViewport");
const units = new WeakMap<DocumentNode, readonly Unit[]>();
const unitPositions = new WeakMap<DocumentNode, ReadonlyMap<number, DocumentNode>>();
const signatures = new WeakMap<DocumentNode, string>();
const measurements = new WeakMap<DocumentNode, Map<string, ViewportMeasurement>>();
const retained = new Map<string, { measurement: ViewportMeasurement; bytes: number }>();
let retainedBytes = 0;
let fontRevision = 0;
let observedFonts: FontFaceSet | undefined;
const maximumBytes = 8 * 1024 * 1024;
const maximumEntries = 512;

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
  if (local) return local;
  const signature = `${context}|${sourceSignature(node)}`;
  const previous = retained.get(signature);
  if (!previous) return null;
  retained.delete(signature);
  retained.set(signature, previous);
  let byContext = measurements.get(node);
  if (!byContext) measurements.set(node, (byContext = new Map()));
  byContext.clear();
  byContext.set(context, previous.measurement);
  return previous.measurement;
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
  let byContext = measurements.get(node);
  if (!byContext) measurements.set(node, (byContext = new Map()));
  const previous = byContext.get(context);
  if (
    previous?.width === measurement.width &&
    previous.height === measurement.height &&
    previous.wordSpacing === measurement.wordSpacing &&
    previous.displayContentHeight === measurement.displayContentHeight &&
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
  const bytes = 2 * (signature.length + JSON.stringify(measurement).length);
  const old = retained.get(signature);
  if (old) retainedBytes -= old.bytes;
  retained.delete(signature);
  if (bytes <= maximumBytes) {
    retained.set(signature, { measurement, bytes });
    retainedBytes += bytes;
  }
  while (retained.size > maximumEntries || retainedBytes > maximumBytes) {
    const first = retained.keys().next().value!;
    retainedBytes -= retained.get(first)!.bytes;
    retained.delete(first);
  }
}

export function latexViewportClosed(view: EditorView, position: number): boolean {
  const dom = view.nodeDOM(position);
  return dom instanceof HTMLElement && dom.hasAttribute("data-latex-viewport-closed");
}

export function finishLatexViewportMeasurements(view: EditorView): void {
  owners.get(view)?.measured();
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
    viewport.preparing.has(node) ||
    viewport.pinned.has(node) ||
    viewport.presented.has(node)
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

function createOwner(view: EditorView, sourceContext: () => string) {
  if (document.fonts && observedFonts !== document.fonts) {
    observedFonts = document.fonts;
    observedFonts.addEventListener("loadingdone", () => {
      fontRevision++;
    });
  }
  let disposed = false;
  let observer: IntersectionObserver | undefined;
  let observedRoot: HTMLElement | null = null;
  let overscan = 0;
  let cancel: (() => void) | undefined;
  let contextValue = "";
  let contextReferences: ReturnType<typeof latexReferencePresentation>;
  let referenceValue = "";
  let visible = new Set<DocumentNode>();
  let lastInput = 0;
  let preparing = new Set<DocumentNode>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let measurementRequested = false;
  let refreshRequested = false;
  const refreshNodes = new Set<DocumentNode>();
  let previousDocument = view.state.doc;
  const context = () => contextValue;
  const root = () => view.dom.closest<HTMLElement>(".scient-latex-visual-scroll");
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
      (!update.preparing || same(update.preparing, previous.preparing)) &&
      (!update.pinned || same(update.pinned, previous.pinned)) &&
      (!update.presented || same(update.presented, previous.presented)) &&
      (update.pending === undefined || update.pending === previous.pending) &&
      (update.print === undefined || update.print === previous.print)
    )
      return;
    view.dispatch(view.state.tr.setMeta(key, update).setMeta("addToHistory", false));
  };
  const configure = () => {
    const scroll = root();
    if (!scroll || !view.dom.isConnected) return false;
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
      fontRevision,
    ]);
    if (nextContext !== contextValue) {
      contextValue = nextContext;
      measurementRequested = false;
      refreshRequested = true;
    }
    const nextOverscan = Math.max(500, height);
    if (scroll !== observedRoot || nextOverscan !== overscan) {
      observer?.disconnect();
      observedRoot?.removeEventListener("scroll", changed);
      if (observedRoot) resize.unobserve(observedRoot);
      observedRoot = scroll;
      overscan = nextOverscan;
      scroll.addEventListener("scroll", changed, { passive: true });
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
        { root: scroll, rootMargin: `${overscan}px 0px` },
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
    if (!viewport?.enabled) return;
    const all = documentUnits(view.state.doc);
    const currentNodes = new Set(all.map((unit) => unit.node));
    visible = new Set([...visible].filter((node) => currentNodes.has(node)));
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
    preparing = new Set(
      [...preparing].filter((node) => {
        const unit = all.find((unit) => unit.node === node);
        return unit && !latexViewportMeasurement(view, node, unit.position);
      }),
    );
    const pending = all.filter((unit) => !latexViewportMeasurement(view, unit.node, unit.position));
    // Keep DOM admission small enough to yield between paints, but amortize
    // natural-flow measurement across a bounded cohort instead of remeasuring
    // the entire document after every four newly mounted units.
    const target = Math.min(16, pending.length);
    if (preparing.size < target) {
      measurementRequested = false;
      const candidates = pending.filter((unit) => !preparing.has(unit.node));
      candidates.sort(
        (a, b) =>
          Number(visible.has(b.node) || viewport.presented.has(b.node)) -
          Number(visible.has(a.node) || viewport.presented.has(a.node)),
      );
      for (const unit of candidates.slice(0, Math.min(4, target - preparing.size)))
        preparing.add(unit.node);
      if (preparing.size < target) schedule();
    }
    publish({
      visible: new Set(visible),
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
    const preparingReady =
      [...preparing].every((node) => preparedMembers.some((member) => member.node() === node)) &&
      preparedMembers.every((member) =>
        [...member.dom.querySelectorAll(".scient-latex-math-preview")].every(
          mathReadingPreviewReady,
        ),
      );
    if (preparing.size && preparing.size >= target && preparingReady && !measurementRequested) {
      measurementRequested = true;
      view.dom.dispatchEvent(
        new CustomEvent("scient-latex-viewport-measure", {
          bubbles: true,
          detail: preparedMembers.map((member) => member.dom),
        }),
      );
    }
  };
  const typing = () => {
    lastInput = performance.now();
    measurementRequested = false;
    schedule();
  };
  const changed = () => {
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
    const closed = event.target.closest<HTMLElement>("[data-latex-viewport-closed]");
    const member = closed && memberElements.get(closed);
    if (!member) return;
    const position = member.position();
    if (position === undefined) return;
    visible.add(member.node());
    publish({ visible: new Set(visible) });
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
    const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (hit && event.type === "pointerdown" && member.node().type.name === "paragraph") {
      const selection = TextSelection.between(
        view.state.doc.resolve(event.shiftKey ? view.state.selection.anchor : hit.pos),
        view.state.doc.resolve(hit.pos),
      );
      view.dispatch(view.state.tr.setSelection(selection));
      view.focus();
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
  view.dom.ownerDocument.addEventListener("pointerdown", revealAtPointer, true);
  view.dom.ownerDocument.addEventListener("pointermove", revealAtPointer, true);
  document.fonts?.addEventListener("loadingdone", changed);
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  schedule();
  return {
    context,
    observe(member: Member) {
      observer?.observe(member.dom);
      schedule();
    },
    unobserve(member: Member) {
      observer?.unobserve(member.dom);
    },
    measured() {
      measurementRequested = false;
      // Node-view attributes belong to the next ProseMirror update. Mutating
      // them here makes its DOM observer re-read native selection and force
      // layout after every preparation batch.
      schedule();
    },
    recorded(node: DocumentNode) {
      refreshNodes.add(node);
    },
    present(presented: ReadonlySet<DocumentNode>) {
      publish({ presented });
    },
    update() {
      if (previousDocument !== view.state.doc) {
        previousDocument = view.state.doc;
        const viewport = key.getState(view.state);
        visible = new Set(viewport?.visible);
        preparing = new Set(viewport?.preparing);
        measurementRequested = false;
      }
      schedule();
    },
    destroy() {
      disposed = true;
      cancel?.();
      clearTimeout(timeout);
      observer?.disconnect();
      resize.disconnect();
      observedRoot?.removeEventListener("scroll", changed);
      view.dom.removeEventListener("beforeinput", typing, true);
      view.dom.removeEventListener("compositionstart", typing, true);
      view.dom.removeEventListener("compositionend", typing, true);
      view.dom.removeEventListener("scient-latex-math-preview", changed);
      view.dom.ownerDocument.removeEventListener("pointerdown", revealAtPointer, true);
      view.dom.ownerDocument.removeEventListener("pointermove", revealAtPointer, true);
      document.fonts?.removeEventListener("loadingdone", changed);
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    },
  };
}

export const LatexViewport = Extension.create<{ sourceContext: () => string }>({
  name: "latexViewport",
  addOptions() {
    return { sourceContext: () => "" };
  },
  addProseMirrorPlugins() {
    const sourceContext = this.options.sourceContext;
    return [
      new Plugin<ViewportState>({
        key,
        state: {
          init(_config, state) {
            const all = documentUnits(state.doc);
            return {
              enabled: all.length > 24,
              visible: new Set(all.slice(0, 12).map((unit) => unit.node)),
              preparing: new Set(),
              pinned: new Set(),
              presented: new Set(),
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
              preparing: map(previous.preparing),
              pinned: map(previous.pinned),
              presented: map(previous.presented),
              ...presentation,
              enabled: all.length > 24,
              revision: previous.revision + (refresh ? 1 : 0),
              geometryRevisions,
            };
          },
        },
        props: {
          attributes(state) {
            return { "data-latex-viewport-pending": String(key.getState(state)?.pending ?? 0) };
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
                  { "data-latex-viewport": mounted(state, node, position) ? "mounted" : "closed" },
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
          const owner = createOwner(view, sourceContext);
          owners.set(view, owner);
          return {
            update() {
              owner.update();
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
