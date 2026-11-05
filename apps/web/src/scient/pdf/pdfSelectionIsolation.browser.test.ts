import { PDFDocument, StandardFonts } from "pdf-lib";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { TextLayerBuilder } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { expect, it } from "vite-plus/test";
import "pdfjs-dist/legacy/web/pdf_viewer.css";

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
    const documentProxy = await loading.promise;
    const pdfPage = await documentProxy.getPage(1);
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
    const observer = new MutationObserver(() => {});
    observer.observe(builder.div, { childList: true, attributes: true, subtree: true });
    cleanup.defer(() => observer.disconnect());
    return {
      builder,
      chat,
      selection,
      observer,
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}

it("leaves PDF text DOM untouched while another editor changes its caret and selection", async () => {
  await using current = await fixture();
  const { chat, selection, observer } = current;
  chat.focus();
  selection.setPosition(chat.firstChild!, 3);
  for (let index = 0; index < 3; index++) {
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  }
  expect(observer.takeRecords()).toEqual([]);
  selection.selectAllChildren(chat);
  document.dispatchEvent(new Event("selectionchange"));
  expect(observer.takeRecords()).toEqual([]);
});

it("keeps PDF selection working and resets it once when the reader loses the selection", async () => {
  await using current = await fixture();
  const { builder, chat, selection, observer } = current;
  selection.selectAllChildren(builder.div.querySelector("span")!);
  document.dispatchEvent(new Event("selectionchange"));
  expect(selection.toString()).toBe("Selected PDF text");
  expect(builder.div.classList.contains("selecting")).toBe(true);
  observer.takeRecords();
  chat.focus();
  selection.setPosition(chat.firstChild!, 2);
  document.dispatchEvent(new Event("selectionchange"));
  expect(builder.div.classList.contains("selecting")).toBe(false);
  expect(observer.takeRecords().length).toBeGreaterThan(0);
  document.dispatchEvent(new Event("selectionchange"));
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  expect(observer.takeRecords()).toEqual([]);
});
