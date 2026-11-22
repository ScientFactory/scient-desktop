// @effect-diagnostics nodeBuiltinImport:off -- Counts actual isolated decoder processes.
import * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, it } from "@effect/vitest";

import { shrinkJournalCover } from "./JournalCoverImage.ts";
import { COVER_HEIGHT } from "./JournalCoverImageWorker.ts";

vi.mock("node:child_process", { spy: true });

function cover(width: number, height: number, type: "image/png" | "image/jpeg" = "image/png") {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#1769aa";
  context.fillRect(0, 0, width, height);
  return type === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg");
}

it("shrinks a cover to a JPEG of card height with its proportions", async () => {
  for (const type of ["image/png", "image/jpeg"] as const) {
    const output = await shrinkJournalCover(cover(600, 800, type));
    expect(output?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const image = await loadImage(output!);
    expect(image.height).toBe(COVER_HEIGHT);
    expect(image.width).toBe(180);
  }
});

it("never enlarges a small cover", async () => {
  const image = await loadImage((await shrinkJournalCover(cover(90, 120)))!);
  expect([image.width, image.height]).toEqual([90, 120]);
});

it("refuses unknown formats, truncated images and oversized declared dimensions", async () => {
  const png = cover(32, 32);
  expect(await shrinkJournalCover(Buffer.from("<html>Not found</html>"))).toBeNull();
  expect(await shrinkJournalCover(png.subarray(0, 40))).toBeNull();
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(100_000, 16);
  oversized.writeUInt32BE(100_000, 20);
  expect(await shrinkJournalCover(oversized)).toBeNull();
  // A decoder fault leaves later covers working.
  expect(await shrinkJournalCover(png)).not.toBeNull();
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
  const png = cover(64, 64);
  const pending = Array.from({ length: 8 }, () => shrinkJournalCover(png));
  const controller = new AbortController();
  const cancelled = shrinkJournalCover(png, controller.signal);
  controller.abort();
  expect(await cancelled).toBeNull();
  expect((await Promise.all(pending)).every((output) => output !== null)).toBe(true);
  expect(maximum).toBeLessThanOrEqual(3);
  expect(active).toBe(0);
});
