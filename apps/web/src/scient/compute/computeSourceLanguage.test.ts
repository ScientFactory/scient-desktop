import { describe, expect, it } from "vite-plus/test";

import {
  MATLAB_COMPUTE_SOURCE,
  PYTHON_COMPUTE_SOURCE,
  SQL_COMPUTE_SOURCE,
  computeRunLanguageFor,
  computeSourceLanguageForId,
  computeSourceLanguageForPath,
} from "./computeSourceLanguage";

describe("compute source languages", () => {
  it("gives a notebook in any language a runnable source language", () => {
    expect(computeSourceLanguageForId("python")).toBe(PYTHON_COMPUTE_SOURCE);
    expect(computeSourceLanguageForId("wolfram-language")).toMatchObject({
      languageId: "wolfram-language",
      extensions: [],
    });
  });

  it("maps supported source files without leaking language logic into the inherited viewer", () => {
    expect(computeSourceLanguageForPath("models/analysis.py")).toBe(PYTHON_COMPUTE_SOURCE);
    expect(computeSourceLanguageForPath("models/ANALYSIS.M")).toBe(MATLAB_COMPUTE_SOURCE);
    expect(computeSourceLanguageForPath("analysis.R")?.languageId).toBe("r");
    expect(computeSourceLanguageForPath("model.jl")?.languageId).toBe("julia");
    expect(computeSourceLanguageForPath("queries/report.sql")).toBe(SQL_COMPUTE_SOURCE);
    expect(computeSourceLanguageForPath("notes.md")).toBeNull();
  });

  it("keeps Python and MATLAB cell syntax distinct", () => {
    expect(PYTHON_COMPUTE_SOURCE.cellMarker.test("# %% setup")).toBe(true);
    expect(PYTHON_COMPUTE_SOURCE.cellMarker.test("%% setup")).toBe(false);
    expect(MATLAB_COMPUTE_SOURCE.cellMarker.test("%% setup")).toBe(true);
    expect(MATLAB_COMPUTE_SOURCE.cellMarker.test("# %% setup")).toBe(false);
    expect(SQL_COMPUTE_SOURCE.cellMarker.test("-- %% totals")).toBe(true);
    expect(SQL_COMPUTE_SOURCE.cellMarker.test("# %% totals")).toBe(false);
  });

  it("keeps the registry open to languages with more than one source extension", () => {
    expect(PYTHON_COMPUTE_SOURCE.extensions).toEqual([".py"]);
    expect(MATLAB_COMPUTE_SOURCE.extensions).toEqual([".m"]);
  });
});

describe("the language that really runs a file", () => {
  const installed = (...languages: ReadonlyArray<string>) => ({
    isAvailable: (id: string) => languages.includes(id),
  });
  const run = (
    path: string,
    available: { readonly isAvailable: (id: string) => boolean | null },
    sqliteScript = false,
  ) =>
    computeRunLanguageFor({
      language: computeSourceLanguageForPath(path)!,
      relativePath: path,
      sqliteScript,
      ...available,
    }).languageId;

  it("gives a shared file type to the language on this computer", () => {
    expect(run("plot.gp", installed("gnuplot"))).toBe("gnuplot");
    expect(run("calc.gp", installed("gp"))).toBe("gp");
    expect(run("a.v", installed("verilog"))).toBe("verilog");
    expect(run("a.pro", installed("prolog"))).toBe("prolog");
  });

  it("runs a .m file with Octave only when MATLAB is absent", () => {
    expect(run("a.m", installed("matlab", "octave"))).toBe("matlab");
    expect(run("a.m", installed("octave"))).toBe("octave");
  });

  it("keeps the usual language when none is here, so its page can say how to get it", () => {
    expect(run("a.gp", installed())).toBe("gnuplot");
    expect(run("a.m", installed())).toBe("matlab");
  });

  it("changes nothing until it knows what is installed", () => {
    expect(run("a.m", { isAvailable: () => null })).toBe("matlab");
  });

  it("runs a sqlite3 script with sqlite3 when it is here", () => {
    expect(run("a.sql", installed("sqlite"), true)).toBe("sqlite");
    expect(run("a.sql", installed(), true)).toBe("sql");
    expect(run("a.sql", installed("sqlite"), false)).toBe("sql");
  });

  it("leaves session languages alone", () => {
    expect(run("a.py", installed("gp"))).toBe("python");
  });
});
