import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { ProjectReadFileResult } from "@t3tools/contracts";

export class MarkdownReadSnapshotError extends Error {
  override readonly name = "MarkdownReadSnapshotError";

  constructor(readonly reason: "incomplete" | "encoding") {
    super(
      reason === "incomplete"
        ? "The complete file could not be read. Editing is paused to protect its original contents."
        : "This file cannot be edited as UTF-8 without changing its original bytes. It is available read-only.",
    );
  }
}

/**
 * Editable text must round-trip to the bytes represented by the server's CAS
 * revision. Its non-fatal decoder can replace malformed UTF-8 or strip a BOM;
 * only the latter is recoverable, and only when the raw hash proves it.
 */
export function normalizeMarkdownReadSnapshot(
  snapshot: ProjectReadFileResult,
): ProjectReadFileResult {
  if (snapshot.truncated || snapshot.readOnly) return snapshot;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(snapshot.contents);
  if (`sha256:${bytesToHex(sha256(bytes))}` === snapshot.revision) {
    if (bytes.byteLength !== snapshot.byteLength) throw new MarkdownReadSnapshotError("incomplete");
    return snapshot;
  }
  const bomContents = `\uFEFF${snapshot.contents}`;
  const bomBytes = encoder.encode(bomContents);
  if (`sha256:${bytesToHex(sha256(bomBytes))}` === snapshot.revision) {
    if (bomBytes.byteLength !== snapshot.byteLength)
      throw new MarkdownReadSnapshotError("incomplete");
    return { ...snapshot, contents: bomContents };
  }
  throw new MarkdownReadSnapshotError("encoding");
}
