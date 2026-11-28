// @effect-diagnostics nodeBuiltinImport:off -- A one-way fingerprint of a cookie value.
import * as NodeCrypto from "node:crypto";

/**
 * A short one-way fingerprint of a cookie's value: enough to tell a session rotated, never enough
 * to give the value back.
 */
export const cookieDigest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
