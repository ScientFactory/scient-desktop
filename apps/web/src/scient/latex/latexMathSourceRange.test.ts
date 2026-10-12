import { expect, it } from "vite-plus/test";
import { latexMathSourceRange } from "./latexMathSourceRange";

it("maps a Hebrew document's matrix entry through its grid coordinates", () => {
  const source =
    "\\[A=\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}, |x|=\\begin{cases}x&x>0\\\\-x&x<0\\end{cases}\\]";
  const range = latexMathSourceRange(
    source,
    [{ environment: "pmatrix", row: 1, rows: 2, column: 1, columns: 2 }],
    "4",
  );
  expect(range).toEqual({ from: source.indexOf("4"), to: source.indexOf("4") + 1 });
});
it("maps the second aligned row even when its text repeats", () => {
  const source = "\\begin{align}x&=1\\\\x&=1\\end{align}";
  const range = latexMathSourceRange(
    source,
    [{ environment: "aligned", row: 1, rows: 2, column: 1, columns: 2 }],
    "1",
  );
  expect(range).toEqual({ from: source.lastIndexOf("1"), to: source.lastIndexOf("1") + 1 });
});
it("does not guess between repeated grids", () => {
  const source = "\\begin{pmatrix}1&2\\end{pmatrix}+\\begin{pmatrix}1&2\\end{pmatrix}";
  expect(
    latexMathSourceRange(
      source,
      [{ environment: "pmatrix", row: 0, rows: 1, column: 1, columns: 2 }],
      "2",
    ),
  ).toBeNull();
});
it("ignores matching letters inside TeX command names", () => {
  const source = "\\(\\sin(x)+n\\)";
  expect(latexMathSourceRange(source, [], "n")).toEqual({
    from: source.indexOf("+n") + 1,
    to: source.indexOf("+n") + 2,
  });
});
