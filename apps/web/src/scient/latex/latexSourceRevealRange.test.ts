import { expect, it } from "vite-plus/test";
import { latexSourceRevealRange } from "./latexSourceRevealRange";

it("retains exact Hebrew source characters", () => {
  const source = "לפני\nזו פסקה בעברית";
  expect(latexSourceRevealRange(source, { source, from: 8, to: 12, precise: true })).toEqual({
    from: 8,
    to: 12,
  });
  expect(
    latexSourceRevealRange(source + " changed", { source, from: 8, to: 12, precise: true }),
  ).toBeNull();
});

it("locates a PDF-selected word only within SyncTeX's source line", () => {
  const source = "word elsewhere\r\n\\textbf{selected} word here";
  expect(latexSourceRevealRange(source, { line: 2, selectedText: "selected" })).toEqual({
    from: 24,
    to: 32,
  });
});

it("uses the column to distinguish repeated words and otherwise keeps line-level mapping", () => {
  const source = "word and word";
  expect(latexSourceRevealRange(source, { line: 1, selectedText: "word", column: 10 })).toEqual({
    from: 9,
    to: 13,
  });
  expect(latexSourceRevealRange(source, { line: 1, selectedText: "word" })).toEqual({
    from: 0,
    to: 13,
  });
});
