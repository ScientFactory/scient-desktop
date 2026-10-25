import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";

type PdfPageLabel = {
  readonly style: PDFName | undefined;
  readonly prefix: PDFString | PDFHexString | undefined;
  readonly number: number;
};

const name = (value: string) => PDFName.of(value);
const invalidLabels = () => new Error("The PDF's page labels could not be preserved.");

export function readPdfPageLabels(document: PDFDocument): readonly PdfPageLabel[] | null {
  if (!document.catalog.has(name("PageLabels"))) return null;
  const ranges = new Map<number, PdfPageLabel>();
  const visited = new Set<PDFDict>();
  const count = document.getPageCount();
  const pending = [document.catalog.lookup(name("PageLabels"))];
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || visited.has(node)) throw invalidLabels();
    visited.add(node);
    const children = node.lookup(name("Kids"));
    if (children !== undefined) {
      if (!(children instanceof PDFArray)) throw invalidLabels();
      for (let i = 0; i < children.size(); i++) pending.push(children.lookup(i));
    }
    const entries = node.lookup(name("Nums"));
    if (entries === undefined) continue;
    if (!(entries instanceof PDFArray) || entries.size() % 2 !== 0) throw invalidLabels();
    for (let i = 0; i < entries.size(); i += 2) {
      const key = entries.lookup(i);
      const label = entries.lookup(i + 1);
      if (!(key instanceof PDFNumber) || !(label instanceof PDFDict)) throw invalidLabels();
      const index = key.asNumber();
      if (!Number.isInteger(index) || index < 0 || index >= count || ranges.has(index))
        throw invalidLabels();
      const style = label.lookup(name("S"));
      const prefix = label.lookup(name("P"));
      const start = label.lookup(name("St"));
      const type = label.lookup(name("Type"));
      if (type !== undefined && type !== name("PageLabel")) throw invalidLabels();
      if (
        style !== undefined &&
        (!(style instanceof PDFName) || !["D", "R", "r", "A", "a"].includes(style.decodeText()))
      )
        throw invalidLabels();
      if (
        prefix !== undefined &&
        !(prefix instanceof PDFString) &&
        !(prefix instanceof PDFHexString)
      )
        throw invalidLabels();
      if (start !== undefined && !(start instanceof PDFNumber)) throw invalidLabels();
      const number = start?.asNumber() ?? 1;
      if (!Number.isSafeInteger(number) || number < 1) throw invalidLabels();
      ranges.set(index, { style, prefix, number });
    }
  }
  const first = ranges.get(0);
  if (!first) throw invalidLabels();
  let current = first;
  let rangeStart = 0;
  return Array.from({ length: count }, (_, index) => {
    const range = ranges.get(index);
    if (range) {
      current = range;
      rangeStart = index;
    }
    const number = current.number + index - rangeStart;
    if (!Number.isSafeInteger(number)) throw invalidLabels();
    return { ...current, number };
  });
}

export function writePdfPageLabels(
  document: PDFDocument,
  labels: readonly (PdfPageLabel | null)[],
) {
  if (labels.every((label) => label === null)) {
    document.catalog.delete(name("PageLabels"));
    return;
  }
  const entries = document.context.obj([]);
  let previous: PdfPageLabel | undefined;
  labels.forEach((sourceLabel, index) => {
    const label = sourceLabel ?? { style: name("D"), prefix: undefined, number: index + 1 };
    const continues =
      previous &&
      label.style === previous.style &&
      label.prefix?.decodeText() === previous.prefix?.decodeText() &&
      (!label.style || label.number === previous.number + 1);
    if (!continues) {
      const range = document.context.obj({});
      if (label.style) {
        range.set(name("S"), label.style);
        range.set(name("St"), PDFNumber.of(label.number));
      }
      if (label.prefix) range.set(name("P"), label.prefix);
      entries.push(PDFNumber.of(index));
      entries.push(range);
    }
    previous = label;
  });
  // ISO 32000-1 §12.4.2 keys label ranges by physical page index, including index zero.
  document.catalog.set(name("PageLabels"), document.context.obj({ Nums: entries }));
}
