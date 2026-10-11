import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  latexReadingFontKey,
  latexReadingFontsReady,
  prepareLatexReadingFonts,
} from "./latexReadingFonts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bounds a stalled reading font, ignores unrelated fonts and changes validity after real metrics arrive", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("getComputedStyle", () => ({ fontFamily: "ReaderFixture" }));
  let complete = () => {};
  const reading = {
    family: "ReaderFixture",
    style: "normal",
    weight: "400",
    stretch: "normal",
    unicodeRange: "U+0-10FFFF",
    status: "unloaded",
    load: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    ),
  };
  const unrelated = { ...reading, family: "OtherUIFixture", load: vi.fn() };
  const element = {
    ownerDocument: { fonts: new Set([reading, unrelated]) },
  } as unknown as HTMLElement;
  const preparation = prepareLatexReadingFonts(element);
  expect(unrelated.load).not.toHaveBeenCalled();
  expect(latexReadingFontsReady(element)).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  await preparation;
  expect(latexReadingFontsReady(element)).toBe(true);
  const fallback = latexReadingFontKey(element);
  expect(fallback).toContain("fallback");
  reading.status = "loaded";
  complete();
  await preparation;
  expect(latexReadingFontKey(element)).not.toBe(fallback);
  expect(latexReadingFontsReady(element)).toBe(true);
});

it("accepts fallback metrics when a bundled font fails rather than stranding opening", async () => {
  vi.stubGlobal("getComputedStyle", () => ({ fontFamily: "serif" }));
  const face = {
    family: "KaTeX_FailureFixture",
    style: "normal",
    weight: "400",
    stretch: "normal",
    unicodeRange: "U+0-10FFFF",
    status: "error",
    load: vi.fn(() => Promise.reject(new Error("unavailable fixture font"))),
  };
  const element = { ownerDocument: { fonts: new Set([face]) } } as unknown as HTMLElement;
  await prepareLatexReadingFonts(element);
  expect(latexReadingFontsReady(element)).toBe(true);
  expect(latexReadingFontKey(element)).toContain("fallback");
});
