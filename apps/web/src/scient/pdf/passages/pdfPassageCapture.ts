import { PermissionFlag, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageView } from "pdfjs-dist/types/web/pdf_page_view";
import type { ScientPdfRuntime } from "../pdfRuntime";
import {
  capturePdfPassage,
  passageText,
  PDF_PASSAGE_LIMITS,
  verifyPdfPassage,
  type PassageMaterial,
  type PassageRefusal,
  type PassagePage,
  type PassageSelection,
  type PdfPassageCapture,
  type PdfRectangle,
} from "./pdfPassageModel";

const materialCache = new WeakMap<ScientPdfRuntime, Promise<PassageMaterial>>();
const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
const MAX_PAGE_CHARACTERS = 250_000;
const MAX_PAGE_NODES = 50_000;

export type PdfPassageSelectionResult =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Ready"; readonly pages: ReadonlyArray<PassageSelection> }
  | { readonly _tag: "Refused"; readonly reason: PassageRefusal };

// PDFViewer.getPageView is typed `any` upstream. Constrain it at this one seam
// so removed viewport methods cannot silently pass Scient's typecheck.
function pageView(runtime: ScientPdfRuntime, number: number): PDFPageView | undefined {
  return runtime.viewer.getPageView(number - 1) as PDFPageView | undefined;
}

async function hashMaterialBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const worker = new Worker(new URL("./pdfPassageHash.worker.ts", import.meta.url), {
    type: "module",
    name: "scient-pdf-passage-hash",
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          if (typeof event.data === "string" && /^[a-f0-9]{64}$/.test(event.data))
            resolve(event.data);
          else reject(new Error("The PDF hash worker returned an invalid result."));
        },
        { once: true },
      );
      worker.addEventListener(
        "error",
        (event) => {
          event.preventDefault();
          reject(new Error("The PDF hash worker failed. Try capturing again."));
        },
        { once: true },
      );
      worker.addEventListener(
        "messageerror",
        () => reject(new Error("The PDF hash could not be read. Try again.")),
        { once: true },
      );
      worker.postMessage(bytes, [bytes.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

export function readPassageMaterial(runtime: ScientPdfRuntime): Promise<PassageMaterial> {
  let result = materialCache.get(runtime);
  if (!result) {
    result = runtime.document.getDownloadInfo().then(async ({ length }) => {
      // A proof must not turn selection into an unbounded full-document buffer.
      if (length > MAX_MATERIAL_BYTES)
        throw new Error("The capture proof supports PDFs up to 100 MB.");
      const permissions = await runtime.document.getPermissions();
      if (permissions && !permissions.includes(PermissionFlag.COPY)) {
        throw new Error("This PDF does not permit copying its text.");
      }
      if (typeof Worker === "undefined")
        throw new Error("Passage capture needs browser worker support.");
      const bytes = await runtime.document.getData();
      if (bytes.byteLength > MAX_MATERIAL_BYTES)
        throw new Error("The capture proof supports PDFs up to 100 MB.");
      if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error("PDF bytes are unavailable.");
      // Transfer, rather than copy, this getData() buffer. PDF.js retains its own
      // worker-side material. Remember length before the transfer detaches our copy.
      const byteLength = bytes.byteLength;
      const sha256 = await hashMaterialBytes(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
      return { sha256, byteLength };
    });
    materialCache.set(runtime, result);
    void result.catch(() => materialCache.delete(runtime));
  }
  return result;
}

function pageGeometry(runtime: ScientPdfRuntime, pageNumber: number): Omit<PassagePage, "text"> {
  const view = pageView(runtime, pageNumber);
  const page = view?.pdfPage;
  if (!page) throw new Error("Wait for the selected PDF pages to finish loading.");
  return {
    page: pageNumber,
    viewBox: [...page.view] as unknown as PdfRectangle,
    rotation: page.rotate,
    userUnit: page.userUnit,
  };
}

function closestTextLayer(node: Node): Element | null {
  return (node instanceof Element ? node : node.parentElement)?.closest(".textLayer") ?? null;
}

function tokens(layer: HTMLElement): Array<{ node: Node; text: string }> | null {
  const result: Array<{ node: Node; text: string }> = [];
  const walker = layer.ownerDocument.createTreeWalker(
    layer,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  let nodes = 0;
  let characters = 0;
  while (walker.nextNode()) {
    if (++nodes > MAX_PAGE_NODES) return null;
    const node = walker.currentNode;
    if ((node instanceof Element ? node : node.parentElement)?.closest(".endOfContent")) continue;
    const text =
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? "")
        : node instanceof HTMLBRElement
          ? "\n"
          : "";
    characters += text.length;
    if (characters > MAX_PAGE_CHARACTERS) return null;
    if (text) result.push({ node, text });
  }
  return result;
}

/** Snapshot DOM offsets and character-range geometry synchronously, before focus changes. */
export function readPdfPassageSelection(
  runtime: ScientPdfRuntime,
  selection: Selection | null,
): PdfPassageSelectionResult {
  const refuse = (reason: PassageRefusal): PdfPassageSelectionResult => ({
    _tag: "Refused",
    reason,
  });
  if (!selection || selection.isCollapsed) return { _tag: "Empty" };
  if (selection.rangeCount !== 1) return refuse("invalid-selection");
  const range = selection.getRangeAt(0);
  const startLayer = closestTextLayer(range.startContainer);
  const endLayer = closestTextLayer(range.endContainer);
  if (!startLayer && !endLayer) return { _tag: "Empty" };
  if (
    !startLayer ||
    !endLayer ||
    !runtime.viewer.viewer?.contains(startLayer) ||
    !runtime.viewer.viewer?.contains(endLayer)
  )
    return refuse("invalid-selection");
  const first = Number(startLayer.closest<HTMLElement>(".page")?.dataset.pageNumber);
  const last = Number(endLayer.closest<HTMLElement>(".page")?.dataset.pageNumber);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first)
    return refuse("invalid-selection");
  if (last - first >= PDF_PASSAGE_LIMITS.pages) return refuse("too-many-pages");
  const pages: PassageSelection[] = [];
  let characters = 0;
  let rectangleCount = 0;
  for (let number = first; number <= last; number += 1) {
    const view = pageView(runtime, number);
    const layer = view?.textLayer?.div;
    if (!view || !layer || !layer.isConnected || layer.hidden) return refuse("page-not-ready");
    const bounds = layer.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return refuse("page-not-ready");
    const pieces = tokens(layer);
    if (!pieces) return refuse("page-too-complex");
    const text = pieces.map((piece) => piece.text).join("");
    let offset = 0;
    let start = Infinity;
    let end = 0;
    const rectangles: PdfRectangle[] = [];
    const seenRectangles = new Set<string>();
    for (const piece of pieces) {
      const node = piece.node;
      if (piece.text && range.intersectsNode(node)) {
        const isText = node.nodeType === Node.TEXT_NODE;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : piece.text.length;
        const before = isText ? range.comparePoint(node, piece.text.length) < 0 : false;
        const after = isText ? range.comparePoint(node, 0) > 0 : false;
        if (!before && !after && from < to) {
          characters += to - from;
          if (characters > PDF_PASSAGE_LIMITS.characters) return refuse("selection-too-large");
          start = Math.min(start, offset + from);
          end = Math.max(end, offset + to);
          if (isText) {
            // PDF.js rotates each text span through --rotate. Axis-aligned range
            // bounds are faithful only for quarter turns, not diagonal text.
            const span = node.parentElement;
            const angle = Number.parseFloat(
              span ? getComputedStyle(span).getPropertyValue("--rotate") || "0" : "0",
            );
            if (!Number.isFinite(angle) || Math.abs(angle / 90 - Math.round(angle / 90)) > 0.0001)
              return refuse("unsupported-text-angle");
            const selected = layer.ownerDocument.createRange();
            selected.setStart(node, from);
            selected.setEnd(node, to);
            for (const rect of selected.getClientRects()) {
              if (rect.width <= 0 || rect.height <= 0) continue;
              if (++rectangleCount > PDF_PASSAGE_LIMITS.rectangles)
                return refuse("too-many-rectangles");
              const points = [
                [rect.left, rect.top],
                [rect.right, rect.bottom],
              ].map(([x, y]) =>
                view.viewport.convertToPdfPoint(
                  ((x! - bounds.left) * view.viewport.width) / bounds.width,
                  ((y! - bounds.top) * view.viewport.height) / bounds.height,
                ),
              );
              const [a, b] = points;
              const pdfRect: PdfRectangle = [
                Math.min(a![0]!, b![0]!),
                Math.min(a![1]!, b![1]!),
                Math.max(a![0]!, b![0]!),
                Math.max(a![1]!, b![1]!),
              ];
              const key = pdfRect.join(",");
              if (!seenRectangles.has(key)) {
                seenRectangles.add(key);
                rectangles.push(pdfRect);
              }
            }
          }
        }
      }
      offset += piece.text.length;
    }
    if (!Number.isFinite(start) || !text.slice(start, end).trim())
      return refuse("invalid-selection");
    if (!rectangles.length) return refuse("page-not-ready");
    pages.push({ ...pageGeometry(runtime, number), text, start, end, rectangles });
  }
  return { _tag: "Ready", pages };
}

export async function readPassagePage(
  runtime: ScientPdfRuntime,
  number: number,
): Promise<PassagePage> {
  const page = await runtime.document.getPage(number);
  const content = await page.getTextContent({
    includeMarkedContent: true,
    disableNormalization: true,
  });
  return {
    page: number,
    text: passageText(content.items),
    viewBox: [...page.view] as unknown as PdfRectangle,
    rotation: page.rotate,
    userUnit: page.userUnit,
  };
}

export async function captureSelectedPdfPassage(
  runtime: ScientPdfRuntime,
  selection: ReadonlyArray<PassageSelection>,
) {
  if (!selection.length) return { _tag: "Refused", reason: "empty-selection" } as const;
  const material = await readPassageMaterial(runtime);
  for (const selected of selection) {
    const extracted = await readPassagePage(runtime, selected.page);
    if (extracted.text !== selected.text)
      return { _tag: "Refused", reason: "page-text-changed" } as const;
  }
  return capturePdfPassage({ material, extractorVersion: version, selection });
}

export async function verifyCapturedPdfPassage(
  runtime: ScientPdfRuntime,
  capture: PdfPassageCapture,
) {
  const material = await readPassageMaterial(runtime);
  const pages: PassagePage[] = [];
  if (material.sha256 === capture.material.sha256) {
    for (const page of capture.pages) {
      if (page.page <= runtime.document.numPages)
        pages.push(await readPassagePage(runtime, page.page));
    }
  }
  return verifyPdfPassage(capture, { material, pages, extractorVersion: version });
}

/** Temporary marks use native PDF coordinates, never saved screen pixels. */
export function showCapturedPdfPassage(
  runtime: ScientPdfRuntime,
  capture: PdfPassageCapture,
): () => void {
  const markers: HTMLElement[] = [];
  const clear = () => {
    for (const marker of markers.splice(0)) marker.remove();
  };
  const paint = () => {
    clear();
    for (const page of capture.pages) {
      const view = pageView(runtime, page.page);
      const layer = view?.textLayer?.div;
      if (!view || !layer?.isConnected) continue;
      const layerBounds = layer.getBoundingClientRect();
      const parentBounds = view.div.getBoundingClientRect();
      for (const rect of page.rectangles) {
        const [x1, y1] = view.viewport.convertToViewportPoint(rect[0], rect[1]);
        const [x2, y2] = view.viewport.convertToViewportPoint(rect[2], rect[3]);
        const marker = document.createElement("span");
        marker.className = "scient-pdf-passage-proof-mark";
        marker.setAttribute("aria-hidden", "true");
        marker.style.cssText = `position:absolute;pointer-events:none;background:rgba(250,204,21,.32);outline:1px solid rgba(161,98,7,.45);z-index:2;left:${(Math.min(x1!, x2!) * layerBounds.width) / view.viewport.width + layerBounds.left - parentBounds.left - view.div.clientLeft}px;top:${(Math.min(y1!, y2!) * layerBounds.height) / view.viewport.height + layerBounds.top - parentBounds.top - view.div.clientTop}px;width:${(Math.abs(x2! - x1!) * layerBounds.width) / view.viewport.width}px;height:${(Math.abs(y2! - y1!) * layerBounds.height) / view.viewport.height}px`;
        view.div.append(marker);
        markers.push(marker);
      }
    }
  };
  const events = ["pagerendered", "textlayerrendered", "scalechanging", "rotationchanging"];
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  };
  for (const event of events) runtime.eventBus.on(event, schedule);
  const first = capture.pages[0]!;
  const rectangle = first.rectangles[0]!;
  runtime.viewer.scrollPageIntoView({
    pageNumber: first.page,
    destArray: [null, { name: "XYZ" }, rectangle[0], rectangle[3], null],
    allowNegativeOffset: true,
    ignoreDestinationZoom: true,
  });
  schedule();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    for (const event of events) runtime.eventBus.off(event, schedule);
    clear();
  };
}
