import { PDFDocument, StandardFonts } from "pdf-lib";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { TextLayerBuilder } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { expect, it, vi } from "vite-plus/test";
import { prioritizeChatInput } from "../writing/inputPriority";
import { prioritizePdfTextCompletion } from "./pdfChatPriority";

prioritizePdfTextCompletion(TextLayerBuilder);

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
    source.addPage([300, 300]).drawText("Document text", { x: 20, y: 200, font, size: 14 });
    const loading = getDocument({ data: await source.save() });
    cleanup.defer(() => loading.destroy());
    const pdfPage = await (await loading.promise).getPage(1);
    const input = document.createElement("textarea");
    document.body.append(input);
    cleanup.defer(() => input.remove());
    cleanup.defer(prioritizeChatInput(input));
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const lifetime = new AbortController();
    cleanup.defer(() => lifetime.abort());
    const append = vi.fn();
    const enable = vi.fn();
    const builder = new TextLayerBuilder({
      pdfPage,
      onAppend: append,
      abortSignal: lifetime.signal,
    });
    builder.accessibilityManager = {
      setTextMapping: vi.fn(),
      enable,
      disable: vi.fn(),
    } as unknown as typeof builder.accessibilityManager;
    cleanup.defer(() => builder.cancel());
    const previousGate = TextLayerBuilder.beforeAppend;
    const gate = vi.fn(previousGate!);
    TextLayerBuilder.beforeAppend = gate;
    cleanup.defer(() => {
      TextLayerBuilder.beforeAppend = previousGate;
    });
    const rendered = builder.render({
      viewport: pdfPage.getViewport({ scale: 1 }),
      // @ts-expect-error -- PDFViewer uses null when image selection is disabled.
      images: null,
    });
    await vi.waitFor(() => expect(gate).toHaveBeenCalled());
    return {
      input,
      lifetime,
      append,
      enable,
      rendered,
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}

it("holds completed PDF text layout and accessibility work until Ask in chat releases input priority", async () => {
  await using current = await fixture();
  expect(current.append).not.toHaveBeenCalled();
  expect(current.enable).not.toHaveBeenCalled();
  current.input.blur();
  await current.rendered;
  expect(current.append).toHaveBeenCalledOnce();
  expect(current.enable).toHaveBeenCalledOnce();
});

it("does not append or measure a text layer whose document closes while typing", async () => {
  await using current = await fixture();
  current.lifetime.abort();
  await expect(current.rendered).rejects.toMatchObject({ name: "AbortException" });
  expect(current.append).not.toHaveBeenCalled();
  expect(current.enable).not.toHaveBeenCalled();
});
