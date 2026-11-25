import type { PdfOcrBox, PdfOcrLine } from "./pdfOcrText";

/** Reads the words on a page image. */
export interface PdfOcrEngine {
  recognize(
    image: Blob,
    size: { readonly width: number; readonly height: number },
  ): Promise<ReadonlyArray<PdfOcrLine>>;
}

type TesseractWorker = Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>;

interface TesseractBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const IDLE_MS = 60_000;
const LSTM_ONLY = 1;

/** Engine, language data and worker script ship with the app (see scripts/scientOcrAssets.ts). */
function ocrAssetRoot(): string {
  return new URL(`${import.meta.env.BASE_URL}ocr-assets/`, window.location.href).toString();
}

export function pdfOcrConcurrency(): number {
  return (globalThis.navigator?.hardwareConcurrency ?? 1) >= 8 ? 2 : 1;
}

function lines(
  blocks: ReadonlyArray<{
    readonly paragraphs: ReadonlyArray<{
      readonly is_ltr: boolean;
      readonly lines: ReadonlyArray<{
        readonly bbox: TesseractBox;
        readonly words: ReadonlyArray<{
          readonly text: string;
          readonly confidence: number;
          readonly bbox: TesseractBox;
        }>;
      }>;
    }>;
  }> | null,
  width: number,
  height: number,
): PdfOcrLine[] {
  const box = (bbox: TesseractBox): PdfOcrBox => ({
    x0: bbox.x0 / width,
    y0: bbox.y0 / height,
    x1: bbox.x1 / width,
    y1: bbox.y1 / height,
  });
  return (blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.map((line) => ({
        box: box(line.bbox),
        rtl: !paragraph.is_ltr,
        words: line.words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          box: box(word.bbox),
        })),
      })),
    ),
  );
}

/**
 * Tesseract 5 in WebAssembly, English and Hebrew, one worker per slot. Workers start on the
 * first page and stop after a minute without work, releasing their memory.
 */
export function createTesseractOcrEngine(slots: number): PdfOcrEngine {
  const idle: TesseractWorker[] = [];
  const waiting: Array<{
    readonly resolve: (worker: TesseractWorker) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  let started = 0;
  let busy = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const start = async (): Promise<TesseractWorker> => {
    const { createWorker } = await import("tesseract.js");
    const root = ocrAssetRoot();
    const worker = await createWorker(["eng", "heb"], LSTM_ONLY, {
      workerPath: `${root}worker.min.js`,
      corePath: `${root}core`,
      langPath: `${root}lang`,
      cacheMethod: "none",
      gzip: true,
      workerBlobURL: false,
    });
    await worker.setParameters({ tessedit_pageseg_mode: "3" as never, user_defined_dpi: "300" });
    return worker;
  };

  const stopWhenIdle = () => {
    if (busy > 0 || idleTimer !== null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (busy > 0) return;
      for (const worker of idle.splice(0)) void worker.terminate().catch(() => undefined);
      started = 0;
    }, IDLE_MS);
  };

  const launch = async (): Promise<TesseractWorker> => {
    started += 1;
    busy += 1;
    try {
      return await start();
    } catch (error) {
      started -= 1;
      busy -= 1;
      stopWhenIdle();
      throw error;
    }
  };

  const acquire = (): Promise<TesseractWorker> => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const ready = idle.pop();
    if (ready) {
      busy += 1;
      return Promise.resolve(ready);
    }
    if (started < slots) return launch();
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };

  const release = (worker: TesseractWorker | null) => {
    busy -= 1;
    if (worker === null) started -= 1;
    const next = waiting.shift();
    if (next) {
      if (worker) {
        busy += 1;
        next.resolve(worker);
      } else {
        launch().then(next.resolve, next.reject);
      }
      return;
    }
    if (worker) idle.push(worker);
    stopWhenIdle();
  };

  return {
    async recognize(image, size) {
      const worker = await acquire();
      let usable: TesseractWorker | null = worker;
      try {
        const { data } = await worker.recognize(
          image,
          {},
          { blocks: true, text: false, hocr: false, tsv: false },
        );
        return lines(data.blocks as Parameters<typeof lines>[0], size.width, size.height);
      } catch (error) {
        // A failed worker may be wedged; the next page starts a fresh one.
        usable = null;
        void worker.terminate().catch(() => undefined);
        throw error;
      } finally {
        release(usable);
      }
    },
  };
}
