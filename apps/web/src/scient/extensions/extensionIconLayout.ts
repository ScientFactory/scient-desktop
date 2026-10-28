/** Transparent marks fill 78% of a tile after removing the source's alpha margins. */
export function extensionMarkLayout(pixels: ArrayLike<number>, width: number, height: number) {
  if (width < 1 || height < 1 || pixels.length !== width * height * 4) return undefined;
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  if (corners.every((pixel) => pixels[pixel * 4 + 3]! >= 250)) return undefined;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3]! <= 8) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return undefined;
  const w = right - left + 1;
  const h = bottom - top + 1;
  const scale = (256 * 0.78) / Math.max(w, h);
  return {
    source: [left, top, w, h] as const,
    destination: [(256 - w * scale) / 2, (256 - h * scale) / 2, w * scale, h * scale] as const,
  };
}
