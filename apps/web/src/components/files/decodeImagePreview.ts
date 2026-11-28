import { msg } from "gt-react";

import { m } from "~/i18n/messages";

import type { PreviewFailure } from "./previewFailure";
import { previewFailureText } from "./previewFailureMessages";
import { readBinaryPreview } from "./readBinaryPreview";
// SCIENT-FORK:START — TIFFs use Scient's range-reading decoder with automatic contrast.
import { decodeScientTiffPreview } from "~/scient/fileSurfaces/tiffPreview/tiffPreviewSession";
// SCIENT-FORK:END

export async function decodeImagePreview(src: string, heif: boolean, signal: AbortSignal) {
  // SCIENT-FORK:START
  if (!heif) return await decodeScientTiffPreview(src, signal);
  // SCIENT-FORK:END
  const worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
    type: "module",
  });
  const controller = new AbortController();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));
      const abort = () => fail(m(msg("Image decoding cancelled.")));
      signal.addEventListener("abort", abort, { signal: controller.signal });
      if (signal.aborted) return abort();
      const timer = setTimeout(() => fail(m(msg("This image took too long to decode."))), 30_000);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      worker.addEventListener("error", () => fail(m(msg("Could not load the image decoder."))));
      worker.addEventListener(
        "message",
        (event: MessageEvent<{ blob?: Blob; failure?: PreviewFailure }>) => {
          if (event.data.blob) resolve(event.data.blob);
          else if (event.data.failure) fail(previewFailureText(event.data.failure, m));
          else fail(m(msg("Could not decode this image.")));
        },
      );
      void readBinaryPreview(src, controller.signal).then(
        (bytes) => worker.postMessage({ bytes, heif }, [bytes]),
        reject,
      );
    });
  } finally {
    controller.abort();
    worker.terminate();
  }
}

// SCIENT-FORK:START — reuse the worker's single heic-to/csp bundle for attachment decoding without sRGB conversion.
export async function decodeHeifBitmap(blob: Blob, signal?: AbortSignal): Promise<ImageBitmap> {
  const worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
    type: "module",
  });
  const controller = new AbortController();
  try {
    return await new Promise<ImageBitmap>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      const abort = () => fail(m(msg("Image decoding cancelled.")));
      if (signal) {
        signal.addEventListener("abort", abort, { signal: controller.signal });
        if (signal.aborted) return abort();
      }
      const timer = setTimeout(() => fail(m(msg("This image took too long to decode."))), 30_000);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      worker.addEventListener("error", () => fail(m(msg("Could not load the image decoder."))));
      worker.addEventListener("messageerror", () => fail(m(msg("Could not decode this image."))));
      worker.addEventListener(
        "message",
        (event: MessageEvent<{ bitmap?: ImageBitmap; failure?: PreviewFailure }>) => {
          if (settled) {
            event.data.bitmap?.close();
            return;
          }
          if (event.data.bitmap) {
            settled = true;
            resolve(event.data.bitmap);
          } else if (event.data.failure) {
            fail(previewFailureText(event.data.failure, m));
          } else {
            fail(m(msg("Could not decode this image.")));
          }
        },
      );
      void blob.arrayBuffer().then(
        (bytes) => {
          if (settled) return;
          try {
            worker.postMessage({ bytes, heif: true, output: "bitmap" }, [bytes]);
          } catch {
            fail(m(msg("Could not decode this image.")));
          }
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    controller.abort();
    worker.terminate();
  }
}
// SCIENT-FORK:END
