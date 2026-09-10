import { describe, expect, it } from "vite-plus/test";
import {
  capturePdfPassage,
  passageHash,
  passageText,
  verifyPdfPassage,
  PDF_PASSAGE_LIMITS,
  type PassagePage,
  type PassageSelection,
  type PdfPassageCapture,
} from "./pdfPassageModel";

const material = { sha256: passageHash("exact PDF bytes"), byteLength: 15 };
const extractorVersion = "6.2.108";
function selection(overrides: Partial<PassageSelection> = {}): PassageSelection {
  return {
    page: 1,
    text: "A repeated quote. A repeated quote.",
    start: 20,
    end: 28,
    rectangles: [[60, 700, 103, 714]],
    viewBox: [0, 0, 612, 792],
    rotation: 0,
    userUnit: 1,
    ...overrides,
  };
}
function capture(pages = [selection()]): PdfPassageCapture {
  const result = capturePdfPassage({ material, extractorVersion, selection: pages });
  expect(result._tag).toBe("Captured");
  if (result._tag !== "Captured") throw new Error(result.reason);
  return result.capture;
}

describe("experimental PDF passage evidence", () => {
  it("preserves partial-word UTF-16 positions and does not choose the first duplicate", () => {
    const original = capture();
    expect(original.pages[0]?.quote).toBe("repeated");
    expect(original.pages[0]?.start).toBe(20);
    expect(original.pages[0]?.prefix).toBe("A repeated quote. A ");
    expect(
      verifyPdfPassage(original, { material, extractorVersion, pages: [selection()] }),
    ).toEqual({ _tag: "Exact" });
  });

  it("round trips in memory without paths, URLs, or Source metadata", () => {
    const original = capture();
    const reopened = JSON.parse(JSON.stringify(original)) as PdfPassageCapture;
    expect(
      verifyPdfPassage(reopened, {
        material: { ...material },
        extractorVersion,
        pages: [selection()],
      }),
    ).toEqual({ _tag: "Exact" });
    expect(JSON.stringify(original)).not.toMatch(/https?:|sourceId|workspaceRoot/);
  });

  it("copies capture evidence rather than retaining mutable geometry references", () => {
    const rectangles: [number, number, number, number][] = [[60, 700, 103, 714]];
    const original = capture([selection({ rectangles })]);
    rectangles[0]![0] = 99;
    expect(original.pages[0]?.rectangles[0]?.[0]).toBe(60);
  });

  it.each([
    { name: "hash", current: { ...material, sha256: passageHash("other") } },
    { name: "length", current: { ...material, byteLength: 99 } },
  ])("refuses a different material $name, even with identical text", ({ current }) => {
    expect(
      verifyPdfPassage(capture(), { material: current, extractorVersion, pages: [selection()] }),
    ).toEqual({ _tag: "NotExact", reason: "material-changed" });
  });

  it("requires the actual extractor version to match", () => {
    expect(
      verifyPdfPassage(capture(), { material, extractorVersion: "5.4.624", pages: [selection()] }),
    ).toEqual({ _tag: "NotExact", reason: "extractor-changed" });
  });

  it("preserves geometry checks across an extractor upgrade before offering the saved location", () => {
    const original = capture();
    expect(
      verifyPdfPassage(original, {
        material,
        extractorVersion: "future",
        pages: [selection({ viewBox: [0, 0, 600, 800] })],
      }),
    ).toEqual({ _tag: "NotExact", reason: "page-geometry-changed" });
    expect(
      verifyPdfPassage(original, {
        material,
        extractorVersion: "future",
        pages: [selection({ text: "new extraction" })],
      }),
    ).toEqual({ _tag: "NotExact", reason: "extractor-changed" });
    expect(original.pages[0]?.quote).toBe("repeated");
  });

  it.each([
    { text: "A repeated quote. A changed quote." },
    { text: "A changed quote. A repeated quote." },
    { text: "A repeated quote. A repeated quote.\n" },
  ])("refuses text drift rather than silently finding another quote", (change) => {
    const original = capture();
    const before = JSON.stringify(original);
    expect(
      verifyPdfPassage(original, { material, extractorVersion, pages: [selection(change)] }),
    ).toEqual({ _tag: "NotExact", reason: "page-text-changed" });
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each<Partial<PassagePage>>([
    { rotation: 90 },
    { userUnit: 2 },
    { viewBox: [10, 20, 622, 812] },
  ])("refuses a changed native page coordinate system", (change) => {
    expect(
      verifyPdfPassage(capture(), { material, extractorVersion, pages: [selection(change)] }),
    ).toEqual({ _tag: "NotExact", reason: "page-geometry-changed" });
  });

  it.each([
    { pages: [] },
    { pages: [selection({ page: 2 })] },
    { pages: [selection(), selection()] },
  ])("refuses missing or duplicate current pages", ({ pages }) => {
    expect(verifyPdfPassage(capture(), { material, extractorVersion, pages })).toEqual({
      _tag: "NotExact",
      reason: "page-missing",
    });
  });

  it("retains every selected page and rectangle", () => {
    const pages = [
      selection({ start: 0 }),
      selection({
        page: 2,
        rectangles: [
          [60, 700, 103, 714],
          [60, 680, 200, 694],
        ],
      }),
    ];
    const original = capture(pages);
    expect(original.pages).toHaveLength(2);
    expect(original.pages[1]?.rectangles).toHaveLength(2);
    expect(verifyPdfPassage(original, { material, extractorVersion, pages })).toEqual({
      _tag: "Exact",
    });
  });

  it("does not normalize scientific symbols, ligatures, RTL, or composed characters", () => {
    const text = "α − β = 2\nﬀ e\u0301 שלום עולם 🧪";
    const original = capture([selection({ text, start: 0, end: text.length })]);
    expect(original.pages[0]?.quote).toBe(text);
    expect(
      passageText([
        { str: "α − β = 2", hasEOL: true },
        { type: "beginMarkedContent" },
        { str: "ﬀ e\u0301 שלום עולם 🧪" },
      ]),
    ).toBe(text);
  });

  it("matches PDF.js end-of-line behavior, including empty EOL items", () => {
    expect(
      passageText([
        { str: "One" },
        { str: " " },
        { str: "two", hasEOL: true },
        { str: "", hasEOL: true },
        { str: "three" },
      ]),
    ).toBe("One two\n\nthree");
  });

  it.each<Partial<PassageSelection>>([
    { start: -1 },
    { start: 1.5 },
    { end: 999 },
    { start: 10, end: 10 },
    { rectangles: [] },
    { rectangles: [[0, 0, 0, 2]] },
    { rectangles: [[0, 0, Infinity, 20]] },
    { rectangles: [[-100, 0, 20, 20]] },
    { viewBox: [0, 0, 0, 0] },
    { userUnit: 0 },
    { text: "   ", start: 0, end: 3 },
  ])("rejects invalid capture inputs", (change) => {
    expect(
      capturePdfPassage({ material, extractorVersion, selection: [selection(change)] }),
    ).toEqual({ _tag: "Refused", reason: "invalid-selection" });
  });

  it("rejects scans/empty selections, disjoint pages, and bounded-size overflow", () => {
    expect(capturePdfPassage({ material, extractorVersion, selection: [] })).toEqual({
      _tag: "Refused",
      reason: "empty-selection",
    });
    expect(
      capturePdfPassage({
        material,
        extractorVersion,
        selection: [selection(), selection({ page: 3 })],
      }),
    ).toEqual({ _tag: "Refused", reason: "invalid-selection" });
    expect(
      capturePdfPassage({
        material,
        extractorVersion,
        selection: Array.from({ length: 5 }, (_, i) => selection({ page: i + 1 })),
      }),
    ).toEqual({ _tag: "Refused", reason: "selection-too-large" });
    const text = "a".repeat(PDF_PASSAGE_LIMITS.characters + 1);
    expect(
      capturePdfPassage({
        material,
        extractorVersion,
        selection: [selection({ text, start: 0, end: text.length })],
      }),
    ).toEqual({ _tag: "Refused", reason: "selection-too-large" });
  });
});
