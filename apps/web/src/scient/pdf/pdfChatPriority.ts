import type { PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { afterChatInputQuiet, chatInputQuietDelay } from "../writing/inputPriority";

type PdfWorkHost = {
  update: PDFViewer["update"];
  renderingQueue:
    | Pick<NonNullable<PDFViewer["renderingQueue"]>, "renderHighestPriority" | "isHighestPriority">
    | undefined;
};

export function prioritizePdfWork(viewer: PdfWorkHost, signal: AbortSignal): void {
  if (signal.aborted) return;
  const queue = viewer.renderingQueue;
  if (!queue) return;
  const update = viewer.update;
  const render = queue.renderHighestPriority;
  const highest = queue.isHighestPriority;
  let cancel: (() => void) | undefined;
  const defer = () => {
    cancel ??= afterChatInputQuiet(() => {
      cancel = undefined;
      update.call(viewer);
    });
  };
  viewer.update = () => {
    if (chatInputQuietDelay() > 0) defer();
    else update.call(viewer);
  };
  queue.renderHighestPriority = (...args) => {
    if (chatInputQuietDelay() > 0) defer();
    else render.apply(queue, args);
  };
  queue.isHighestPriority = (...args) => {
    if (chatInputQuietDelay() > 0) {
      defer();
      return false;
    }
    return highest.apply(queue, args);
  };
  signal.addEventListener(
    "abort",
    () => {
      cancel?.();
      viewer.update = update;
      queue.renderHighestPriority = render;
      queue.isHighestPriority = highest;
    },
    { once: true },
  );
}
