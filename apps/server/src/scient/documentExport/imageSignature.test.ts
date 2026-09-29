import { describe, expect, it } from "vite-plus/test";

import { hasImageSignature, imageFormatLabel } from "./imageSignature.ts";

const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number>>) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? [...new TextEncoder().encode(part)] : part,
    ),
  );

describe("image signatures", () => {
  it("accepts each supported format's own signature", () => {
    for (const [mediaType, sample] of [
      ["image/png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
      ["image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])],
      ["image/gif", bytes("GIF89a", [1])],
      ["image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")],
      ["image/avif", bytes([0, 0, 0, 28], "ftypavif", [0, 0, 0, 0], "avifmif1miaf")],
      ["image/avif", bytes([0, 0, 0, 24], "ftypmif1", [0, 0, 0, 0], "avif")],
      ["image/bmp", bytes("BM", [0, 0])],
      ["image/svg+xml", bytes('﻿<?xml version="1.0"?>\n<!-- c -->\n<svg viewBox="0 0 1 1"/>')],
    ] as const) {
      expect(hasImageSignature(sample, mediaType), mediaType).toBe(true);
    }
  });

  it("refuses bytes that are another format, empty, or text", () => {
    const heic = bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0], "mif1heic");
    expect(hasImageSignature(heic, "image/jpeg")).toBe(false);
    expect(hasImageSignature(heic, "image/avif")).toBe(false);
    expect(hasImageSignature(new Uint8Array(), "image/png")).toBe(false);
    expect(hasImageSignature(bytes("plain text"), "image/svg+xml")).toBe(false);
    expect(hasImageSignature(bytes([0xff, 0xd8, 0xff]), "image/png")).toBe(false);
    expect(hasImageSignature(bytes("RIFF", [0, 0, 0, 0], "WAVE"), "image/webp")).toBe(false);
    expect(hasImageSignature(bytes("GIF89a"), "image/tiff")).toBe(false);
  });

  it("names formats for messages", () => {
    expect(imageFormatLabel("IMAGE/JPEG")).toBe("JPEG");
    expect(imageFormatLabel("image/tiff")).toBe("image");
  });
});
