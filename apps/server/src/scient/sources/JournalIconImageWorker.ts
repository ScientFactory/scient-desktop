// @effect-diagnostics nodeBuiltinImport:off -- A short-lived worker contains native decoder faults.
import * as NodeModule from "node:module";
import type * as NativeCanvas from "@napi-rs/canvas";

type ImageMode = "svg" | "raster";

// This function is also serialized for ordinary Node; keep it independent of module closures.
async function decodeImage(
  canvas: typeof NativeCanvas,
  mode: ImageMode,
  bytes: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  if (mode === "raster") {
    const image = await canvas.loadImage(bytes);
    if (!image.complete || !image.naturalWidth || !image.naturalHeight)
      throw new Error("Invalid raster image.");
    return Buffer.from([1]);
  }
  const image = new canvas.Image(width, height);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  image.onload = () => {
    image.decode().then(resolve, reject);
  };
  image.onerror = reject;
  image.src = bytes;
  await promise;
  const output = canvas.createCanvas(width, height);
  output.getContext("2d").drawImage(image, 0, 0, width, height);
  return output.toBuffer("image/png");
}

export function journalImageWorkerSource(): string {
  return `const canvas = require(process.argv[1]);
const bytes = require('node:fs').readFileSync(0);
if (bytes.length > 131072) process.exit(2);
(${decodeImage.toString()})(canvas, process.argv[2], bytes, Number(process.argv[3]), Number(process.argv[4]))
.then(output => process.stdout.write(output)).catch(() => { process.exitCode = 2; });`;
}

export async function runJournalImageWorker(args: readonly string[]): Promise<void> {
  try {
    const [mode, rawWidth, rawHeight] = args;
    if (mode !== "svg" && mode !== "raster") throw new Error("Invalid image mode.");
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (
      mode === "svg" &&
      (!Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 128 ||
        height > 128)
    )
      throw new Error("Invalid image bounds.");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 128 * 1024) throw new Error("Image input exceeds its bound.");
      chunks.push(chunk);
    }
    const canvas = NodeModule.createRequire(import.meta.url)(
      "@napi-rs/canvas",
    ) as typeof NativeCanvas;
    const output = await decodeImage(canvas, mode, Buffer.concat(chunks), width, height);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
    });
  } catch {
    process.exitCode = 2;
  }
}
