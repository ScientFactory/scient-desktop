import { describe, expect, it } from "@effect/vitest";

import { citationContext, citationOccurrences } from "./citationOccurrences.ts";

const brief = (kind: "markdown" | "latex", text: string) =>
  citationOccurrences(kind, text).map(({ key, locator, start, end, line, column }) => ({
    key,
    locator,
    text: text.slice(start, end),
    line,
    column,
  }));

describe("citation occurrences", () => {
  it("reads Markdown groups, in-text citations and their locators", () => {
    const text = [
      "Intro [see @a, p. 4; -@b] and @c [chap. 2] then @d.",
      "Mail me@example.org or @{odd key}.",
      "",
    ].join("\n");
    expect(brief("markdown", text)).toEqual([
      { key: "a", locator: "p. 4", text: "[see @a, p. 4; -@b]", line: 1, column: 7 },
      { key: "b", locator: null, text: "[see @a, p. 4; -@b]", line: 1, column: 7 },
      { key: "c", locator: "chap. 2", text: "@c [chap. 2]", line: 1, column: 31 },
      { key: "d", locator: null, text: "@d", line: 1, column: 49 },
    ]);
  });

  it("reads a group whose prose is broken by emphasis or a soft line break", () => {
    expect(brief("markdown", "As [*see* @a,\np. 4] says.\n")).toEqual([
      { key: "a", locator: "p. 4", text: "[*see* @a,\np. 4]", line: 1, column: 4 },
    ]);
  });

  it.each([
    "Inline `[@a]` code.\n",
    "```\n[@a]\n```\n",
    "Math $[@a]$ here.\n",
    "A [link @a](https://example.test) here.\n",
    "See https://example.test/x;@a today.\n",
    "---\ntitle: '@a'\n---\nBody.\n",
    "<span>[@a]</span>\n",
    "Escaped \\@a here.\n",
    "Mail a@a.org.\n",
  ])("finds no Markdown citation outside prose: %j", (text) => {
    expect(citationOccurrences("markdown", text)).toEqual([]);
  });

  it("reads LaTeX citations with notes, key lists and biblatex multicites", () => {
    const text = [
      "As \\citep[see][p.~4]{a} and \\cite{b, c}.",
      "\\textcite[12]{d} \\cites[p.~1]{e}[p.~2]{f}",
      "",
    ].join("\n");
    expect(brief("latex", text)).toEqual([
      { key: "a", locator: "p.~4", text: "\\citep[see][p.~4]{a}", line: 1, column: 4 },
      { key: "b", locator: null, text: "\\cite{b, c}", line: 1, column: 29 },
      { key: "c", locator: null, text: "\\cite{b, c}", line: 1, column: 29 },
      { key: "d", locator: "12", text: "\\textcite[12]{d}", line: 2, column: 1 },
      { key: "e", locator: "p.~1", text: "\\cites[p.~1]{e}[p.~2]{f}", line: 2, column: 18 },
      { key: "f", locator: "p.~2", text: "\\cites[p.~1]{e}[p.~2]{f}", line: 2, column: 18 },
    ]);
  });

  it("marks \\nocite entries as listed without a citation", () => {
    expect(
      citationOccurrences("latex", "\\cite{a}\n\\nocite{b}\n\\nocite{*}\n").map(
        ({ key, listedOnly }) => ({ key, listedOnly }),
      ),
    ).toEqual([
      { key: "a", listedOnly: false },
      { key: "b", listedOnly: true },
    ]);
  });

  it.each([
    "% \\cite{a}\nText.\n",
    "\\begin{verbatim}\n\\cite{a}\n\\end{verbatim}\n",
    "\\verb|\\cite{a}|\n",
  ])("finds no LaTeX citation in comments or verbatim text: %j", (text) => {
    expect(citationOccurrences("latex", text)).toEqual([]);
  });

  // regression: a comment between a command and its arguments hid the citation; one inside a
  // key list became part of a key.
  it.each([
    {
      text: "See \\cite % formatting\n  {soil}.\n",
      expected: [{ key: "soil", locator: null }],
    },
    {
      text: "See \\citep[see] % the page\n[p.~4]{soil}.\n",
      expected: [{ key: "soil", locator: "p.~4" }],
    },
    {
      text: "See \\cite{a, % b}, c\n soil}.\n",
      expected: [
        { key: "a", locator: null },
        { key: "soil", locator: null },
      ],
    },
  ])("reads LaTeX arguments across comments: %j", ({ text, expected }) => {
    expect(
      citationOccurrences("latex", text).map(({ key, locator, line }) => ({ key, locator, line })),
    ).toEqual(expected.map((item) => ({ ...item, line: 1 })));
  });
});

describe("citation context", () => {
  it("keeps a short line whole, on one line", () => {
    const text = "Before.\n  Soil holds carbon [@a].  \nAfter.";
    const start = text.indexOf("[@a]");
    expect(citationContext(text, start, start + 4)).toEqual({
      text: "Soil holds carbon [@a].",
      start: 18,
      end: 22,
    });
  });

  it("narrows a long line to the sentence, then to about 200 characters around the citation", () => {
    const filler = "word ".repeat(60).trim();
    const text = `First sentence ${filler}. Soil holds carbon [@a] as shown. Next ${filler}.`;
    const start = text.indexOf("[@a]");
    const sentence = citationContext(text, start, start + 4);
    expect(sentence.text).toBe("Soil holds carbon [@a] as shown.");
    const long = `${filler} [@a] ${filler}`;
    const at = long.indexOf("[@a]");
    const window = citationContext(long, at, at + 4);
    expect(window.text.length).toBeLessThanOrEqual(202);
    expect(window.text.slice(window.start, window.end)).toBe("[@a]");
    expect(window.text.startsWith("…")).toBe(true);
    expect(window.text.endsWith("…")).toBe(true);
  });
});
