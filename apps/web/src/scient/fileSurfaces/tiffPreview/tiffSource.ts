import { BaseClient, BaseResponse, fromCustomClient, type GeoTIFF } from "geotiff";

import { asMetadataError, tiffPreviewError } from "./tiffPreview";

// Thrown through geotiff to tell a server that ignores ranges apart from a failed read.
const RANGES_UNAVAILABLE = "TIFF ranges unavailable";

class SliceResponse extends BaseResponse {
  readonly #status: number;
  readonly #headers: Headers;
  readonly #data: () => Promise<ArrayBuffer>;

  constructor(status: number, headers: Headers, data: () => Promise<ArrayBuffer>) {
    super();
    this.#status = status;
    this.#headers = headers;
    this.#data = data;
  }

  override get status() {
    return this.#status;
  }

  override getHeader(name: string) {
    return this.#headers.get(name) ?? undefined;
  }

  override getData() {
    return this.#data();
  }
}

function requestedRange(init: RequestInit | undefined) {
  const header = new Headers(init?.headers).get("range") ?? "";
  const match = /^bytes=(\d+)-(\d+)$/u.exec(header);
  if (!match) throw tiffPreviewError("Invalid TIFF range request.");
  return { start: Number(match[1]), end: Number(match[2]) };
}

// Serves geotiff's range reads from a Blob, so local files never need a full copy.
class BlobRangeClient extends BaseClient {
  readonly #blob: Blob;

  constructor(blob: Blob) {
    super("blob:");
    this.#blob = blob;
  }

  override async request(init?: RequestInit) {
    const { start, end } = requestedRange(init);
    const slice = this.#blob.slice(start, end + 1);
    const last = Math.min(end, this.#blob.size - 1);
    const headers = new Headers({ "content-range": `bytes ${start}-${last}/${this.#blob.size}` });
    return new SliceResponse(206, headers, () => slice.arrayBuffer());
  }
}

class HttpRangeClient extends BaseClient {
  override async request(init?: RequestInit) {
    const response = await fetch(this.url, init).catch((cause: unknown) => {
      if (init?.signal?.aborted) throw cause;
      throw tiffPreviewError("The file could not be loaded. Close it and try again.", "load");
    });
    // The asset route answers a range past the end with 416; geotiff expects a short read, and
    // keeps the file size only when the reply names it.
    if (response.status === 416) {
      await response.body?.cancel();
      const size = /\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")?.[1];
      const headers = new Headers(size ? { "content-range": `bytes 0-0/${size}` } : {});
      return new SliceResponse(206, headers, async () => new ArrayBuffer(0));
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw tiffPreviewError("The file could not be loaded. Close it and try again.", "load");
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(RANGES_UNAVAILABLE);
    }
    return new SliceResponse(response.status, response.headers, () => response.arrayBuffer());
  }
}

/** Opens bytes already in memory through the same range reader, so the file size is known. */
export function openTiffBytes(bytes: ArrayBuffer) {
  return fromCustomClient(new BlobRangeClient(new Blob([bytes])));
}

export async function openTiffSource(
  src: string,
  readWhole: (src: string, signal: AbortSignal) => Promise<ArrayBuffer>,
): Promise<GeoTIFF> {
  if (/^(?:blob|data):/u.test(src)) {
    const response = await fetch(src).catch(() => null);
    if (!response?.ok)
      throw tiffPreviewError("The file could not be loaded. Close it and try again.", "load");
    return await fromCustomClient(new BlobRangeClient(await response.blob())).catch(
      asMetadataError,
    );
  }
  try {
    return await fromCustomClient(new HttpRangeClient(src));
  } catch (cause) {
    if (!(cause instanceof Error && cause.message === RANGES_UNAVAILABLE)) asMetadataError(cause);
  }
  // Without range support the whole file is read, within the existing 50 MB limit.
  let bytes: ArrayBuffer;
  try {
    bytes = await readWhole(src, new AbortController().signal);
  } catch (cause) {
    if (cause instanceof Error && /limited to files/u.test(cause.message))
      throw tiffPreviewError(cause.message);
    throw tiffPreviewError(
      cause instanceof Error ? cause.message : "The file could not be loaded.",
      "load",
    );
  }
  // A Blob reader reports the file size, which the layout check needs.
  return await openTiffBytes(bytes).catch(asMetadataError);
}
