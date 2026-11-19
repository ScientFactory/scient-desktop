import {
  SHARE_CHUNK_BYTES,
  decryptShareStream,
  encryptShareStream,
} from "@scientfactory/scient-cloud/share-crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

/**
 * Envelope encryption for synced copies: a random 32-byte data key per user, wrapped with the
 * Worker's key-encryption key (AES-GCM, AAD = user id). Objects reuse the share stream format
 * with the data key and the object's bucket key as the object name, so a stored object only
 * decrypts at its own key.
 */

const WRAP_PREFIX = "v1.";
const IV_BYTES = 12;
const TAG_BYTES = 16;
// u16 length ‖ {"v":1,"chunk":1048576,"np":"<11 base64url chars>"}
const HEADER_BYTES =
  2 + JSON.stringify({ v: 1, chunk: SHARE_CHUNK_BYTES, np: "A".repeat(11) }).length;

/** Exact stored size, so the bucket can take the encrypted stream with a known length. */
export const encryptedLength = (plainBytes: number) =>
  HEADER_BYTES + plainBytes + TAG_BYTES * Math.max(1, Math.ceil(plainBytes / SHARE_CHUNK_BYTES));

export const importKek = (encoded: string) =>
  Effect.promise(async () => {
    const raw = Base64Url.decode(encoded.trim());
    if (Result.isFailure(raw) || raw.success.length !== 32) {
      throw new Error("SCIENT_CLOUD_KEK must be 32 bytes, base64url.");
    }
    return crypto.subtle.importKey("raw", Uint8Array.from(raw.success), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  });

export const newWrappedDataKey = (kek: CryptoKey, userId: string) =>
  Effect.promise(async () => {
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
        kek,
        dataKey,
      ),
    );
    const out = new Uint8Array(IV_BYTES + sealed.length);
    out.set(iv);
    out.set(sealed, IV_BYTES);
    return `${WRAP_PREFIX}${Base64Url.encode(out)}`;
  });

export const unwrapDataKey = (kek: CryptoKey, userId: string, wrapped: string) =>
  Effect.promise(async () => {
    const raw = wrapped.startsWith(WRAP_PREFIX)
      ? Base64Url.decode(wrapped.slice(WRAP_PREFIX.length))
      : undefined;
    if (raw === undefined || Result.isFailure(raw)) throw new Error("Malformed wrapped data key.");
    const bytes = Uint8Array.from(raw.success);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(0, IV_BYTES),
          additionalData: new TextEncoder().encode(userId),
        },
        kek,
        bytes.subarray(IV_BYTES),
      ),
    );
  });

export const encryptStream = (dataKey: Uint8Array, objectKey: string) =>
  encryptShareStream(dataKey, { version: 1, object: objectKey });

export const decryptStream = (dataKey: Uint8Array, objectKey: string) =>
  decryptShareStream(dataKey, { version: 1, object: objectKey });

export const bytesStream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
