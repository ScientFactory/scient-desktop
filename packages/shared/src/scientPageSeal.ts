// @effect-diagnostics nodeBuiltinImport:off -- Sealing runs in the desktop's main process and the server, never a browser.
import * as NodeCrypto from "node:crypto";

/**
 * A page's secrets, sealed in the desktop's main process for its own backend: AES-256-GCM under a
 * key both derive from the desktop's bootstrap secret (the app never holds it). The header (seal
 * id, time, origin, profile, document, offer) is GCM's additional data, checked by the opener.
 */
const INFO = "scient-page-secrets-v2";
const IV = 12;
const TAG = 16;
const HEADER_MAX = 4096;

/** The key a desktop and its backend share for sealing, from the desktop's bootstrap secret. */
export function pageSealKey(bootstrapSecret: string) {
  return Buffer.from(
    NodeCrypto.hkdfSync("sha256", Buffer.from(bootstrapSecret, "utf8"), Buffer.alloc(0), INFO, 32),
  );
}

/** Seals `text` with `header` (JSON) bound to it; a fresh id per seal makes each one single-use. */
export function sealPageSecrets(key: Buffer, header: Record<string, unknown>, text: string) {
  const head = Buffer.from(JSON.stringify({ ...header, sealId: NodeCrypto.randomUUID() }), "utf8");
  if (head.length > HEADER_MAX) return undefined;
  const iv = NodeCrypto.randomBytes(IV);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(head.length);
  return Buffer.concat([size, head, iv, cipher.getAuthTag(), body]).toString("base64url");
}

/**
 * Opens what was sealed under `key`: its header (JSON text, for the opener to check) and text;
 * undefined when it wasn't sealed so, or was changed on the way.
 */
export function openPageSecrets(key: Buffer, sealed: string) {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length < 2) return undefined;
  const size = bytes.readUInt16BE(0);
  const start = 2 + size;
  if (size > HEADER_MAX || bytes.length <= start + IV + TAG) return undefined;
  const head = bytes.subarray(2, start);
  try {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(start, start + IV),
    );
    decipher.setAAD(head);
    decipher.setAuthTag(bytes.subarray(start + IV, start + IV + TAG));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(start + IV + TAG)),
      decipher.final(),
    ]).toString("utf8");
    return { header: head.toString("utf8"), text };
  } catch {
    return undefined;
  }
}
