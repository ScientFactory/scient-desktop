/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated workers do not accept Window target origins. */
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFNumber,
  PDFString,
  PDFHexString,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import {
  PDF_EDIT_MAX_BYTES,
  PDF_EDIT_MAX_PAGES,
  type PdfEditPage,
  type PdfEditWorkerRequest,
  type PdfEditWorkerResponse,
} from "./pdfPageEdits";

const sources = new Map<string, { document: PDFDocument; bytes: Uint8Array }>();
let totalBytes = 0,
  baseSourceId: string | null = null;
const name = (value: string) => PDFName.of(value);
const lookup = (doc: PDFDocument, value: PDFObject | undefined) =>
  value ? doc.context.lookup(value) : undefined;

function namedDestination(doc: PDFDocument, target: string): PDFObject | undefined {
  const direct = lookup(doc, doc.catalog.get(name("Dests")));
  if (direct instanceof PDFDict) {
    const result = direct.get(name(target));
    if (result) return lookup(doc, result);
  }
  const names = lookup(doc, doc.catalog.get(name("Names")));
  if (!(names instanceof PDFDict)) return undefined;
  const visited = new Set<PDFObject>();
  const visit = (node: PDFObject | undefined): PDFObject | undefined => {
    if (!(node instanceof PDFDict) || visited.has(node)) return undefined;
    visited.add(node);
    const entries = lookup(doc, node.get(name("Names")));
    if (entries instanceof PDFArray)
      for (let i = 0; i + 1 < entries.size(); i += 2) {
        const key = lookup(doc, entries.get(i));
        if (
          (key instanceof PDFString || key instanceof PDFHexString) &&
          key.decodeText() === target
        )
          return lookup(doc, entries.get(i + 1));
      }
    const children = lookup(doc, node.get(name("Kids")));
    if (children instanceof PDFArray)
      for (const child of children.asArray()) {
        const found = visit(lookup(doc, child));
        if (found) return found;
      }
    return undefined;
  };
  return visit(lookup(doc, names.get(name("Dests"))));
}

function repairCopiedLinks(
  output: PDFDocument,
  source: PDFDocument,
  original: PDFPage,
  copy: PDFPage,
  targets: Map<string, PDFRef>,
) {
  const from = lookup(source, original.node.get(name("Annots")));
  const to = lookup(output, copy.node.get(name("Annots")));
  if (!(from instanceof PDFArray) || !(to instanceof PDFArray)) return;
  for (let i = 0; i < from.size(); i++) {
    const annotation = lookup(source, from.get(i)),
      copied = lookup(output, to.get(i));
    if (!(annotation instanceof PDFDict) || !(copied instanceof PDFDict)) continue;
    const action = lookup(source, annotation.get(name("A")));
    const direct = annotation.has(name("Dest"));
    if (!direct && (!(action instanceof PDFDict) || action.get(name("S")) !== name("GoTo")))
      continue;
    let destination = lookup(
      source,
      direct ? annotation.get(name("Dest")) : (action as PDFDict).get(name("D")),
    );
    if (
      destination instanceof PDFString ||
      destination instanceof PDFHexString ||
      destination instanceof PDFName
    )
      destination = namedDestination(source, destination.decodeText());
    if (destination instanceof PDFDict) destination = lookup(source, destination.get(name("D")));
    const copiedAction = lookup(output, copied.get(name("A")));
    if (!(destination instanceof PDFArray)) {
      copied.delete(name("Dest"));
      if (copiedAction instanceof PDFDict) copied.delete(name("A"));
      continue;
    }
    const pageRef = destination.get(0);
    const sourcePage =
      pageRef instanceof PDFNumber ? source.getPages()[pageRef.asNumber()]?.ref : pageRef;
    const target = sourcePage instanceof PDFRef ? targets.get(sourcePage.toString()) : undefined;
    if (!target) {
      copied.delete(name("Dest"));
      if (copiedAction instanceof PDFDict) copied.delete(name("A"));
      continue;
    }
    const rebound = output.context.obj([
      target,
      ...destination
        .asArray()
        .slice(1)
        .map((part) => lookup(source, part)!),
    ]);
    if (direct) copied.set(name("Dest"), rebound);
    else if (copiedAction instanceof PDFDict) copiedAction.set(name("D"), rebound);
  }
}

async function build(entries: readonly PdfEditPage[]) {
  const base = baseSourceId ? sources.get(baseSourceId) : null;
  if (!base) throw new Error("Reopen the PDF before editing.");
  const output = await PDFDocument.load(base.bytes, { updateMetadata: false });
  const originalPages = output.getPages(),
    used = new Set<number>();
  const prepared: (PDFPage | null)[] = entries.map((entry) => {
    if (entry.sourceId === baseSourceId && !used.has(entry.sourceIndex)) {
      used.add(entry.sourceIndex);
      return originalPages[entry.sourceIndex]!;
    }
    return null;
  });
  for (const sourceId of new Set(entries.map((entry) => entry.sourceId))) {
    if (sourceId === null) continue;
    const source = sources.get(sourceId)?.document;
    if (!source) throw new Error("An inserted PDF is unavailable.");
    let pending = entries.flatMap((entry, index) =>
      entry.sourceId === sourceId && !prepared[index] ? [index] : [],
    );
    // Each round copies unique page nodes; duplicates must not share their rotation dictionary.
    while (pending.length) {
      const seen = new Set<number>();
      const round = pending.filter((index) => {
        const n = entries[index]!.sourceIndex;
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      const copies = await output.copyPages(
        source,
        round.map((index) => entries[index]!.sourceIndex),
      );
      round.forEach((index, i) => {
        prepared[index] = copies[i]!;
      });
      const done = new Set(round);
      pending = pending.filter((index) => !done.has(index));
    }
  }
  for (let i = output.getPageCount() - 1; i >= 0; i--) output.removePage(i);
  const targetsBySource = new Map<string, Map<string, PDFRef>>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!,
      page = prepared[i] ?? output.addPage([entry.width, entry.height]);
    if (prepared[i]) output.addPage(page);
    page.setRotation(degrees(entry.rotation));
    prepared[i] = page;
    if (entry.sourceId) {
      let targets = targetsBySource.get(entry.sourceId);
      if (!targets) {
        targets = new Map();
        targetsBySource.set(entry.sourceId, targets);
      }
      const source = sources.get(entry.sourceId)!.document;
      const key = source.getPage(entry.sourceIndex).ref.toString();
      if (!targets.has(key)) targets.set(key, page.ref);
    }
  }
  // Existing catalog outlines, named destinations and attachments stay in their original context.
  const replacements = new Map<string, PDFRef>();
  originalPages.forEach((page, index) => {
    if (used.has(index)) return;
    const nearest = entries.findIndex(
      (entry) => entry.sourceId === baseSourceId && entry.sourceIndex >= index,
    );
    replacements.set(
      page.ref.toString(),
      prepared[nearest < 0 ? entries.length - 1 : nearest]!.ref,
    );
  });
  const visited = new Set<PDFObject>();
  const repair = (object: PDFObject) => {
    if (visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFArray)
      for (let i = 0; i < object.size(); i++) {
        const value = object.get(i),
          replacement = value instanceof PDFRef ? replacements.get(value.toString()) : undefined;
        if (replacement) object.set(i, replacement);
        else if (!(value instanceof PDFRef)) repair(value);
      }
    else if (object instanceof PDFDict)
      for (const [key, value] of object.entries()) {
        const replacement =
          value instanceof PDFRef ? replacements.get(value.toString()) : undefined;
        if (replacement) object.set(key, replacement);
        else if (!(value instanceof PDFRef)) repair(value);
      }
  };
  for (const [, object] of output.context.enumerateIndirectObjects()) repair(object);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.sourceId) continue;
    const original =
      entry.sourceId === baseSourceId && prepared[i] === originalPages[entry.sourceIndex];
    if (!original)
      repairCopiedLinks(
        output,
        sources.get(entry.sourceId)!.document,
        sources.get(entry.sourceId)!.document.getPage(entry.sourceIndex),
        prepared[i]!,
        targetsBySource.get(entry.sourceId)!,
      );
  }
  const bytes = await output.save({ addDefaultPage: false, updateFieldAppearances: false });
  if (bytes.byteLength > PDF_EDIT_MAX_BYTES)
    throw new Error("The PDF exceeds the 50 MB save limit.");
  return bytes;
}

async function execute(request: PdfEditWorkerRequest): Promise<PdfEditWorkerResponse> {
  if (request.kind === "load") {
    if (request.bytes.byteLength + totalBytes > PDF_EDIT_MAX_BYTES)
      throw new Error("PDF editing supports up to 50 MB of source documents per session.");
    let document: PDFDocument;
    try {
      document = await PDFDocument.load(request.bytes, { updateMetadata: false });
    } catch {
      throw new Error("Encrypted or damaged PDFs remain read-only.");
    }
    if (document.catalog.has(name("AcroForm")) || document.catalog.has(name("Perms")))
      throw new Error("PDFs with form fields or certificate signatures remain read-only.");
    if (!document.getPageCount() || document.getPageCount() > PDF_EDIT_MAX_PAGES)
      throw new Error(`Choose a PDF with 1–${PDF_EDIT_MAX_PAGES} pages.`);
    const pages = document.getPages().map((page, sourceIndex) => ({
      id: `${request.sourceId}:${sourceIndex}`,
      sourceId: request.sourceId,
      sourceIndex,
      width: page.getCropBox().width,
      height: page.getCropBox().height,
      rotation: page.getRotation().angle,
    }));
    sources.set(request.sourceId, { document, bytes: request.bytes });
    baseSourceId ??= request.sourceId;
    totalBytes += request.bytes.byteLength;
    return { id: request.id, kind: "loaded", pages };
  }
  if (!request.pages.length || request.pages.length > PDF_EDIT_MAX_PAGES)
    throw new Error("Keep between 1 and 5000 pages.");
  return { id: request.id, kind: "built", bytes: await build(request.pages) };
}
self.addEventListener("message", (event: MessageEvent<PdfEditWorkerRequest>) => {
  void execute(event.data).then(
    (result) => self.postMessage(result),
    (error: unknown) =>
      self.postMessage({
        id: event.data.id,
        kind: "error",
        message: error instanceof Error ? error.message : "The PDF operation failed.",
      } satisfies PdfEditWorkerResponse),
  );
});
