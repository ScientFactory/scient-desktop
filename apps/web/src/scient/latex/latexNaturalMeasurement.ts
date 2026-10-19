import type { EditorView } from "@tiptap/pm/view";

const hosts = new WeakMap<EditorView, HTMLElement>();
const previewStyles = new Map<string, string>();
export function resetNaturalMeasurement(view: EditorView) {
  hosts.get(view)?.remove();
  hosts.delete(view);
}

export interface NaturalLine {
  readonly from: number;
  readonly top: number;
  readonly bottom: number;
}

/** Find line starts with logarithmic searches, including wrapped runs inside formatting marks. */
export function naturalTextLines(
  text: globalThis.Node,
  range: Range,
): { offset: number; top: number; bottom: number; right: number }[] {
  const length = text.textContent?.length ?? 0;
  if (!length) return [];
  range.selectNodeContents(text);
  const rectangles = [...range.getClientRects()].filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  let start = 0;
  return rectangles.flatMap((rect) => {
    let low = start,
      high = length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      range.setStart(text, middle);
      range.setEnd(text, Math.min(length, middle + 1));
      if (range.getBoundingClientRect().top < rect.top - 0.5) low = middle + 1;
      else high = middle;
    }
    start = low;
    return start < length
      ? [{ offset: start, top: rect.top, bottom: rect.bottom, right: rect.right }]
      : [];
  });
}

/** Read natural content without page gaps, admitting fields or changing selection. */
export function measureNatural<T>(
  view: EditorView,
  original: HTMLElement,
  measure: (
    copy: HTMLElement,
    sourceAt: (node: globalThis.Node, offset: number) => number,
    copied: (element: Element) => HTMLElement | undefined,
  ) => T,
  live = false,
): T {
  if (live) {
    const read = () =>
      measure(
        original,
        (node, offset) => view.posAtDOM(node, offset),
        (element) => (element instanceof HTMLElement ? element : undefined),
      );
    const selection = original.ownerDocument.getSelection();
    if (
      selection?.isCollapsed &&
      original.contains(selection.anchorNode) &&
      original.checkVisibility?.({ contentVisibilityAuto: true }) === true
    )
      return read();
    const observer = (view as EditorView & { domObserver: { stop(): void; start(): void } })
      .domObserver;
    const visibility = original.style.contentVisibility;
    observer.stop();
    try {
      original.style.contentVisibility = "visible";
      return read();
    } finally {
      if (visibility) original.style.contentVisibility = visibility;
      else original.style.removeProperty("content-visibility");
      observer.start();
    }
  }
  const document = original.ownerDocument;
  const positions = new WeakMap<globalThis.Node, number>();
  const copies = new WeakMap<Element, HTMLElement>();
  const scale = view.dom.getBoundingClientRect().width / (view.dom.offsetWidth || 1);
  const properties = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-indent",
    "text-align",
    "white-space",
    "direction",
    "unicode-bidi",
    "vertical-align",
  ];
  const clone = (node: globalThis.Node): globalThis.Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = document.createTextNode(node.textContent ?? "");
      try {
        positions.set(text, view.posAtDOM(node, 0));
      } catch {
        /* Atom captions have no document text offsets. */
      }
      return text;
    }
    if (
      !(node instanceof HTMLElement || node instanceof SVGElement) ||
      node.matches(".scient-latex-pagination-gap,.scient-latex-table-page-gap,[data-paged-repeat]")
    )
      return null;
    const atom = node.matches("math-field,.scient-latex-math-preview,img,canvas,svg");
    const copy = document.createElement(
      atom ? "span" : node.tagName.includes("-") ? "div" : node.tagName,
    );
    copies.set(node, copy);
    if (node.matches(".node-latexInlineMath,[data-paged-passive-root=macro]")) {
      try {
        positions.set(copy, view.posAtDOM(node, 0));
      } catch {
        /* A detached view cannot contribute a document line boundary. */
      }
    }
    for (const attr of node.attributes)
      if (
        attr.name !== "contenteditable" &&
        attr.name !== "id" &&
        (!attr.name.startsWith("data-paged") ||
          attr.name === "data-paged-measurement" ||
          attr.name === "data-paged-passive-root")
      )
        copy.setAttribute(attr.name, attr.value);
    // Tags, classes and authored inline styles preserve descendant formatting.
    // Only the detached root and atoms need their inherited browser typography captured.
    if (
      node === original ||
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement
    ) {
      const style = getComputedStyle(node);
      for (const property of properties)
        copy.style.setProperty(property, style.getPropertyValue(property));
    }
    if (node.matches(".scient-paged-line,.scient-paged-part")) {
      copy.style.removeProperty("top");
      copy.style.removeProperty("left");
      copy.style.removeProperty("transform");
    }
    copy.style.removeProperty("--scient-paged-top");
    copy.style.removeProperty("--scient-paged-left");
    copy.style.removeProperty("--scient-paged-display-shrink");
    copy.style.removeProperty("--scient-paged-flow-offset");
    copy.classList.remove("scient-paged-line", "scient-paged-part");
    if (node instanceof HTMLTextAreaElement && node.closest("figcaption")) {
      // A detached flex caption must retain the field's actual intrinsic size;
      // otherwise field-sizing can reserve an extra line above a longtable.
      const bounds = node.getBoundingClientRect();
      copy.style.width = `${bounds.width / scale}px`;
      copy.style.height = `${bounds.height / scale}px`;
      copy.style.setProperty("field-sizing", "fixed");
    }
    if (atom) {
      if (node.matches(".scient-latex-math-preview") && node.shadowRoot) {
        // Static MathLive markup retains its baseline without constructing an editable field.
        const shadow = copy.attachShadow({ mode: "open" });
        shadow.adoptedStyleSheets = node.shadowRoot.adoptedStyleSheets;
        for (const child of node.shadowRoot.childNodes) {
          if (child instanceof HTMLStyleElement) {
            const original = child.textContent ?? "";
            let css = previewStyles.get(original);
            if (css === undefined) {
              css = original.replace(/@font-face\s*\{[^}]*\}/gu, "");
              if (previewStyles.size >= 4) previewStyles.clear();
              previewStyles.set(original, css);
            }
            // Match passive reading views: shared adopted sheets couple later
            // style invalidation to every formula that adopted the sheet.
            const style = document.createElement("style");
            style.textContent = css;
            shadow.append(style);
          } else shadow.append(child.cloneNode(true));
        }
        return copy;
      }
      const bounds = node.getBoundingClientRect();
      Object.assign(copy.style, {
        display: getComputedStyle(node).display === "block" ? "block" : "inline-block",
        width: `${bounds.width / scale}px`,
        height: `${bounds.height / scale}px`,
      });
      return copy;
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
      copy.textContent = node.value;
    else
      for (const child of node.childNodes) {
        const next = clone(child);
        if (next) copy.append(next);
      }
    return copy;
  };
  const copy = clone(original) as HTMLElement;
  for (const root of copy.querySelectorAll("[data-paged-passive-root]")) root.normalize();
  let host = hosts.get(view);
  if (!host) {
    host = document.createElement("div");
    host.className = "scient-latex-visual-document scient-latex-visual-paper";
    host.dataset.paged = "true";
    host.inert = true;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:strict;height:0;margin:0;padding:0;min-height:0;";
    const documentStyle = getComputedStyle(view.dom);
    for (let index = 0; index < documentStyle.length; index++) {
      const name = documentStyle[index]!;
      if (name.startsWith("--")) host.style.setProperty(name, documentStyle.getPropertyValue(name));
    }
    hosts.set(view, host);
    document.body.append(host);
  }
  host.lang = original.closest<HTMLElement>("[lang]")?.lang ?? "";
  const sourceStyle = getComputedStyle(original);
  copy.style.display = sourceStyle.display;
  // Scoped declarations live on ancestors outside the cloned block. Preserve
  // their inherited values so measuring a table/group uses its actual skips.
  for (let index = 0; index < sourceStyle.length; index++) {
    const name = sourceStyle[index]!;
    if (
      name.startsWith("--scient-latex-") &&
      sourceStyle.getPropertyValue(name) !== host.style.getPropertyValue(name)
    )
      copy.style.setProperty(name, sourceStyle.getPropertyValue(name));
  }
  copy.style.position = "static";
  copy.style.width = `${original.getBoundingClientRect().width / scale}px`;
  copy.style.height = "auto";
  copy.style.margin = "0";
  copy.style.contentVisibility = "visible";
  // Skipping ink and revealing a block must keep its child margins inside the same box.
  copy.style.contain =
    sourceStyle.contentVisibility === "auto" ||
    /(?:layout|strict|content)/u.test(sourceStyle.contain) ||
    sourceStyle.position === "absolute"
      ? "layout style"
      : "none";
  copy.style.fontFamily = sourceStyle.fontFamily;
  copy.style.fontSize = sourceStyle.fontSize;
  copy.style.lineHeight = sourceStyle.lineHeight;
  host.style.width = copy.style.width;
  host.append(copy);
  try {
    return measure(
      copy,
      (node, offset) => {
        const position = positions.get(node);
        if (position === undefined) throw new Error("Unmapped natural measurement text");
        return position + offset;
      },
      (element) => copies.get(element),
    );
  } finally {
    copy.remove();
  }
}
