import { readImageDimensions } from "@t3tools/shared/imageDimensions";

/** Physical graphicx bounds: image resolution matters when trims use TeX lengths. */
export function latexGraphicsPhysicalSize(bytes: Uint8Array) {
  const pixels = readImageDimensions(bytes);
  if (!pixels) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let x = 72,
    y = 72;
  const valid = (value: number) => Number.isFinite(value) && value > 0 && value <= 100_000;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let at = 2;
      while (at + 4 <= bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1],
          length = data.getUint16(at + 2),
          end = at + 2 + length;
        if (length < 2 || end > bytes.length || marker === 0xda) break;
        if (
          marker === 0xe0 &&
          String.fromCharCode(...bytes.subarray(at + 4, at + 9)) === "JFIF\0" &&
          length >= 16
        ) {
          const unit = bytes[at + 11],
            scale = unit === 1 ? 1 : unit === 2 ? 2.54 : 0;
          const dx = data.getUint16(at + 12) * scale,
            dy = data.getUint16(at + 14) * scale;
          if (valid(dx) && valid(dy)) {
            x = dx;
            y = dy;
          }
        }
        if (
          marker === 0xe1 &&
          String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === "Exif\0\0"
        ) {
          const base = at + 10,
            little = data.getUint16(base) === 0x4949;
          if (data.getUint16(base + 2, little) === 42) {
            const directory = base + data.getUint32(base + 4, little),
              count = data.getUint16(directory, little);
            let dx = 0,
              dy = 0,
              unit = 2;
            for (let index = 0; index < Math.min(count, 128); index++) {
              const field = directory + 2 + index * 12;
              if (field + 12 > end) break;
              const tag = data.getUint16(field, little),
                type = data.getUint16(field + 2, little);
              if (tag === 0x128 && type === 3) unit = data.getUint16(field + 8, little);
              if ((tag === 0x11a || tag === 0x11b) && type === 5) {
                const offset = base + data.getUint32(field + 8, little);
                if (offset + 8 > end) continue;
                const value = data.getUint32(offset, little) / data.getUint32(offset + 4, little);
                if (tag === 0x11a) dx = value;
                else dy = value;
              }
            }
            const scale = unit === 2 ? 1 : unit === 3 ? 2.54 : 0;
            if (valid(dx * scale) && valid(dy * scale)) {
              x = dx * scale;
              y = dy * scale;
            }
          }
        }
        at = end;
      }
    } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      let at = 8;
      while (at + 12 <= bytes.length) {
        const length = data.getUint32(at),
          end = at + 12 + length;
        if (end > bytes.length) break;
        if (
          String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "pHYs" &&
          length === 9 &&
          bytes[at + 16] === 1
        ) {
          const dx = data.getUint32(at + 8) * 0.0254,
            dy = data.getUint32(at + 12) * 0.0254;
          if (valid(dx) && valid(dy)) {
            x = dx;
            y = dy;
          }
        }
        at = end;
      }
    }
  } catch {
    return null;
  }
  return { width: pixels.width / x, height: pixels.height / y };
}

/** Read only a bounded header from the already authorized image URL. */
export async function readLatexGraphicsPhysicalSize(url: string, signal: AbortSignal) {
  const limit = 256 * 1024;
  const response = await fetch(url, { headers: { Range: "bytes=0-" + (limit - 1) }, signal });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value.subarray(0, limit - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return latexGraphicsPhysicalSize(bytes);
}
