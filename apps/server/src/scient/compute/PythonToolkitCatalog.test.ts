import { describe, expect, it } from "vite-plus/test";

import {
  ComputeLanguageId,
  type ComputeRuntimeVerification,
  ComputeToolkitId,
} from "@scientfactory/compute";

import { OBSERVED_PYTHON_PACKAGES, PYTHON_LANGUAGE_ID } from "./PythonRuntimeAdapter.ts";
import {
  PYTHON_DATA_AND_FIGURES_TOOLKIT,
  PYTHON_TOOLKIT_CATALOG,
  PYTHON_TOOLKIT_EXTRAS,
  assessPythonToolkit,
} from "./PythonToolkitCatalog.ts";

const verification = (
  input: Partial<ComputeRuntimeVerification> = {},
): ComputeRuntimeVerification => ({
  profile: {
    languageId: PYTHON_LANGUAGE_ID,
    source: "project",
    executable: "/project/.venv/bin/python",
    languageVersion: "3.12.4",
    architecture: "arm64",
    displayName: "Python 3.12.4 (project)",
  },
  readiness: "ready",
  missingRequirements: [],
  message: null,
  packages: [
    { name: "ipykernel", version: "6.29.5" },
    { name: "jupyter_client", version: "8.6.3" },
    { name: "matplotlib", version: "3.9.1" },
    { name: "nbformat", version: "5.10.4" },
    { name: "numpy", version: "2.0.1" },
    { name: "pandas", version: "2.2.2" },
    { name: "plotly", version: "6.3.0" },
    { name: "scipy", version: "1.14.0" },
    { name: "scikit-learn", version: "1.9.1" },
    { name: "seaborn", version: "0.13.2" },
    { name: "statsmodels", version: "0.15.0" },
    { name: "sympy", version: "1.14.0" },
    { name: "openpyxl", version: "3.1.5" },
    { name: "pyyaml", version: "6.0.3" },
    { name: "pillow", version: "12.3.0" },
    { name: "requests", version: "2.34.2" },
    { name: "pypdf", version: "6.19.0" },
    { name: "tabulate", version: "0.10.0" },
    { name: "jinja2", version: "3.1.6" },
    { name: "defusedxml", version: "0.7.1" },
  ],
  ...input,
});

describe("Python Toolkit catalog", () => {
  it("keeps every catalog package observable and every Toolkit provisionable", () => {
    const ids = PYTHON_TOOLKIT_CATALOG.map((toolkit) => toolkit.toolkitId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(PYTHON_TOOLKIT_EXTRAS)).toEqual(ids);
    for (const toolkit of PYTHON_TOOLKIT_CATALOG) {
      for (const requirement of toolkit.packageRequirements) {
        expect(OBSERVED_PYTHON_PACKAGES).toContain(requirement.name);
      }
    }
  });

  it("marks the Toolkit ready only when the exact verified runtime has every package", () => {
    expect(assessPythonToolkit(PYTHON_DATA_AND_FIGURES_TOOLKIT, verification())).toMatchObject({
      toolkitId: "python-data-and-figures",
      readiness: "ready",
      missingRequirements: [],
      runtime: { executable: "/project/.venv/bin/python" },
    });
  });

  it("reports missing scientific packages without confusing them with bridge readiness", () => {
    const result = assessPythonToolkit(
      PYTHON_DATA_AND_FIGURES_TOOLKIT,
      verification({
        packages: verification().packages.map((candidate) =>
          candidate.name === "scipy" ? { ...candidate, version: null } : candidate,
        ),
      }),
    );

    expect(result.readiness).toBe("missing-requirement");
    expect(result.missingRequirements).toEqual(["SciPy"]);
  });

  it.each(
    PYTHON_TOOLKIT_CATALOG.flatMap((toolkit) =>
      toolkit.packageRequirements.map((requirement) => ({ toolkit, requirement })),
    ),
  )(
    "does not hide a missing $requirement.name behind other installed toolkits",
    ({ toolkit, requirement }) => {
      const complete = PYTHON_TOOLKIT_CATALOG.flatMap((item) => item.packageRequirements).map(
        (item) => ({ name: item.name, version: item.minimumVersion ?? "99.0" }),
      );
      const observed = verification({
        packages: complete.filter((item) => item.name !== requirement.name),
      });
      expect(assessPythonToolkit(toolkit, observed)).toMatchObject({
        readiness: "missing-requirement",
        missingRequirements: [requirement.displayName],
      });
      expect(observed.readiness).toBe("ready");
    },
  );

  it("does not call a Toolkit ready when the runtime itself cannot start compute", () => {
    const result = assessPythonToolkit(
      PYTHON_DATA_AND_FIGURES_TOOLKIT,
      verification({
        readiness: "missing-requirement",
        missingRequirements: ["ipykernel"],
        message: "Create or select a ready Python environment.",
      }),
    );

    expect(result.readiness).toBe("runtime-unavailable");
    expect(result.missingRequirements).toEqual(["ipykernel"]);
  });

  it("refuses to assess a Toolkit against a runtime from another language", () => {
    const descriptor = {
      ...PYTHON_DATA_AND_FIGURES_TOOLKIT,
      toolkitId: ComputeToolkitId.make("r-data-and-figures"),
      languageId: ComputeLanguageId.make("r"),
    };
    const result = assessPythonToolkit(descriptor, verification());

    expect(result.readiness).toBe("runtime-unavailable");
    expect(result.missingRequirements).toEqual(["This Toolkit does not belong to Python."]);
  });

  it("applies a minimum version only when a reviewed requirement declares one", () => {
    const descriptor = {
      ...PYTHON_DATA_AND_FIGURES_TOOLKIT,
      packageRequirements: [{ name: "numpy", displayName: "NumPy", minimumVersion: "2.1" }],
    };
    const result = assessPythonToolkit(descriptor, verification());

    expect(result.readiness).toBe("missing-requirement");
    expect(result.missingRequirements).toEqual(["NumPy >= 2.1 (found 2.0.1)"]);
  });
});
