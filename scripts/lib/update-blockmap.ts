// @effect-diagnostics nodeBuiltinImport:off - Release verification reads immutable artifact files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { blake2b } from "@noble/hashes/blake2";

// electron-builder's app-builder writes `<payload>.blockmap` as gzip-compressed JSON listing
// content-defined chunks that cover the whole payload: each chunk's size and the base64 of its
// unkeyed 18-byte BLAKE2b digest. electron-updater trusts those checksums to choose which byte
// ranges of the installed version to reuse, so every chunk must hash to the payload's bytes.
const chunkDigestLength = 18;

/** Throws unless `blockmapPath` is a version 2 blockmap whose chunks are exactly `payloadPath`. */
export function assertBlockmapDescribesPayload(blockmapPath: string, payloadPath: string): void {
  const name = NodePath.basename(blockmapPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeZlib.gunzipSync(NodeFS.readFileSync(blockmapPath)).toString("utf8"));
  } catch {
    throw new Error(`Update blockmap is not gzip-compressed JSON: ${name}.`);
  }
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null && key in value
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const files = field(parsed, "version") === "2" ? field(parsed, "files") : undefined;
  const file = Array.isArray(files) && files.length === 1 ? files[0] : undefined;
  const checksums = field(file, "checksums");
  const sizes = field(file, "sizes");
  if (
    field(file, "name") !== "file" ||
    field(file, "offset") !== 0 ||
    !Array.isArray(checksums) ||
    !Array.isArray(sizes) ||
    sizes.length === 0 ||
    checksums.length !== sizes.length ||
    !checksums.every((checksum) => typeof checksum === "string") ||
    !sizes.every((size) => Number.isSafeInteger(size) && size > 0)
  ) {
    throw new Error(`Update blockmap is not a version 2 single-file blockmap: ${name}.`);
  }
  const payloadSize = NodeFS.statSync(payloadPath).size;
  if (sizes.reduce((total: number, size: number) => total + size, 0) !== payloadSize) {
    throw new Error(`Update blockmap does not cover its payload's ${payloadSize} bytes: ${name}.`);
  }

  const mismatch = (chunk: number) =>
    new Error(`Update blockmap chunk ${chunk} does not match its payload's bytes: ${name}.`);
  const payload = NodeFS.openSync(payloadPath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let chunk = 0;
  let remaining: number = sizes[0];
  let hash = blake2b.create({ dkLen: chunkDigestLength });
  try {
    let bytesRead = 0;
    while ((bytesRead = NodeFS.readSync(payload, buffer, 0, buffer.length, null)) > 0) {
      for (let offset = 0; offset < bytesRead;) {
        if (chunk === sizes.length) throw mismatch(chunk);
        const take = Math.min(remaining, bytesRead - offset);
        hash.update(buffer.subarray(offset, offset + take));
        offset += take;
        remaining -= take;
        if (remaining > 0) continue;
        if (Buffer.from(hash.digest()).toString("base64") !== checksums[chunk]) {
          throw mismatch(chunk);
        }
        chunk += 1;
        remaining = sizes[chunk] ?? 0;
        hash = blake2b.create({ dkLen: chunkDigestLength });
      }
    }
  } finally {
    NodeFS.closeSync(payload);
  }
  if (chunk !== sizes.length) throw mismatch(chunk);
}

/**
 * A blockmap of `payload` in fixed-size chunks, for synthetic release fixtures. app-builder cuts
 * content-defined chunks instead; the verifier accepts any boundaries whose checksums match.
 */
export function createFixtureBlockmap(payload: string, chunkSize = 3): Buffer {
  const bytes = Buffer.from(payload);
  const checksums: Array<string> = [];
  const sizes: Array<number> = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    checksums.push(Buffer.from(blake2b(chunk, { dkLen: chunkDigestLength })).toString("base64"));
    sizes.push(chunk.length);
  }
  return NodeZlib.gzipSync(
    JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums, sizes }] }),
  );
}
