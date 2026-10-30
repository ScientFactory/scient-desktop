import { describe, expect, it } from "vite-plus/test";

import {
  MATLAB_COMPUTE_SOURCE,
  PYTHON_COMPUTE_SOURCE,
  SQL_COMPUTE_SOURCE,
  computeSourceLanguageForPath,
} from "./computeSourceLanguage";

describe("compute source languages", () => {
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
