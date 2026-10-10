import type { EditorView } from "@tiptap/pm/view";

/** An inline TeX column break takes effect after its rendered line, not at its character. */
export function latexInlineColumnBreakPositions(view: EditorView): number[] {
  const positions = new Set<number>();
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== "latexInlineCommand" || node.attrs.name !== "columnbreak") return;
    const wrapper = view.nodeDOM(position);
    if (!(wrapper instanceof HTMLElement)) return;
    const marker = wrapper.matches(".scient-latex-inline-column-break")
      ? wrapper
      : wrapper.querySelector<HTMLElement>(".scient-latex-inline-column-break");
    const paragraph = wrapper.closest("p");
    const columns = wrapper.closest('.scient-latex-page-layout[data-layout="columns"]');
    const content = columns?.querySelector<HTMLElement>(
      ":scope > .scient-latex-page-layout-body > [data-node-view-content-react]",
    );
    if (!marker || !paragraph || !content) return;
    const box = marker.getBoundingClientRect();
    if (box.height === 0) return;
    const bounds = content.getBoundingClientRect();
    const computed = getComputedStyle(content);
    const count = Math.max(1, Number.parseInt(computed.columnCount, 10) || 1);
    const scale = bounds.width / (Number.parseFloat(computed.width) || content.offsetWidth);
    if (!Number.isFinite(scale) || scale <= 0 || bounds.width <= 0) return;
    const gap = (Number.parseFloat(computed.columnGap) || 0) * scale;
    const stride = (bounds.width + gap) / count;
    const column = (left: number) => Math.floor((left - bounds.left + 0.5 * scale) / stride);
    const sameLine = (rect: DOMRect) => {
      // A tall inline formula or a smaller text mark can share the baseline
      // without sharing the marker's vertical center. Compare their overlap.
      const overlap = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
      return (
        column(rect.left) === column(box.left) && overlap > Math.min(rect.height, box.height) * 0.5
      );
    };
    const resolved = view.state.doc.resolve(position);
    let next = resolved.end();
    const range = paragraph.ownerDocument.createRange();
    const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
      acceptNode(text) {
        const excluded = text.parentElement?.closest('[contenteditable="false"]');
        return wrapper.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING &&
          !(excluded && paragraph.contains(excluded))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let text: globalThis.Node | null;
    while ((text = walker.nextNode())) {
      const length = text.textContent?.length ?? 0;
      range.selectNodeContents(text);
      const following = [...range.getClientRects()].find(
        (rect) => rect.height > 0 && rect.width > 0 && !sameLine(rect),
      );
      if (!following) continue;
      // Find the first character on the following line within this text run.
      let low = 0,
        high = length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        range.setStart(text, middle);
        range.setEnd(text, Math.min(length, middle + 1));
        if (sameLine(range.getBoundingClientRect())) low = middle + 1;
        else high = middle;
      }
      // Leave a hanging wrap space on the preceding line instead of indenting
      // the continuation with that space after inserting the break widget.
      while (low < length && /[\t\r\n ]/u.test(text.textContent?.[low] ?? "")) low++;
      next = Math.min(next, view.posAtDOM(text, low));
      break;
    }
    // A formula or other inline atom can also begin the following line.
    resolved.parent.forEach((child, offset) => {
      const at = resolved.start() + offset;
      if (child.isText || at <= position || at >= next) return;
      const dom = view.nodeDOM(at);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      if (rect.height > 0 && !sameLine(rect)) next = at;
    });
    if (next > position) positions.add(next);
  });
  return [...positions].sort((a, b) => a - b);
}
