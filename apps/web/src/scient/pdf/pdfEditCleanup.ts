import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDict,
  type PDFDocument,
  PDFName,
  type PDFObject,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";

const name = (value: string) => PDFName.of(value);
// A name operand followed by the Do operator. Matches inside strings too, which only keeps more.
const INVOKED_XOBJECT = /\/([^\s()<>[\]{}/%]+)\s*Do(?=[\s()<>[\]{}/%]|$)/gu;

/** The page's content streams as text, or null when any part cannot be decoded. */
function pageContent(document: PDFDocument, page: PDFPage) {
  const contents = document.context.lookup(page.node.get(name("Contents")));
  const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const decoder = new TextDecoder("latin1");
  const texts: string[] = [];
  for (const part of parts) {
    const stream = document.context.lookup(part);
    try {
      if (stream instanceof PDFRawStream)
        texts.push(decoder.decode(decodePDFRawStream(stream).decode()));
      else if (stream instanceof PDFContentStream)
        texts.push(decoder.decode(stream.getUnencodedContents()));
      else return null;
    } catch {
      return null;
    }
  }
  // A content array may split an operand from its operator between parts.
  return texts.join("\n");
}

/** Old Type 3 fonts without their own resources draw with the page's, so keep those intact. */
function hasType3FontUsingPageResources(document: PDFDocument, resources: PDFDict) {
  const fonts = resources.lookup(name("Font"));
  if (!(fonts instanceof PDFDict)) return false;
  return fonts.entries().some(([, entry]) => {
    const font = document.context.lookup(entry);
    return (
      font instanceof PDFDict &&
      font.get(name("Subtype")) === name("Type3") &&
      !font.has(name("Resources"))
    );
  });
}

/**
 * Pages often share one resource dictionary listing every image and form in
 * the document. Give each page its own list of only the XObjects its content
 * draws, so a deleted page's images and forms become unreachable.
 */
export function keepOnlyDrawnXObjects(document: PDFDocument) {
  for (const page of document.getPages()) {
    const resources = page.node.Resources();
    const xobjects = resources?.lookup(name("XObject"));
    if (!resources || !(xobjects instanceof PDFDict)) continue;
    if (hasType3FontUsingPageResources(document, resources)) continue;
    const content = pageContent(document, page);
    if (content === null) continue;
    const drawn = new Set<PDFName>();
    for (const [, operand] of content.matchAll(INVOKED_XOBJECT)) {
      drawn.add(name(operand!));
      // pdf-lib decodes only uppercase #xx escapes; match either spelling.
      drawn.add(
        name(operand!.replace(/#([\da-f]{2})/giu, (_, hex: string) => `#${hex.toUpperCase()}`)),
      );
    }
    const entries = xobjects.entries();
    const kept = entries.filter(([key]) => drawn.has(key));
    if (kept.length === entries.length) continue;
    const ownXObjects = document.context.obj({});
    for (const [key, value] of kept) ownXObjects.set(key, value);
    const ownResources = resources.clone(document.context);
    ownResources.set(name("XObject"), ownXObjects);
    page.node.set(name("Resources"), ownResources);
  }
}

/**
 * pdf-lib serializes every object it has ever loaded, so a deleted page's
 * content would stay readable in the saved bytes. Keep only what the trailer
 * still reaches.
 */
export function removeUnreachableObjects(document: PDFDocument) {
  const context = document.context;
  const reachable = new Set<string>();
  const pending: PDFObject[] = [];
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  for (const entry of [Root, Info, Encrypt, ID]) if (entry) pending.push(entry);
  while (pending.length) {
    const object = pending.pop()!;
    if (object instanceof PDFRef) {
      const key = object.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = context.lookup(object);
      if (target) pending.push(target);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) pending.push(value);
    } else if (object instanceof PDFArray) {
      pending.push(...object.asArray());
    } else if (object instanceof PDFStream) {
      pending.push(object.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects())
    if (!reachable.has(ref.toString())) context.delete(ref);
}

/**
 * A copied page joins no structure tree, so neither it nor anything it draws
 * (forms, images, annotations) may claim entries in one. Run on freshly copied
 * pages only: everything they reach is then owned by the copy.
 */
export function detachCopiedStructure(document: PDFDocument, page: PDFPage) {
  if (page.node.get(name("Tabs")) === name("S")) page.node.delete(name("Tabs"));
  const visited = new Set<PDFObject>();
  const pending: PDFObject[] = [page.node];
  while (pending.length) {
    const object = pending.pop()!;
    if (visited.has(object)) continue;
    visited.add(object);
    if (object instanceof PDFRef) {
      const target = document.context.lookup(object);
      if (target) pending.push(target);
      continue;
    }
    const dict = object instanceof PDFStream ? object.dict : object;
    if (dict instanceof PDFDict) {
      dict.delete(name("StructParents"));
      dict.delete(name("StructParent"));
      for (const [, value] of dict.entries()) pending.push(value);
    } else if (dict instanceof PDFArray) {
      pending.push(...dict.asArray());
    }
  }
}
