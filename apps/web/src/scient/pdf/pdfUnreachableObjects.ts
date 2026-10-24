import { PDFArray, PDFDict, type PDFDocument, type PDFObject, PDFRef, PDFStream } from "pdf-lib";

/**
 * pdf-lib serializes every object it has ever loaded, so a deleted page's
 * content would stay readable in the saved bytes. Keep only what the trailer
 * still reaches.
 */
export function removeUnreachableObjects(document: PDFDocument) {
  const context = document.context;
  const reachable = new Set<string>();
  const pending: PDFObject[] = [];
  const { Root, Info, Encrypt } = context.trailerInfo;
  for (const entry of [Root, Info, Encrypt]) if (entry) pending.push(entry);
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
