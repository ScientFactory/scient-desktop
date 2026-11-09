import { tiffPreviewError, type TiffPreviewInfo } from "./tiffPreview";
import type { TiffWorkerRequest, TiffWorkerResult } from "./tiffPreviewProtocol";

const DECODE_TIMEOUT_MS = 60_000;

export interface TiffPreviewResult {
  readonly blob: Blob;
  readonly info: TiffPreviewInfo;
}

interface Pending {
  readonly resolve: (result: TiffPreviewResult) => void;
  readonly reject: (cause: unknown) => void;
}

const aborted = () => new DOMException("TIFF decoding cancelled.", "AbortError");

// One worker per open viewer keeps the parsed file between plane requests.
export function createTiffPreviewSession() {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const failAll = (cause: unknown) => {
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
  };
  const start = () => {
    const created = new Worker(new URL("./tiffPreview.worker.ts", import.meta.url), {
      type: "module",
    });
    created.addEventListener("message", (event: MessageEvent<TiffWorkerResult>) => {
      const result = event.data;
      const request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      if ("blob" in result) request.resolve({ blob: result.blob, info: result.info });
      else request.reject(tiffPreviewError(result.error, result.kind));
    });
    created.addEventListener("error", () => {
      failAll(tiffPreviewError("Could not load the image decoder.", "load"));
      created.terminate();
      if (worker === created) worker = null;
    });
    return created;
  };
  return {
    decode(src: string, plane: number, signal: AbortSignal) {
      return new Promise<TiffPreviewResult>((resolve, reject) => {
        if (signal.aborted) return reject(aborted());
        // The worker drops older requests, so they will never answer.
        failAll(aborted());
        const id = ++nextId;
        const cleanup = new AbortController();
        const settle = (finish: () => void) => {
          pending.delete(id);
          cleanup.abort();
          finish();
        };
        const timer = setTimeout(
          () => settle(() => reject(tiffPreviewError("This image took too long to decode."))),
          DECODE_TIMEOUT_MS,
        );
        cleanup.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        signal.addEventListener("abort", () => settle(() => reject(aborted())), {
          once: true,
          signal: cleanup.signal,
        });
        pending.set(id, {
          resolve: (result) => settle(() => resolve(result)),
          reject: (cause) => settle(() => reject(cause)),
        });
        worker ??= start();
        worker.postMessage({ id, src, plane } satisfies TiffWorkerRequest, { transfer: [] });
      });
    },
    dispose() {
      failAll(aborted());
      worker?.terminate();
      worker = null;
    },
  };
}

export type TiffPreviewSession = ReturnType<typeof createTiffPreviewSession>;

export async function decodeScientTiffPreview(src: string, signal: AbortSignal) {
  const session = createTiffPreviewSession();
  try {
    return (await session.decode(src, 0, signal)).blob;
  } finally {
    session.dispose();
  }
}
