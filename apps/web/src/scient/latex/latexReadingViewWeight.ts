/** Admission estimate, not JS heap or physical RAM. Include shadow formula
 * markup and source attributes, which ProseMirror nodeSize does not count. */
export function latexReadingViewWeight(element: Element, sourceBytes: number): number {
  let bytes = sourceBytes + 1024;
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) bytes += 64 + (node.textContent?.length ?? 0) * 2;
    if (node instanceof Element) {
      bytes += 256;
      for (const attribute of node.attributes)
        bytes += 32 + (attribute.name.length + attribute.value.length) * 2;
      if (node.shadowRoot) visit(node.shadowRoot);
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return bytes;
}
