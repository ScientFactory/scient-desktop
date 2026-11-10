import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * STREAM-style AES-GCM: per-object HKDF key, nonce = 8 random bytes ‖ u32be(index), AAD =
 * utf8(object) ‖ u32be(index) ‖ u8(isLast). Framed object = u16be(header length) ‖ header JSON
 * `{v:1, chunk, np}` ‖ frames; every frame but the last holds exactly `chunk` plaintext bytes.
 */

const SHARE_KEY_BYTES = 32;
export const SHARE_CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 8;
const MAX_HEADER_BYTES = 256;
const MAX_CHUNKS = 2 ** 32;

export class ShareCryptoError extends Schema.TaggedError<ShareCryptoError>()("ShareCryptoError", {
  reason: Schema.Literals([
    "invalid_key",
    "invalid_object",
    "malformed",
    "unsupported_version",
    "truncated",
    "authentication_failed",
  ]),
}) {
  override get message(): string {
    return `Shared conversation could not be decrypted: ${this.reason}.`;
  }
}

export interface ShareObjectRef {
  readonly version: number;
  /** `snapshot`, `meta`, or `blob-<sha256>`. */
  readonly object: string;
}

const ShareObjectHeader = Schema.Struct({
  v: Schema.Number,
  chunk: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SHARE_CHUNK_BYTES })),
  np: Schema.String,
});
const decodeHeader = Schema.decodeUnknownResult(Schema.fromJsonString(ShareObjectHeader));

export function generateShareKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES));
}

export function encodeShareKey(key: Uint8Array): string {
  if (key.length !== SHARE_KEY_BYTES) throw new ShareCryptoError({ reason: "invalid_key" });
  return Base64Url.encode(key);
}

/** Accepts the raw fragment, with or without its leading `#`. */
export function decodeShareKey(fragment: string): Uint8Array<ArrayBuffer> {
  const decoded = Base64Url.decode(fragment.replace(/^#/u, ""));
  if (Result.isFailure(decoded) || decoded.success.length !== SHARE_KEY_BYTES) {
    throw new ShareCryptoError({ reason: "invalid_key" });
  }
  return Uint8Array.from(decoded.success);
}

async function objectKey(key: Uint8Array, ref: ShareObjectRef): Promise<CryptoKey> {
  if (key.length !== SHARE_KEY_BYTES) throw new ShareCryptoError({ reason: "invalid_key" });
  if (!Number.isSafeInteger(ref.version) || ref.version < 1 || ref.object === "") {
    throw new ShareCryptoError({ reason: "invalid_object" });
  }
  const base = await crypto.subtle.importKey("raw", Uint8Array.from(key), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`scient-share/v1/${ref.version}/${ref.object}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function chunkParams(noncePrefix: Uint8Array, object: Uint8Array, index: number, isLast: boolean) {
  const iv = new Uint8Array(NONCE_PREFIX_BYTES + 4);
  iv.set(noncePrefix);
  new DataView(iv.buffer).setUint32(NONCE_PREFIX_BYTES, index);
  const additionalData = new Uint8Array(object.length + 5);
  additionalData.set(object);
  const view = new DataView(additionalData.buffer);
  view.setUint32(object.length, index);
  view.setUint8(object.length + 4, isLast ? 1 : 0);
  return { name: "AES-GCM", iv, additionalData, tagLength: TAG_BYTES * 8 } as const;
}

/** Pending bytes as a list of slices, so buffering a chunk never re-copies earlier input. */
class ByteQueue {
  private parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array) {
    if (bytes.length === 0) return;
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  take(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const part = this.parts[0]!;
      const used = Math.min(part.length, count - offset);
      out.set(part.subarray(0, used), offset);
      offset += used;
      if (used === part.length) this.parts.shift();
      else this.parts[0] = part.subarray(used);
    }
    this.length -= count;
    return out;
  }
}

/** Encrypts one share object. Holds at most one chunk of plaintext. */
export function encryptShareStream(
  key: Uint8Array,
  ref: ShareObjectRef,
): TransformStream<Uint8Array, Uint8Array> {
  const object = new TextEncoder().encode(ref.object);
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
  const pending = new ByteQueue();
  let aesKey: CryptoKey;
  let index = 0;

  const seal = async (controller: TransformStreamDefaultController<Uint8Array>, last: boolean) => {
    if (index >= MAX_CHUNKS) throw new ShareCryptoError({ reason: "invalid_object" });
    const plain = pending.take(last ? pending.length : SHARE_CHUNK_BYTES);
    const sealed = await crypto.subtle.encrypt(
      chunkParams(noncePrefix, object, index, last),
      aesKey,
      plain,
    );
    controller.enqueue(new Uint8Array(sealed));
    index += 1;
  };

  return new TransformStream({
    async start(controller) {
      aesKey = await objectKey(key, ref);
      const header = new TextEncoder().encode(
        JSON.stringify({ v: 1, chunk: SHARE_CHUNK_BYTES, np: Base64Url.encode(noncePrefix) }),
      );
      const framed = new Uint8Array(2 + header.length);
      new DataView(framed.buffer).setUint16(0, header.length);
      framed.set(header, 2);
      controller.enqueue(framed);
    },
    async transform(bytes, controller) {
      pending.push(bytes);
      // Keep the final chunk back until flush, which alone knows it is last.
      while (pending.length > SHARE_CHUNK_BYTES) await seal(controller, false);
    },
    async flush(controller) {
      await seal(controller, true);
    },
  });
}

/** Decrypts one share object. Holds at most one frame of ciphertext. */
export function decryptShareStream(
  key: Uint8Array,
  ref: ShareObjectRef,
): TransformStream<Uint8Array, Uint8Array> {
  const object = new TextEncoder().encode(ref.object);
  const pending = new ByteQueue();
  let aesKey: CryptoKey;
  let headerLength: number | undefined;
  let header: { readonly frame: number; readonly noncePrefix: Uint8Array } | undefined;
  let index = 0;

  const readHeader = () => {
    if (headerLength === undefined) {
      if (pending.length < 2) return undefined;
      headerLength = new DataView(pending.take(2).buffer).getUint16(0);
      if (headerLength > MAX_HEADER_BYTES) throw new ShareCryptoError({ reason: "malformed" });
    }
    if (pending.length < headerLength) return undefined;
    const decoded = decodeHeader(new TextDecoder().decode(pending.take(headerLength)));
    if (Result.isFailure(decoded)) throw new ShareCryptoError({ reason: "malformed" });
    if (decoded.success.v !== 1) throw new ShareCryptoError({ reason: "unsupported_version" });
    const noncePrefix = Base64Url.decode(decoded.success.np);
    if (Result.isFailure(noncePrefix) || noncePrefix.success.length !== NONCE_PREFIX_BYTES) {
      throw new ShareCryptoError({ reason: "malformed" });
    }
    return { frame: decoded.success.chunk + TAG_BYTES, noncePrefix: noncePrefix.success };
  };

  const open = async (
    controller: TransformStreamDefaultController<Uint8Array>,
    current: NonNullable<typeof header>,
    last: boolean,
  ) => {
    if (index >= MAX_CHUNKS) throw new ShareCryptoError({ reason: "malformed" });
    const sealed = pending.take(last ? pending.length : current.frame);
    const plain = await crypto.subtle
      .decrypt(chunkParams(current.noncePrefix, object, index, last), aesKey, sealed)
      .catch(() => {
        throw new ShareCryptoError({ reason: "authentication_failed" });
      });
    controller.enqueue(new Uint8Array(plain));
    index += 1;
  };

  return new TransformStream({
    async start() {
      aesKey = await objectKey(key, ref);
    },
    async transform(bytes, controller) {
      pending.push(bytes);
      header ??= readHeader();
      if (header === undefined) return;
      // A full frame may still be the last one; open it only once more bytes follow.
      while (pending.length > header.frame) await open(controller, header, false);
    },
    async flush(controller) {
      header ??= readHeader();
      if (header === undefined || pending.length < TAG_BYTES) {
        throw new ShareCryptoError({ reason: "truncated" });
      }
      await open(controller, header, true);
    },
  });
}

async function runThrough(
  bytes: Uint8Array,
  stream: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = input.pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Whole-buffer form of `encryptShareStream`. */
export function encryptShareObject(key: Uint8Array, ref: ShareObjectRef, plaintext: Uint8Array) {
  return runThrough(plaintext, encryptShareStream(key, ref));
}

/** Whole-buffer form of `decryptShareStream`. */
export function decryptShareObject(key: Uint8Array, ref: ShareObjectRef, framed: Uint8Array) {
  return runThrough(framed, decryptShareStream(key, ref));
}
