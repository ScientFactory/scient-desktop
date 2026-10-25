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
// Every name token, wherever it appears: in operands, strings, comments or inline image
// data. Over-counting only keeps more; missing a drawn XObject would break the page.
const NAME_TOKEN = /\/([^\0\t\n\f\r ()<>[\]{}/%]*)/gu;

/** One character per byte, so raw high-byte names keep their exact value. */
function byteString(bytes: Uint8Array) {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return text;
}

/** A content stream's text, or null when it cannot be decoded faithfully. */
function streamText(stream: PDFObject | undefined) {
  try {
    if (stream instanceof PDFRawStream) {
      // pdf-lib ignores decode parameters such as predictors, and cannot read external files.
      if (stream.dict.has(name("DecodeParms")) || stream.dict.has(name("F"))) return null;
      return byteString(decodePDFRawStream(stream).decode());
    }
    if (stream instanceof PDFContentStream) return byteString(stream.getUnencodedContents());
  } catch {
    // Undecodable content leaves its resources untouched.
  }
  return null;
}

/** The text of every part of a page's content, or null when any part cannot be read. */
function contentParts(document: PDFDocument, contents: PDFObject | undefined) {
  const value = document.context.lookup(contents);
  const parts = value instanceof PDFArray ? value.asArray() : value ? [value] : [];
  const texts: string[] = [];
  for (const part of parts) {
    const text = streamText(document.context.lookup(part));
    if (text === null) return null;
    texts.push(text);
  }
  return texts;
}

/**
 * Appearance streams without resources of their own, which older PDFs let draw
 * with the page's. Null when one cannot be read.
 */
function appearancesUsingPageResources(document: PDFDocument, page: PDFPage) {
  const texts: string[] = [];
  const annotations = page.node.lookup(name("Annots"));
  if (!(annotations instanceof PDFArray)) return texts;
  for (const entry of annotations.asArray()) {
    const annotation = document.context.lookup(entry);
    const appearances = annotation instanceof PDFDict ? annotation.lookup(name("AP")) : undefined;
    if (!(appearances instanceof PDFDict)) continue;
    for (const [, value] of appearances.entries()) {
      const appearance = document.context.lookup(value);
      // An appearance is a stream, or a dictionary of streams, one per state.
      const streams =
        appearance instanceof PDFDict
          ? appearance.entries().map(([, state]) => document.context.lookup(state))
          : [appearance];
      for (const stream of streams) {
        if (!(stream instanceof PDFStream) || stream.dict.has(name("Resources"))) continue;
        const text = streamText(stream);
        if (text === null) return null;
        texts.push(text);
      }
    }
  }
  return texts;
}

/** Names in content split into parts, read both as one joined stream and part by part. */
function namesIn(texts: readonly string[]) {
  const names = new Set<PDFName>();
  for (const text of [texts.join(""), ...texts])
    for (const [, token] of text.matchAll(NAME_TOKEN)) {
      names.add(name(token!));
      // pdf-lib decodes only uppercase #xx escapes; match either spelling.
      names.add(
        name(token!.replace(/#([\da-f]{2})/giu, (_, hex: string) => `#${hex.toUpperCase()}`)),
      );
    }
  return names;
}

const isForm = (object: PDFObject | undefined): object is PDFStream =>
  object instanceof PDFStream && object.dict.get(name("Subtype")) === name("Form");

/** Old Type 3 fonts without their own resources draw with the caller's, so keep those intact. */
function hasType3FontUsingCallerResources(document: PDFDocument, resources: PDFDict) {
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
 * Names drawn in a resource scope, including by forms without resources of
 * their own, which draw with this scope's. Null when some content is unreadable.
 */
function namesDrawnIn(document: PDFDocument, xobjects: PDFDict, texts: readonly string[]) {
  const names = namesIn(texts);
  const pending = [...names];
  const seen = new Set<PDFName>();
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const xobject = document.context.lookup(xobjects.get(key));
    if (!isForm(xobject) || xobject.dict.has(name("Resources"))) continue;
    const text = streamText(xobject);
    if (text === null) return null;
    for (const found of namesIn([text]))
      if (!names.has(found)) {
        names.add(found);
        pending.push(found);
      }
  }
  return names;
}

/**
 * The scope's resources listing only the XObjects its content draws: the same
 * dictionary when nothing is unused, otherwise a copy. Drawn forms with their
 * own resources are narrowed in place, which holds wherever they are drawn
 * because a form's content is the same everywhere.
 */
function narrowResources(
  document: PDFDocument,
  resources: PDFDict,
  texts: readonly string[],
  narrowedForms: Set<PDFStream>,
): PDFDict {
  const xobjects = resources.lookup(name("XObject"));
  if (!(xobjects instanceof PDFDict) || hasType3FontUsingCallerResources(document, resources))
    return resources;
  const drawn = namesDrawnIn(document, xobjects, texts);
  if (drawn === null) return resources;
  const entries = xobjects.entries();
  for (const [key, value] of entries) {
    const form = document.context.lookup(value);
    if (!drawn.has(key) || !isForm(form) || narrowedForms.has(form)) continue;
    narrowedForms.add(form);
    const own = form.dict.lookup(name("Resources"));
    const text = streamText(form);
    if (!(own instanceof PDFDict) || text === null) continue;
    const narrowed = narrowResources(document, own, [text], narrowedForms);
    if (narrowed !== own) form.dict.set(name("Resources"), narrowed);
  }
  const kept = entries.filter(([key]) => drawn.has(key));
  if (kept.length === entries.length) return resources;
  const ownXObjects = document.context.obj({});
  for (const [key, value] of kept) ownXObjects.set(key, value);
  const narrowed = resources.clone(document.context);
  narrowed.set(name("XObject"), ownXObjects);
  return narrowed;
}

/**
 * Pages and forms often share one resource dictionary listing every image and
 * form in the document. Narrow each to what its content draws, and stop the
 * page tree passing a shared dictionary down, so a deleted page's images and
 * forms become unreachable. Fonts are left as they are.
 */
export function keepOnlyDrawnXObjects(document: PDFDocument) {
  const narrowedForms = new Set<PDFStream>();
  for (const page of document.getPages()) {
    const resources = page.node.Resources();
    if (!resources) continue;
    // Each page holds its own reference before the tree's shared copy is dropped below.
    page.node.set(name("Resources"), page.node.getInheritableAttribute(name("Resources"))!);
    const texts = contentParts(document, page.node.get(name("Contents")));
    const appearances = appearancesUsingPageResources(document, page);
    if (texts === null || appearances === null) continue;
    const narrowed = narrowResources(
      document,
      resources,
      [...texts, ...appearances],
      narrowedForms,
    );
    if (narrowed !== resources) page.node.set(name("Resources"), narrowed);
  }
  const pending: PDFObject[] = [document.catalog.get(name("Pages"))!];
  const visited = new Set<PDFObject>();
  while (pending.length) {
    const node = document.context.lookup(pending.pop());
    if (!(node instanceof PDFDict) || visited.has(node)) continue;
    visited.add(node);
    if (node.get(name("Type")) !== name("Pages")) continue;
    node.delete(name("Resources"));
    const kids = node.lookup(name("Kids"));
    if (kids instanceof PDFArray) pending.push(...kids.asArray());
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
