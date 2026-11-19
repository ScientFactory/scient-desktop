import { PDFDocument, StandardFonts } from "pdf-lib";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { TextLayerBuilder } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { expect, it } from "vite-plus/test";

// The patched TextLayerBuilder leaves text layers alone on another editor's caret moves.
// Moving endOfContent made PDF.js's DrawLayer read Selection.isCollapsed, a forced layout per key.
async function fixture() {
  const cleanup = new AsyncDisposableStack();
  try {
    const previousWorker = GlobalWorkerOptions.workerSrc;
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    cleanup.defer(() => {
      GlobalWorkerOptions.workerSrc = previousWorker;
    });
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    source.addPage([300, 300]).drawText("Selected PDF text", { x: 20, y: 200, font, size: 14 });
    const loading = getDocument({ data: await source.save() });
    cleanup.defer(() => loading.destroy());
    const pdfPage = await (await loading.promise).getPage(1);
    const root = document.createElement("div");
    root.style.setProperty("--scale-factor", "1");
    document.body.append(root);
    cleanup.defer(() => root.remove());
    const lifetime = new AbortController();
    cleanup.defer(() => lifetime.abort());
    const builder = new TextLayerBuilder({ pdfPage, abortSignal: lifetime.signal });
    cleanup.defer(() => builder.cancel());
    root.append(builder.div);
    await builder.render({
      viewport: pdfPage.getViewport({ scale: 1 }),
      // @ts-expect-error -- The pinned PDFViewer passes null when image selection is disabled.
      images: null,
    });
    const chat = document.createElement("div");
    chat.contentEditable = "true";
    chat.textContent = "Chat draft";
    root.append(chat);
    const selection = document.getSelection()!;
    cleanup.defer(() => selection.removeAllRanges());
    const moves: MutationRecord[] = [];
    const observer = new MutationObserver((records) => moves.push(...records));
    observer.observe(builder.div, { childList: true, subtree: true });
    cleanup.defer(() => observer.disconnect());
    const takeMoves = () => moves.splice(0).concat(observer.takeRecords());
    return {
      builder,
      chat,
      selection,
      takeMoves,
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}

const typeKey = () => {
  document.dispatchEvent(new Event("selectionchange"));
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
};

it("leaves PDF text layers untouched while another editor's caret moves", async () => {
  await using current = await fixture();
  current.chat.focus();
  current.selection.setPosition(current.chat.firstChild!, 3);
  for (let index = 0; index < 3; index++) typeKey();

  expect(current.takeMoves()).toEqual([]);
});

it("still clears a PDF selection once the selection leaves the page", async () => {
  await using current = await fixture();
  const { builder, chat, selection } = current;
  selection.selectAllChildren(builder.div.querySelector("span")!);
  document.dispatchEvent(new Event("selectionchange"));
  expect(builder.div.classList.contains("selecting")).toBe(true);

  chat.focus();
  selection.setPosition(chat.firstChild!, 2);
  document.dispatchEvent(new Event("selectionchange"));

  expect(builder.div.classList.contains("selecting")).toBe(false);
  expect(builder.div.lastElementChild?.classList.contains("endOfContent")).toBe(true);
});
