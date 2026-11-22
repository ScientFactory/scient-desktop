// @effect-diagnostics globalJsonInEffect:off - parses a request body already bounded in size.
import { sha256 } from "@noble/hashes/sha2.js";
import * as Effect from "effect/Effect";

import { cloudError, failWith } from "./CloudError.ts";

/**
 * Request bodies, bounded before they are buffered: a Worker shares about 128 MB between
 * concurrent requests, so a body is refused as soon as it would pass its limit, and an upload
 * is held as exactly one buffer of its declared length.
 */

export interface Upload {
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, computed while reading. */
  readonly sha256: Uint8Array;
}

export const EMPTY_UPLOAD: Upload = { bytes: new Uint8Array(0), sha256: sha256(new Uint8Array(0)) };

const tooLarge = () => failWith("too_large", "The request body is too large.");

const declaredLength = (request: Request) => {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  const length = Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : Number.NaN;
};

/** Hands each chunk to `onChunk`; cancels and returns -1 once more than `max` bytes arrive. */
const readChunks = async (
  body: ReadableStream<Uint8Array> | null,
  max: number,
  onChunk: (chunk: Uint8Array, offset: number) => void,
) => {
  if (body === null) return 0;
  const reader = body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return offset;
    if (offset + value.length > max) {
      await reader.cancel();
      return -1;
    }
    onChunk(value, offset);
    offset += value.length;
  }
};

const unreadable = () => cloudError("invalid_request", "The request body could not be read.");

/** A binary upload of at most `maxBytes`; it must declare its length. */
export const readUpload = Effect.fn("Body.readUpload")(function* (
  request: Request,
  maxBytes: number,
) {
  const declared = declaredLength(request);
  if (declared === undefined || Number.isNaN(declared)) {
    return yield* failWith("invalid_request", "Send the body with its content-length.");
  }
  if (declared > maxBytes) return yield* tooLarge();
  const bytes = new Uint8Array(declared);
  const hash = sha256.create();
  const read = yield* Effect.tryPromise({
    try: () =>
      readChunks(request.body, declared, (chunk, offset) => {
        bytes.set(chunk, offset);
        hash.update(chunk);
      }),
    catch: unreadable,
  });
  if (read !== declared) {
    return yield* failWith("invalid_request", "The body does not match its content-length.");
  }
  return { bytes, sha256: hash.digest() } satisfies Upload;
});

/** A JSON body of at most `maxBytes`, parsed. */
export const readJsonBody = Effect.fn("Body.readJsonBody")(function* (
  request: Request,
  maxBytes: number,
) {
  const declared = declaredLength(request);
  if (declared !== undefined && declared > maxBytes) return yield* tooLarge();
  const chunks: Array<Uint8Array> = [];
  const read = yield* Effect.tryPromise({
    try: () => readChunks(request.body, maxBytes, (chunk) => void chunks.push(chunk)),
    catch: unreadable,
  });
  if (read < 0) return yield* tooLarge();
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return yield* Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
    catch: () => cloudError("invalid_request", "The request body is not JSON."),
  });
});
