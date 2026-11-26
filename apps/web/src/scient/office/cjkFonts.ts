import { BUNDLED_FONTS, type BundledFontFace } from "@betteroffice/fonts";
import { CJK_FONT_BROTLI_URLS } from "virtual:scient-cjk-fonts";

// `@betteroffice/fonts-cjk`'s Chinese, Japanese and Korean faces are about 35 MB of OTF. The app ships them
// Brotli-compressed (`scripts/scientCjkFonts.ts`, about 25 MB) and restores the original bytes here, which both the
// office engines' WebAssembly, which reads only raw OpenType, and the browser's FontFace receive.

const CJK_FILES = new Set(
  BUNDLED_FONTS.filter((face) => face.script?.startsWith("cjk-")).map((face) => face.file),
);
const loads = new Map<string, Promise<ArrayBuffer>>();

/** Whether a bundled face is one of the CJK faces the app ships compressed. */
export function isCompressedCjkFace(face: BundledFontFace) {
  return CJK_FILES.has(face.file);
}

/** A CJK face's original bytes. Cached per worker, like the font package's own faces; a failed load can be retried. */
export function loadCjkFaceBytes(face: BundledFontFace): Promise<ArrayBuffer> {
  const existing = loads.get(face.file);
  if (existing) return existing;

  const loading = (async () => {
    const url = CJK_FONT_BROTLI_URLS[face.file];
    if (!url) throw new Error(`Bundled CJK font ${face.file} is missing from the build`);

    const [response, { default: brotliReady }] = await Promise.all([
      fetch(url),
      import("brotli-dec-wasm"),
    ]);
    if (!response.ok) {
      throw new Error(`Failed to fetch bundled font ${face.file}: HTTP ${response.status}`);
    }
    const brotli = await brotliReady;
    const bytes = brotli.decompress(new Uint8Array(await response.arrayBuffer()));
    if (bytes.byteLength !== face.byteLength) {
      throw new Error(
        `Bundled font ${face.file} decoded to ${bytes.byteLength} bytes, expected ${face.byteLength}`,
      );
    }
    // The decoder returns a copy out of its memory that owns its whole buffer.
    return bytes.buffer as ArrayBuffer;
  })();

  loading.catch(() => {
    if (loads.get(face.file) === loading) loads.delete(face.file);
  });
  loads.set(face.file, loading);
  return loading;
}
