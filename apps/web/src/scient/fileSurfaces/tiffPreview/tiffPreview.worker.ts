import { readBinaryPreview } from "~/components/files/readBinaryPreview";

import { openTiffSource } from "./tiffSource";
import { isTiffPreviewError, readTiffPlane, tiffPreviewError } from "./tiffPreview";
import type { TiffWorkerRequest, TiffWorkerResult } from "./tiffPreviewProtocol";
import { registerBoundedTiffDecoders } from "./tiffBlockDecoders";

registerBoundedTiffDecoders();

type Opened = {
  readonly src: string;
  readonly tiff: ReturnType<typeof openTiffSource>;
  // The first display range of each channel holds while stepping, as in Fiji.
  readonly display: Map<number, readonly [number, number]>;
};

let opened: Opened | null = null;
let current: AbortController | null = null;

function post(result: TiffWorkerResult) {
  self.postMessage(result, { transfer: [] });
}

async function decode(request: TiffWorkerRequest, signal: AbortSignal) {
  // The source opens without the request's signal so a newer plane request can reuse it.
  if (opened?.src !== request.src) {
    opened = {
      src: request.src,
      tiff: openTiffSource(request.src, readBinaryPreview),
      display: new Map(),
    };
  }
  const session = opened;
  const tiff = await session.tiff;
  const plane = await readTiffPlane(tiff, {
    plane: request.plane,
    heldDisplay: (channel) => session.display.get(channel),
    signal,
  });
  const { info } = plane;
  if (
    info.display &&
    info.range &&
    info.range[1] > info.range[0] &&
    !session.display.has(info.channel)
  )
    session.display.set(info.channel, info.display);
  const canvas = new OffscreenCanvas(plane.width, plane.height);
  const context = canvas.getContext("2d");
  if (!context) throw tiffPreviewError("Image decoding is unavailable.");
  context.putImageData(new ImageData(plane.rgba, plane.width, plane.height), 0, 0);
  return { blob: await canvas.convertToBlob({ type: "image/png" }), info };
}

self.addEventListener("message", (event: MessageEvent<TiffWorkerRequest>) => {
  const request = event.data;
  current?.abort();
  const controller = new AbortController();
  current = controller;
  void decode(request, controller.signal).then(
    ({ blob, info }) => {
      if (!controller.signal.aborted) post({ id: request.id, blob, info });
    },
    (cause: unknown) => {
      if (controller.signal.aborted) return;
      // A failed open is not cached, so a renewed URL or a retry opens again.
      if (opened?.src === request.src) opened = null;
      post({
        id: request.id,
        error: cause instanceof Error ? cause.message : "Could not decode this image.",
        kind: isTiffPreviewError(cause) ? cause.kind : "format",
      });
    },
  );
});
