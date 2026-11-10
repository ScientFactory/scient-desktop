import { describe, expect, it } from "@effect/vitest";

import {
  decodeShareKey,
  decryptShareObject,
  decryptShareStream,
  encodeShareKey,
  encryptShareObject,
  generateShareKey,
  SHARE_CHUNK_BYTES,
  ShareCryptoError,
} from "./shareCrypto.ts";

const FRAME = SHARE_CHUNK_BYTES + 16;
const snapshot = { version: 1, object: "snapshot" } as const;

function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (index * 31 + 7) % 251;
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Splits a framed object into its header and ciphertext frames. */
function frames(framed: Uint8Array) {
  const headerEnd = 2 + new DataView(framed.buffer, framed.byteOffset).getUint16(0);
  const out: Uint8Array[] = [];
  for (let offset = headerEnd; offset < framed.length; offset += FRAME) {
    out.push(framed.subarray(offset, Math.min(offset + FRAME, framed.length)));
  }
  return { header: framed.subarray(0, headerEnd), frames: out };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ShareCryptoError);
  return (error as ShareCryptoError).reason;
}

describe("share crypto", () => {
  it("round-trips empty, exact-boundary and multi-chunk objects", async () => {
    const key = generateShareKey();
    expect(decodeShareKey(`#${encodeShareKey(key)}`)).toEqual(key);
    const cases = [
      { length: 0, frames: 1 },
      { length: SHARE_CHUNK_BYTES, frames: 1 },
      { length: 2 * SHARE_CHUNK_BYTES, frames: 2 },
      { length: 2 * SHARE_CHUNK_BYTES + 5, frames: 3 },
    ];
    for (const { length, frames: count } of cases) {
      const plain = bytes(length);
      const framed = await encryptShareObject(key, snapshot, plain);
      expect(frames(framed).frames).toHaveLength(count);
      expect(await decryptShareObject(key, snapshot, framed)).toEqual(plain);
    }
  });

  it("decrypts input that arrives in arbitrary pieces", async () => {
    const key = generateShareKey();
    const plain = bytes(SHARE_CHUNK_BYTES + 1000);
    const framed = await encryptShareObject(key, snapshot, plain);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < framed.length; offset += 300_007) {
          controller.enqueue(framed.subarray(offset, offset + 300_007));
        }
        controller.close();
      },
    });
    const output = await new Response(
      input.pipeThrough(decryptShareStream(key, snapshot)),
    ).arrayBuffer();
    expect(new Uint8Array(output)).toEqual(plain);
  });

  it("rejects truncation, reordering, swaps, a wrong key and tag tampering", async () => {
    const key = generateShareKey();
    const plain = bytes(2 * SHARE_CHUNK_BYTES + 5);
    const framed = await encryptShareObject(key, snapshot, plain);
    const {
      header,
      frames: [first, second, last],
    } = frames(framed);

    // Dropping the last frame leaves a non-last frame at the end.
    expect(
      await rejection(decryptShareObject(key, snapshot, concat(header, first!, second!))),
    ).toBe("authentication_failed");
    expect(await rejection(decryptShareObject(key, snapshot, header))).toBe("truncated");
    expect(await rejection(decryptShareObject(key, snapshot, framed.subarray(0, 1)))).toBe(
      "truncated",
    );
    expect(
      await rejection(decryptShareObject(key, snapshot, concat(header, second!, first!, last!))),
    ).toBe("authentication_failed");

    expect(await rejection(decryptShareObject(key, { version: 1, object: "meta" }, framed))).toBe(
      "authentication_failed",
    );
    expect(
      await rejection(decryptShareObject(key, { version: 2, object: "snapshot" }, framed)),
    ).toBe("authentication_failed");
    // A frame spliced in from another object under the same key and nonce position.
    const meta = frames(await encryptShareObject(key, { version: 1, object: "meta" }, plain));
    expect(
      await rejection(
        decryptShareObject(key, snapshot, concat(header, meta.frames[0]!, second!, last!)),
      ),
    ).toBe("authentication_failed");

    expect(await rejection(decryptShareObject(generateShareKey(), snapshot, framed))).toBe(
      "authentication_failed",
    );
    const flipped = Uint8Array.from(framed);
    flipped[flipped.length - 1]! ^= 1;
    expect(await rejection(decryptShareObject(key, snapshot, flipped))).toBe(
      "authentication_failed",
    );
    expect(() => decodeShareKey("short")).toThrow(ShareCryptoError);
  });
});
