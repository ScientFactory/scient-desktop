// @effect-diagnostics nodeBuiltinImport:off -- A short-lived worker contains native decoder faults.
import * as NodeModule from "node:module";
import type * as NativeCanvas from "@napi-rs/canvas";

/** Covers arrive up to this size; the worker refuses anything larger. */
export const MAX_COVER_INPUT_BYTES = 6 * 1024 * 1024;
/** A shrunk cover is a small JPEG; it must fit this bound. */
export const MAX_COVER_OUTPUT_BYTES = 128 * 1024;
/** Tall enough for a crisp cover at card size on a high-density screen. */
export const COVER_HEIGHT = 240;

// This function is also serialized for ordinary Node; keep it independent of module closures.
async function shrinkCover(
  canvas: typeof NativeCanvas,
  bytes: Buffer,
  height: number,
): Promise<Buffer> {
  const image = await canvas.loadImage(bytes);
  if (!image.complete || !image.naturalWidth || !image.naturalHeight)
    throw new Error("Invalid raster image.");
  const scale = Math.min(1, height / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const outputHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const output = canvas.createCanvas(width, outputHeight);
  const context = output.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, outputHeight);
  context.drawImage(image, 0, 0, width, outputHeight);
  return output.toBuffer("image/jpeg", 85);
}

export function journalCoverWorkerSource(): string {
  return `const canvas = require(process.argv[1]);
const bytes = require('node:fs').readFileSync(0);
if (bytes.length > ${MAX_COVER_INPUT_BYTES}) process.exit(2);
(${shrinkCover.toString()})(canvas, bytes, ${COVER_HEIGHT})
.then(output => process.stdout.write(output)).catch(() => { process.exitCode = 2; });`;
}

export async function runJournalCoverWorker(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_COVER_INPUT_BYTES) throw new Error("Image input exceeds its bound.");
      chunks.push(chunk);
    }
    const canvas = NodeModule.createRequire(import.meta.url)(
      "@napi-rs/canvas",
    ) as typeof NativeCanvas;
    const output = await shrinkCover(canvas, Buffer.concat(chunks), COVER_HEIGHT);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
    });
  } catch {
    process.exitCode = 2;
  }
}
