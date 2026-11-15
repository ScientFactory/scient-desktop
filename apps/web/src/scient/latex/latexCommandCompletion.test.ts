import { describe, expect, it } from "vite-plus/test";

import { latexSourceChoices } from "./latexCommandCompletion";

describe("latexSourceChoices", () => {
  it("offers bounded command and environment completions", () => {
    expect(latexSourceChoices("\\[\n\\fra", 7, "source")[0]).toMatchObject({
      label: "\\frac",
      replacement: "\\frac{}{}",
    });
    expect(latexSourceChoices("\\[\n\\begin{ali", 13, "source")[0]).toMatchObject({
      label: "\\begin{align}",
      replacement: "\\begin{align}\n\n\\end{align}",
    });
  });

  describe("inside a citation", () => {
    const library = [
      { key: "lovelace1843notes", detail: "Lovelace 1843 · Notes" },
      { key: "turing1950computing", detail: "Turing 1950 · Computing machinery" },
    ];
    // Stands in for the Library's own ranking: every source whose key or detail has the text.
    const citations = (typed: string) =>
      library.filter((entry) => `${entry.key} ${entry.detail}`.toLowerCase().includes(typed));
    const at = (source: string) =>
      latexSourceChoices(source, source.length, "source", { source, citations });

    it("offers Library sources by key, author or title and inserts the key", () => {
      expect(at("See \\cite{").map((choice) => choice.label)).toEqual([
        "lovelace1843notes",
        "turing1950computing",
      ]);
      const [choice, ...rest] = at("See \\cite{machin");
      expect(rest).toEqual([]);
      expect(choice).toMatchObject({
        label: "turing1950computing",
        preview: "turing1950computing · Turing 1950 · Computing machinery",
        replacement: "turing1950computing",
        from: "See \\cite{".length,
        to: "See \\cite{machin".length,
      });
    });

    it("completes the key being typed after earlier keys and optional notes", () => {
      const source = "\\citep[see][p.~4]{lovelace1843notes, tur";
      expect(at(source)).toMatchObject([
        { label: "turing1950computing", from: source.length - 3, to: source.length },
      ]);
    });

    it("replaces every word of a search for a title, after earlier keys", () => {
      const source = "\\cite{lovelace1843notes, computing machin";
      expect(at(source)).toMatchObject([
        {
          label: "turing1950computing",
          from: "\\cite{lovelace1843notes, ".length,
          to: source.length,
        },
      ]);
    });

    it.each(["citet*", "Citeauthor", "footfullcite", "citetitle", "nocite"])(
      "works in \\%s",
      (command) => {
        expect(at(`\\${command}{love`).map((choice) => choice.label)).toEqual([
          "lovelace1843notes",
        ]);
      },
    );

    it("works in each list of a biblatex multicite", () => {
      const source = "\\parencites(see)()[p.~1]{lovelace1843notes}[p.~2]{tur";
      expect(at(source).map((choice) => choice.label)).toEqual(["turing1950computing"]);
      // A single-list command has ended once its keys are closed.
      expect(at("\\parencite{lovelace1843notes}{tur")).toEqual([]);
    });

    it("leaves a command written after a line break's backslashes alone", () => {
      expect(at("one\\\\cite{tur")).toEqual([]);
      expect(at("one\\\\\\cite{tur").map((choice) => choice.label)).toEqual([
        "turing1950computing",
      ]);
    });

    it("lists the document's own entries first and never repeats one", () => {
      const source = "\\bibitem{lovelace1843notes} Notes.\n\\bibitem{local2020} Local.\n\\cite{l";
      expect(at(source).map((choice) => choice.preview)).toEqual([
        "lovelace1843notes",
        "local2020",
      ]);
    });

    it("offers no Library sources for a cross-reference or a redefined command", () => {
      expect(at("\\label{love}\\ref{").map((choice) => choice.label)).toEqual(["love"]);
      expect(at("\\citestyle{")).toEqual([]);
      expect(
        latexSourceChoices("\\cite{", 6, "source", {
          citations,
          macros: { cite: { parameters: 1, body: "#1" } as never },
        }),
      ).toEqual([]);
    });
  });
});
