import { describe, expect, it } from "vite-plus/test";
import { advanceDownloadProgress, normalizeDownloadProgress } from "./scientDownloadProgress";

describe("display-only download catch-up", () => {
  it("starts gently and accelerates with confirmed headroom", () => {
    const first = advanceDownloadProgress({ value: 0, velocity: 0 }, 30, 16);
    const second = advanceDownloadProgress(first, 30, 16);
    expect(first.value).toBeGreaterThan(0);
    expect(first.value).toBeLessThan(1);
    expect(second.velocity).toBeGreaterThan(first.velocity);
  });

  it("stays monotonic and bounded for irregular increasing readings", () => {
    let frame = { value: 0, velocity: 0 };
    for (const target of [0, 0.2, 3, 18, 18, 49.9, 99.9, 100]) {
      for (const elapsed of [0, 8, 16, 33, 2000, ...Array(100).fill(16)]) {
        const previous = frame.value;
        frame = advanceDownloadProgress(frame, target, elapsed);
        expect(frame.value).toBeGreaterThanOrEqual(previous);
        expect(frame.value).toBeLessThanOrEqual(target);
      }
    }
  });

  it("reaches the confirmed value and stops during a stall", () => {
    let frame = { value: 0, velocity: 0 };
    for (let i = 0; i < 300; i++) frame = advanceDownloadProgress(frame, 20, 16);
    expect(frame).toEqual({ value: 20, velocity: 0 });
    expect(advanceDownloadProgress(frame, 20, 5000)).toEqual(frame);
  });

  it("honors a lower confirmed value without overshooting", () => {
    expect(advanceDownloadProgress({ value: 70, velocity: 80 }, 12, 16)).toEqual({
      value: 12,
      velocity: 0,
    });
  });

  it.each([
    [null, null],
    [NaN, null],
    [Infinity, null],
    [-1, 0],
    [120, 100],
    [42.3, 42.3],
  ])("normalizes %s to %s", (input, expected) =>
    expect(normalizeDownloadProgress(input)).toBe(expected),
  );
});
