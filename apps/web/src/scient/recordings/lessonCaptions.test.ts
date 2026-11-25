import { expect, it, vi } from "vite-plus/test";
import { type CaptionClip, CaptionQueue, CaptionWindows } from "./lessonCaptions";

const RATE = 1000;
const frame = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

it("cuts at the first pause after ten seconds, at thirty seconds, and drops silent clips", () => {
  const clips: CaptionClip[] = [];
  const windows = new CaptionWindows(RATE, (clip) => clips.push(clip));
  for (let index = 0; index < 8; index += 1) windows.push(frame(1), 0.2);
  windows.push(frame(1), 0.001);
  expect(clips).toEqual([]);
  windows.push(frame(1), 0.2);
  windows.push(frame(0.5), 0.001);
  expect(clips.map(({ window, start, end }) => ({ window, start, end }))).toEqual([
    { window: 0, start: 0, end: 10.5 },
  ]);
  for (let index = 0; index < 30; index += 1) windows.push(frame(1), 0.2);
  expect(clips.at(-1)).toMatchObject({ window: 1, start: 10.5, end: 40.5 });
  windows.push(frame(3), 0.001);
  windows.cut();
  expect(clips).toHaveLength(2);
  windows.push(frame(2), 0.2);
  windows.cut();
  expect(clips.at(-1)).toMatchObject({ window: 2, start: 43.5, end: 45.5 });
});

it("transcribes one clip at a time and keeps only the newest waiting clip", async () => {
  const done: number[] = [];
  const releases: (() => void)[] = [];
  const delayed = vi.fn();
  const queue = new CaptionQueue(
    (clip) =>
      new Promise<void>((resolve) =>
        releases.push(() => {
          done.push(clip.window);
          resolve();
        }),
      ),
    delayed,
  );
  const clip = (window: number): CaptionClip => ({ window, start: 0, end: 1, frames: [] });
  queue.add(clip(0));
  queue.add(clip(1));
  queue.add(clip(2));
  expect(delayed).toHaveBeenCalledTimes(1);
  releases.shift()!();
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  releases.shift()!();
  await vi.waitFor(() => expect(done).toEqual([0, 2]));
  queue.close();
  queue.add(clip(3));
  expect(releases).toHaveLength(0);
});
