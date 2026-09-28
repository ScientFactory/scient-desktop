// @effect-diagnostics nodeBuiltinImport:off -- PNG verification and hashes are server-owned.
import * as NodeCrypto from "node:crypto";

import { mermaidSourcesInMarkdown } from "@scientfactory/scient-markdown";
import {
  type DocumentAsset,
  type DocumentBundle,
  type ScientWordDiagramCapture,
  type ScientWordDiagramPlan,
  type Sha256Digest,
} from "@t3tools/contracts";

import { mermaidDiagramAssetId } from "./pandocPreparation.ts";

const MAX_DIAGRAMS = 64;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class WordDiagramCaptureError extends Error {}

/** Recomputed from the exact Markdown passed to Pandoc, never from client paths. */
export function planWordDiagrams(
  markdown: string,
  sourceDigest: Sha256Digest,
): ScientWordDiagramPlan {
  const byId = new Map<string, string>();
  for (const source of mermaidSourcesInMarkdown(markdown)) {
    const id = mermaidDiagramAssetId(source);
    if (!byId.has(id)) byId.set(id, source);
  }
  const diagrams = [...byId].map(([id, source]) => ({ id, source }));
  if (diagrams.length > MAX_DIAGRAMS || diagrams.some(({ source }) => source.length > 100_000)) {
    throw new WordDiagramCaptureError(
      "This document has too many or oversized Mermaid diagrams for Word export.",
    );
  }
  return { sourceDigest, diagrams };
}

function decodePng(base64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new WordDiagramCaptureError("A diagram PNG is not valid base64.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length < 57 ||
    bytes.length > MAX_PNG_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new WordDiagramCaptureError("A diagram PNG is missing or exceeds the size limit.");
  }
  // Require a standard IHDR, sane canvas size, at least one image-data chunk,
  // and a final IEND. Pandoc sees only these bounded bytes, never a path or URL.
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new WordDiagramCaptureError("A diagram has an invalid PNG header.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 8192 || height > 8192 || width * height > 16_777_216) {
    throw new WordDiagramCaptureError("A diagram PNG has invalid dimensions.");
  }
  let offset = 8;
  let hasImageData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT") hasImageData = true;
    if (kind === "IEND") {
      ended = length === 0 && end === bytes.length;
      break;
    }
    offset = end;
  }
  if (!hasImageData || !ended) throw new WordDiagramCaptureError("A diagram PNG is incomplete.");
  return bytes;
}

export function capturedWordDiagramAssets(
  bundle: DocumentBundle,
  sourceDigest: Sha256Digest,
  capture: ScientWordDiagramCapture | undefined,
): ReadonlyArray<DocumentAsset> {
  // Non-UI callers retain the converter's explicit complete-source fallback
  // and warning. The Word UI always supplies a capture, including an empty one.
  if (capture === undefined) return [];
  const plan = planWordDiagrams(bundle.markdown, sourceDigest);
  if (capture?.sourceDigest !== sourceDigest || capture.diagrams.length !== plan.diagrams.length) {
    throw new WordDiagramCaptureError(
      "The Word diagram capture does not match the current source. Try exporting again.",
    );
  }
  const submitted = new Map(capture.diagrams.map((entry) => [entry.id, entry.result]));
  if (
    submitted.size !== plan.diagrams.length ||
    plan.diagrams.some(({ id }) => !submitted.has(id))
  ) {
    throw new WordDiagramCaptureError(
      "The Word diagram capture has missing or unexpected diagrams.",
    );
  }
  const assets: DocumentAsset[] = [];
  let total = 0;
  for (const { id } of plan.diagrams) {
    const result = submitted.get(id)!;
    if (result._tag === "render-failed") continue;
    const bytes = decodePng(result.base64);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_PNG_BYTES) {
      throw new WordDiagramCaptureError("The diagram PNGs exceed the Word export size limit.");
    }
    assets.push({
      id,
      role: "rendered-diagram",
      fileName: `${id}.png`,
      packagePath: `assets/${id}.png`,
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      content: {
        _tag: "bytes",
        bytes,
        sha256:
          `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest,
      },
    });
  }
  return assets;
}
