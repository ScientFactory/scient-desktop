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
