/** A noninteractive snapshot of the rendered paper, never another editor. */
export function latexPagePreviewStyles(document: Document) {
  const sheet = new CSSStyleSheet();
  const rules: string[] = ["*,::before,::after { box-sizing: border-box; }"];
  for (const source of document.styleSheets) {
    try {
      for (const rule of source.cssRules) {
        if (/scient-latex|\.ML__|\.katex|@font-face/u.test(rule.cssText)) rules.push(rule.cssText);
      }
    } catch {
      // Cross-origin sheets are not needed for the bundled document renderer.
    }
  }
  sheet.replaceSync(rules.join("\n"));
  return sheet;
}

function snapshotNode(source: Node): Node {
  if (!(source instanceof Element)) return source.cloneNode(false);
  const readingMath = source.classList.contains("scient-latex-math-preview");
  if (readingMath && source.hasAttribute("hidden")) return source.ownerDocument.createTextNode("");
  if (source.tagName === "MATH-FIELD" || readingMath) {
    const clone = source.ownerDocument.createElement("span");
    const formula = source.shadowRoot?.querySelector(".ML__latex,[data-math-preview-content]");
    const style = getComputedStyle(source);
    clone.style.cssText = `display:inline-block;vertical-align:baseline;width:${source.clientWidth}px;height:${source.clientHeight}px;`;
    clone.style.fontSize = style.fontSize;
    clone.style.color = style.color;
    clone.style.direction = "ltr";
    if (formula) clone.append(snapshotNode(formula));
    return clone;
  }
  const clone = source.cloneNode(false) as Element;
  if (
    clone instanceof HTMLElement &&
    (clone.tagName === "P" || clone.classList.contains("scient-latex-visual-display-math"))
  )
    clone.style.contentVisibility = "visible";
  for (const attribute of [
    "id",
    "contenteditable",
    "tabindex",
    "autofocus",
    "data-selected",
    "data-document-selected",
    "data-latex-context-root",
    "data-reference-highlight",
    "data-math-viewport-active",
    "data-scient-active-slot",
    "data-scient-selection-active",
    "data-scient-selection-overlay",
    "data-scient-selection-held",
    "data-scient-editing-guides",
    "data-scient-accent-body",
    "data-guide-active",
    "data-guide-current",
    "data-guide-top",
    "data-guide-bottom",
    "data-guide-left",
    "data-guide-right",
    "data-table-guides",
  ])
    clone.removeAttribute(attribute);
  clone.classList.remove(
    "ProseMirror-selectednode",
    "selectedCell",
    "ML__selected",
    "ML__contains-caret",
  );
  for (const child of source.childNodes) {
    if (
      child instanceof Element &&
      child.matches(
        "script,style,.ML__caret,.ML__text-caret,.ML__selection,[data-scient-math-caret-anchor],.scient-latex-longtable-measurements,.scient-latex-table-guides,.scient-latex-selection-overlay",
      )
    )
      continue;
    clone.append(snapshotNode(child));
  }
  if (source instanceof HTMLInputElement && clone instanceof HTMLInputElement)
    clone.value = source.value;
  if (source instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement)
    clone.value = source.value;
  if (source instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement) {
    clone.getContext("2d")?.drawImage(source, 0, 0);
  }
  return clone;
}

export function measureLatexPagePreview(stage: HTMLElement) {
  const paper = stage.querySelector<HTMLElement>(".scient-latex-visual-paper");
  const document = paper?.querySelector<HTMLElement>(".scient-latex-visual-document");
  if (!paper || !document || stage.clientWidth <= 0) return null;
  const bounds = paper.getBoundingClientRect();
  const scale = bounds.width / stage.clientWidth;
  if (scale <= 0) return null;
  const blocks = Array.from(document.children)
    .filter((element) => !element.matches(".scient-latex-pagination-gap"))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        element,
        top: (rect.top - bounds.top) / scale,
        left: (rect.left - bounds.left) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
      };
    });
  const variables: [string, string][] = [];
  const computed = getComputedStyle(stage);
  for (const name of computed)
    if (name.startsWith("--scient-") || name.startsWith("--font-"))
      variables.push([name, computed.getPropertyValue(name)]);
  return { stage, paper, document, blocks, variables };
}

/** Copy only blocks intersecting this physical page; crop continuations in place. */
export function drawLatexPagePreview(
  target: ShadowRoot,
  measured: NonNullable<ReturnType<typeof measureLatexPagePreview>>,
  page: number,
  width: number,
  height: number,
  gap: number,
) {
  const pageTop = (page - 1) * (height + gap);
  const stage = measured.stage.cloneNode(false) as HTMLElement;
  stage.style.transform = `scale(${132 / width})`;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.transformOrigin = "top left";
  stage.style.pointerEvents = "none";
  for (const [name, value] of measured.variables) stage.style.setProperty(name, value);
  const paper = measured.paper.cloneNode(false) as HTMLElement;
  paper.style.minHeight = `${height}px`;
  paper.style.height = `${height}px`;
  paper.style.overflow = "hidden";
  const sheet = measured.paper.querySelectorAll<HTMLElement>(".scient-latex-page-sheet")[page - 1];
  if (sheet) {
    const stack = measured.paper.ownerDocument.createElement("div");
    stack.className = "scient-latex-page-stack";
    const clone = snapshotNode(sheet) as HTMLElement;
    clone.style.top = "0";
    stack.append(clone);
    paper.append(stack);
  }
  const document = measured.document.cloneNode(false) as HTMLElement;
  document.removeAttribute("contenteditable");
  document.removeAttribute("id");
  document.removeAttribute("data-latex-measuring");
  document.removeAttribute("data-latex-windowed");
  document.style.cssText = `position:absolute;inset:0;padding:0;margin:0;width:${width}px;min-height:0;height:${height}px;`;
  for (const block of measured.blocks) {
    if (block.top + block.height <= pageTop || block.top >= pageTop + height) continue;
    const clone = snapshotNode(block.element) as HTMLElement;
    clone.style.position = "absolute";
    clone.style.top = `${block.top - pageTop}px`;
    clone.style.left = `${block.left}px`;
    clone.style.width = `${block.width}px`;
    clone.style.margin = "0";
    document.append(clone);
  }
  paper.append(document);
  stage.append(paper);
  target.replaceChildren(stage);
}
