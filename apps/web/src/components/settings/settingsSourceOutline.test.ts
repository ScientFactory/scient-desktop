import { describe, expect, it } from "vite-plus/test";
import { settingsSourceOutline } from "./settingsSourceOutline";

describe("raised settings outline", () => {
  it("keeps the design-token body radius independent of the smaller cue", () => {
    const path = settingsSourceOutline(600, 300, 14, 100)!;
    expect(path.match(/A 14 14/g)).toHaveLength(4);
    expect(path).toContain("H 62 Q 68 12.5 68 6.5 Q 68 0.5 74 0.5 H 126");
    expect(path.startsWith("M ")).toBe(true);
    expect(path.endsWith(" Z")).toBe(true);
    expect(path.match(/M /g)).toHaveLength(1);
  });

  it("keeps both main corners intact at either edge", () => {
    for (const center of [0, 600]) {
      const path = settingsSourceOutline(600, 300, 14, center)!;
      expect(path.match(/A 14 14/g)).toHaveLength(4);
      expect(path).not.toMatch(/NaN|Infinity/);
    }
  });

  it("falls back to an ordinary card when the selected item is offscreen or space is insufficient", () => {
    for (const center of [null, -1, 601, NaN]) {
      expect(settingsSourceOutline(600, 300, 14, center)).not.toContain("Q ");
    }
    expect(settingsSourceOutline(40, 50, 14, 20)).not.toContain("Q ");
  });

  it("rejects hidden and invalid geometry and bounds the radius on small cards", () => {
    for (const width of [0, 1, NaN, Infinity])
      expect(settingsSourceOutline(width, 50, 14, 20)).toBeNull();
    expect(settingsSourceOutline(600, 0, 14, 20)).toBeNull();
    expect(settingsSourceOutline(600, 50, -1, 20)).toBeNull();
    expect(settingsSourceOutline(20, 10, 14, 10)).toContain("A 4.5 4.5");
  });
});
