import type { EditorView } from "@tiptap/pm/view";

export interface LatexMeasurementGeometry {
  readonly root: HTMLElement;
  nodeDOM(position: number): globalThis.Node | null;
  posAtDOM(node: globalThis.Node, offset: number): number;
  sourceElement(element: HTMLElement): HTMLElement;
}

/** An inert natural-flow copy keeps measurement switches outside the live paper.
 * Clone construction yields, and the caller cancels on source/layout changes.
 * Active custom editors keep the existing measurement path until their geometry
 * can be represented without constructing another live editor.
 */
export async function createLatexMeasurementSnapshot(
  view: EditorView,
  yieldForInput: () => Promise<boolean>,
): Promise<(LatexMeasurementGeometry & { destroy(): void }) | null> {
  const original = view.dom;
  if (original.querySelector("math-field, iframe, video, audio, object, embed")) return null;
  if (original.querySelector('[data-latex-page-layout="columns"]')) return null;
  const document = original.ownerDocument;
  const style = getComputedStyle(original);
  const host = document.createElement("div");
  const paper = original.closest<HTMLElement>(".scient-latex-visual-paper");
  host.className = paper?.className ?? "scient-latex-visual-paper";
  if (paper)
    for (const attribute of paper.attributes)
      if (attribute.name.startsWith("data-")) host.setAttribute(attribute.name, attribute.value);
  host.dataset.latexMeasurementSnapshot = "true";
  host.dataset.latexMeasuring = "true";
  host.dataset.latexMeasureVisible = "true";
  host.dataset.latexColumnMeasuring = "true";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style paint;margin:0;padding:0;";
  host.style.width = style.width;
  host.style.direction = style.direction;
  host.style.writingMode = style.writingMode;
  // Paper typography and dimensions are inherited from its configured stage.
  for (const property of style)
    if (property.startsWith("--"))
      host.style.setProperty(property, style.getPropertyValue(property));
  host.lang = original.closest<HTMLElement>("[lang]")?.lang ?? document.documentElement.lang;
  const copies = new WeakMap<globalThis.Node, globalThis.Node>();
  const sources = new WeakMap<globalThis.Node, globalThis.Node>();
  const clone = (source: globalThis.Node) => {
    const copy = source.cloneNode(false);
    copies.set(source, copy);
    sources.set(copy, source);
    if (source instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement)
      copy.value = source.value;
    if (source instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      if (source.type !== "file") copy.value = source.value;
      copy.checked = source.checked;
    }
    return copy;
  };
  const root = clone(original) as HTMLElement;
  host.append(root);
  const frame = (source: globalThis.Node, copy: globalThis.Node) => ({
    source,
    copy,
    children: source.childNodes.values(),
    shadowCopied: false,
  });
  const stack = [frame(original, root)];
  let started = performance.now();
  while (stack.length) {
    const item = stack[stack.length - 1]!;
    const child = item.children.next();
    if (!child.done) {
      if (child.value instanceof HTMLElement && child.value.localName.includes("-")) return null;
      const copy = clone(child.value);
      item.copy.appendChild(copy);
      stack.push(frame(child.value, copy));
    } else if (
      !item.shadowCopied &&
      item.source instanceof HTMLElement &&
      item.copy instanceof HTMLElement &&
      item.source.shadowRoot
    ) {
      item.shadowCopied = true;
      const shadow = item.copy.attachShadow({ mode: "open" });
      shadow.adoptedStyleSheets = item.source.shadowRoot.adoptedStyleSheets;
      stack.push(frame(item.source.shadowRoot, shadow));
    } else stack.pop();
    if (performance.now() - started >= 8) {
      if (!(await yieldForInput())) return null;
      started = performance.now();
    }
  }
  // Attach once, after the copy is complete. No editable node or native selection
  // is moved, and yielding later never removes the live document's page gaps.
  document.body.append(host);
  return {
    root,
    nodeDOM(position) {
      const source = view.nodeDOM(position);
      return source ? (copies.get(source) ?? null) : null;
    },
    posAtDOM(node, offset) {
      const source = sources.get(node);
      if (!source) throw Error("Unmapped measurement snapshot node");
      return view.posAtDOM(source, offset);
    },
    sourceElement(element) {
      const source = sources.get(element);
      if (!(source instanceof HTMLElement)) throw Error("Unmapped measurement snapshot element");
      return source;
    },
    destroy() {
      host.remove();
    },
  };
}
