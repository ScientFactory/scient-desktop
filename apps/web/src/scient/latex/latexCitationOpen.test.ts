import { describe, expect, it } from "vite-plus/test";

import {
  isCitationOpenClick,
  latexCitationOpenItems,
  latexSourceCitationAt,
} from "./latexCitationOpen";
import { latexCitationParts } from "./latexVisualDocument";

/** The citation a click at the `|` lands in. */
function clickAt(marked: string) {
  const offset = marked.indexOf("|");
  return latexSourceCitationAt(marked.slice(0, offset) + marked.slice(offset + 1), offset);
}

describe("latexSourceCitationAt", () => {
  it("opens every key from the command name and only the clicked key from its list", () => {
    expect(clickAt(String.raw`See \ci|te{a,b}.`)?.items).toEqual([
      { key: "a", locator: null },
      { key: "b", locator: null },
    ]);
    expect(clickAt(String.raw`See \cite{a, |b}.`)?.items).toEqual([{ key: "b", locator: null }]);
    expect(clickAt(String.raw`See \cite{a,b|}.`)?.items).toEqual([{ key: "b", locator: null }]);
  });

  it("gives the postnote only to a lone key", () => {
    expect(clickAt(String.raw`\citep[see][p.~4]{|a}`)?.items).toEqual([
      { key: "a", locator: "p.~4" },
    ]);
    expect(clickAt(String.raw`\cite[p.~4]{a,|b}`)?.items).toEqual([{ key: "b", locator: null }]);
    // A click on the note itself, even across a command in it, opens the whole citation.
    expect(clickAt(String.raw`\cite[p.~4\,f|f]{a,b}`)?.items).toHaveLength(2);
  });

  it("opens one list of a multicite with its own note", () => {
    expect(clickAt(String.raw`\parencites[p.~4]{a}[p.~9]{|b}`)?.items).toEqual([
      { key: "b", locator: "p.~9" },
    ]);
  });

  it("finds nothing outside a citation, in a comment or after an escaped backslash", () => {
    expect(clickAt(String.raw`\cite{a} and |more`)).toBeNull();
    expect(clickAt(String.raw`\emph{|a}`)).toBeNull();
    expect(clickAt(String.raw`% \cite{|a}`)).toBeNull();
    expect(clickAt(String.raw`\\cite{|a}`)).toBeNull();
    expect(clickAt(String.raw`50\% \cite{|a}`)?.items).toEqual([{ key: "a", locator: null }]);
  });

  it("finds nothing in verbatim text, a displayed example of a citation", () => {
    for (const environment of ["verbatim", "Verbatim", "lstlisting", "minted", "comment"]) {
      const options = environment === "minted" ? "{latex}" : "";
      expect(
        clickAt(`\\begin{${environment}}${options}\nSee \\cite{|soil2021}.\n\\end{${environment}}`),
      ).toBeNull();
    }
    const pipes = String.raw`Write \verb|\cite{soil2021}| for it.`;
    expect(latexSourceCitationAt(pipes, pipes.indexOf("soil") + 1)).toBeNull();
    expect(clickAt(String.raw`Write \verb+\cite{s|oil2021}+ for it.`)).toBeNull();
    expect(clickAt(String.raw`Write \lstinline!\cite{s|oil2021}! for it.`)).toBeNull();
    // Verbatim text before a real citation does not hide it.
    expect(clickAt(String.raw`\verb!\cite{x}! and \cite{|a}`)?.items).toEqual([
      { key: "a", locator: null },
    ]);
  });

  it("skips a comment between the command and its keys, and a commented-out key", () => {
    expect(clickAt("\\cite % the pivotal study\n  {|a}")?.items).toEqual([
      { key: "a", locator: null },
    ]);
    expect(clickAt("\\cite[p.~4]% note\n{|a}")?.items).toEqual([{ key: "a", locator: "p.~4" }]);
    expect(clickAt("\\cite{a, % b,\n  |c}")?.items).toEqual([{ key: "c", locator: null }]);
    expect(clickAt("\\ci|te{a, % b,\n  c}")?.items).toEqual([
      { key: "a", locator: null },
      { key: "c", locator: null },
    ]);
    expect(clickAt("\\cite{a, % |b,\n  c}")).toBeNull();
  });

  it("reads the quote that Quote in my document writes before the citation", () => {
    expect(clickAt(String.raw`“A 50\% rise” \cite[p.~4]{|a}`)).toEqual({
      items: [{ key: "a", locator: "p.~4" }],
      quote: "A 50% rise",
    });
    expect(clickAt(String.raw`“Quoted” earlier. \cite{|a}`)?.quote).toBeNull();
  });
});

describe("latexCitationOpenItems", () => {
  it("builds a visual citation's items from its node source", () => {
    const one = latexCitationParts(String.raw`\cite[p.~4]{a}`)!;
    expect(latexCitationOpenItems(one.argument, one.notes, null)).toEqual([
      { key: "a", locator: "p.~4" },
    ]);
    const two = latexCitationParts(String.raw`\citep[see][p.~4]{a,b}`)!;
    expect(latexCitationOpenItems(two.argument, two.notes, null)).toEqual([
      { key: "a", locator: null },
      { key: "b", locator: null },
    ]);
    expect(latexCitationOpenItems(two.argument, two.notes, "b")).toEqual([
      { key: "b", locator: null },
    ]);
  });
});

describe("isCitationOpenClick", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  it("follows Command-click on a Mac and Control-click elsewhere", () => {
    expect(isCitationOpenClick({ ...click, metaKey: true }, "MacIntel")).toBe(true);
    expect(isCitationOpenClick({ ...click, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isCitationOpenClick({ ...click, ctrlKey: true }, "Win32")).toBe(true);
    expect(isCitationOpenClick({ ...click, ctrlKey: true, shiftKey: true }, "Win32")).toBe(false);
  });
});
