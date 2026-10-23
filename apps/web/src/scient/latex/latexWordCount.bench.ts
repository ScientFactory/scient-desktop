import { expect, it } from "vite-plus/test";

import { countLatexWords } from "./latexWordCount";

it("bounds counting prose with many unclosed delimiters", async ({ bench }) => {
  const source = "Some words here \\[ never closed \\begin{equation} $ \n".repeat(20000);
  const result = await bench("unclosed delimiters", { async: false }, () =>
    countLatexWords(source),
  ).run({
    time: 0,
    iterations: 1,
    warmup: false,
  });
  expect(result.latency.mean).toBeLessThan(1500);
});

it.for([
  "\\verb|x| word ",
  "\\verb|never closed ",
  "\\textbf[ word ",
  "\\url{never closed ",
  "\\begin{never closed ",
  "\\url{one far closer ",
])("bounds counting a long line of %s", async (fragment, { bench }) => {
  const source = `${fragment.repeat(40000)}${fragment === "\\url{one far closer " ? "}" : ""}`;
  const result = await bench("long literal or unfinished options", { async: false }, () =>
    countLatexWords(source),
  ).run({ time: 0, iterations: 1, warmup: false });
  expect(result.latency.mean).toBeLessThan(1500);
});
