// @effect-diagnostics nodeBuiltinImport:off -- Counts actual isolated decoder processes.
import * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, it } from "@effect/vitest";
import { rasterizeJournalSvg, validateJournalRaster } from "./JournalIconImage.ts";

vi.mock("node:child_process", { spy: true });

it("preserves a complete SVG's proportions and transparent edges as inert pixels", async () => {
  const png = await rasterizeJournalSvg(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><circle cx="20" cy="10" r="9" fill="#112233"/></svg>',
    ),
  );
  const image = await loadImage(png!);
  expect(image.width / image.height).toBe(2);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  expect([...context.getImageData(image.width / 2, image.height / 2, 1, 1).data]).toEqual([
    17, 34, 51, 255,
  ]);
  expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
});

it.each([
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
  '<svg xmlns="http://www.w3.org/2000/svg"><use href="&#104;ttps://example.org/image.svg#x"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.org/style.css";</style></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>active</div></foreignObject></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https://example.org/paint)"/></svg>',
  '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><s:image x:href="file:///etc/passwd"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><use x:href="https://example.org/payload.svg"/></svg>',
])("rejects active, embedded or externally referenced SVG content: %s", async (svg) => {
  expect(await rasterizeJournalSvg(Buffer.from(svg))).toBeNull();
});

it("rejects truncated and decompression-bomb raster headers rather than caching broken icons", async () => {
  const png = createCanvas(32, 32).toBuffer("image/png");
  expect(await validateJournalRaster(png)).toBe(true);
  expect(await validateJournalRaster(png.subarray(0, 24))).toBe(false);
  // Even a native decoder fault must leave subsequent icon operations working.
  expect(await validateJournalRaster(png)).toBe(true);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(100_000, 16);
  oversized.writeUInt32BE(100_000, 20);
  expect(await validateJournalRaster(oversized)).toBe(false);
});

it("accepts passive SVG export comments and metadata without treating them as CSS", async () => {
  const png = await rasterizeJournalSvg(
    Buffer.from(
      '\uFEFF<!-- Generator: Illustrator --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>art@example.org</title><metadata>C:\\exports\\logo.svg</metadata><rect width="10" height="10" fill="#112233"/></svg>',
    ),
  );
  const image = await loadImage(png!);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  expect([...context.getImageData(64, 64, 1, 1).data]).toEqual([17, 34, 51, 255]);
});

it("bounds PNG payload dimensions hidden inside an ICO directory entry", async () => {
  const png = createCanvas(1, 1).toBuffer("image/png");
  png.writeUInt32BE(20_000, 16);
  png.writeUInt32BE(20_000, 20);
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory[6] = 16;
  directory[7] = 16;
  directory.writeUInt32LE(png.length, 14);
  directory.writeUInt32LE(22, 18);
  expect(await validateJournalRaster(Buffer.concat([directory, png]))).toBe(false);
});

it("bounds native processes and releases an aborted waiter's slot", async () => {
  const { spawn: realSpawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  let active = 0;
  let maximum = 0;
  using _spawn = vi
    .spyOn(NodeChildProcess, "spawn")
    .mockImplementation((...args: Parameters<typeof NodeChildProcess.spawn>) => {
      const child = realSpawn(...args);
      maximum = Math.max(maximum, ++active);
      child.once("close", () => {
        active--;
      });
      return child;
    });
  const png = createCanvas(32, 32).toBuffer("image/png");
  const pending = Array.from({ length: 8 }, () => validateJournalRaster(png));
  const controller = new AbortController();
  const cancelled = validateJournalRaster(png, controller.signal);
  controller.abort();
  expect(await cancelled).toBe(false);
  expect(await Promise.all(pending)).toEqual(Array(8).fill(true));
  expect(maximum).toBeLessThanOrEqual(3);
  expect(active).toBe(0);
  expect(await validateJournalRaster(png)).toBe(true);
});
