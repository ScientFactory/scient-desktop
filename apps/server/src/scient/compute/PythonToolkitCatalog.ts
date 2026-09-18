import {
  ComputeToolkitId,
  type ComputeToolkitAssessment,
  type ComputeToolkitDescriptor,
  type ComputeRuntimeVerification,
} from "@scientfactory/compute";

import { PYTHON_LANGUAGE_ID, meetsPythonMinimumVersion } from "./PythonRuntimeAdapter.ts";

/**
 * Scientific Python is the required base of every managed generation. Exact
 * versions and hashes remain owned by the managed-environment lock; this
 * catalog owns stable user-facing capability and package identities.
 */
export const PYTHON_DATA_AND_FIGURES_TOOLKIT: ComputeToolkitDescriptor = {
  toolkitId: ComputeToolkitId.make("python-data-and-figures"),
  languageId: PYTHON_LANGUAGE_ID,
  displayName: "Scientific Python",
  summary: "Data, statistics, models, figures, spreadsheets, images, PDFs, and everyday files.",
  required: true,
  packageRequirements: [
    { name: "numpy", displayName: "NumPy", minimumVersion: null },
    { name: "pandas", displayName: "pandas", minimumVersion: null },
    { name: "scipy", displayName: "SciPy", minimumVersion: null },
    { name: "matplotlib", displayName: "Matplotlib", minimumVersion: null },
    { name: "nbformat", displayName: "nbformat", minimumVersion: "4.2" },
    { name: "plotly", displayName: "Plotly", minimumVersion: null },
    { name: "seaborn", displayName: "Seaborn", minimumVersion: null },
    { name: "statsmodels", displayName: "statsmodels", minimumVersion: null },
    { name: "sympy", displayName: "SymPy", minimumVersion: null },
    { name: "scikit-learn", displayName: "scikit-learn", minimumVersion: null },
    { name: "openpyxl", displayName: "openpyxl", minimumVersion: null },
    { name: "pyyaml", displayName: "PyYAML", minimumVersion: null },
    { name: "pillow", displayName: "Pillow", minimumVersion: null },
    { name: "requests", displayName: "Requests", minimumVersion: null },
    { name: "pypdf", displayName: "pypdf", minimumVersion: null },
    { name: "tabulate", displayName: "tabulate", minimumVersion: null },
    { name: "jinja2", displayName: "Jinja2", minimumVersion: null },
    { name: "defusedxml", displayName: "defusedxml", minimumVersion: null },
  ],
};

export const PYTHON_LARGE_DATA_TOOLKIT: ComputeToolkitDescriptor = {
  toolkitId: ComputeToolkitId.make("python-large-data"),
  languageId: PYTHON_LANGUAGE_ID,
  displayName: "Multidimensional and large datasets",
  summary: "Labeled arrays, columnar data, chunked datasets, HDF5, NetCDF, and parallel workloads.",
  required: false,
  packageRequirements: [
    { name: "xarray", displayName: "xarray", minimumVersion: null },
    { name: "pyarrow", displayName: "PyArrow", minimumVersion: null },
    { name: "h5py", displayName: "h5py", minimumVersion: null },
    { name: "h5netcdf", displayName: "h5netcdf", minimumVersion: null },
    { name: "zarr", displayName: "Zarr", minimumVersion: null },
    { name: "dask", displayName: "Dask", minimumVersion: null },
    { name: "cftime", displayName: "cftime", minimumVersion: null },
  ],
};

export const PYTHON_IMAGE_ANALYSIS_TOOLKIT: ComputeToolkitDescriptor = {
  toolkitId: ComputeToolkitId.make("python-image-analysis"),
  languageId: PYTHON_LANGUAGE_ID,
  displayName: "Image analysis",
  summary: "Scientific image processing and common microscopy and TIFF workflows.",
  required: false,
  packageRequirements: [
    { name: "scikit-image", displayName: "scikit-image", minimumVersion: null },
    { name: "imageio", displayName: "imageio", minimumVersion: null },
    { name: "tifffile", displayName: "tifffile", minimumVersion: null },
    { name: "imagecodecs", displayName: "imagecodecs", minimumVersion: null },
  ],
};

export const PYTHON_BIOINFORMATICS_TOOLKIT: ComputeToolkitDescriptor = {
  toolkitId: ComputeToolkitId.make("python-bioinformatics"),
  languageId: PYTHON_LANGUAGE_ID,
  displayName: "Sequences and bioinformatics",
  summary: "Biological sequence formats, analysis, indexing, and remote database utilities.",
  required: false,
  packageRequirements: [
    { name: "biopython", displayName: "Biopython", minimumVersion: null },
    { name: "pyfaidx", displayName: "pyfaidx", minimumVersion: null },
  ],
};

export const PYTHON_TOOLKIT_CATALOG: ReadonlyArray<ComputeToolkitDescriptor> = [
  PYTHON_DATA_AND_FIGURES_TOOLKIT,
  PYTHON_LARGE_DATA_TOOLKIT,
  PYTHON_IMAGE_ANALYSIS_TOOLKIT,
  PYTHON_BIOINFORMATICS_TOOLKIT,
];

/** uv optional-dependency group for Toolkits that are not part of the base lock. */
export const PYTHON_TOOLKIT_EXTRAS: Readonly<Record<string, string | null>> = {
  [PYTHON_DATA_AND_FIGURES_TOOLKIT.toolkitId]: null,
  [PYTHON_LARGE_DATA_TOOLKIT.toolkitId]: "large-data",
  [PYTHON_IMAGE_ANALYSIS_TOOLKIT.toolkitId]: "image-analysis",
  [PYTHON_BIOINFORMATICS_TOOLKIT.toolkitId]: "bioinformatics",
};

/**
 * Assesses a Toolkit against the same exact runtime candidate compute verified.
 * It never combines bridge readiness from one Python with packages found in a
 * different environment.
 */
export function assessPythonToolkit(
  descriptor: ComputeToolkitDescriptor,
  verification: ComputeRuntimeVerification,
): ComputeToolkitAssessment {
  if (descriptor.languageId !== PYTHON_LANGUAGE_ID) {
    return {
      toolkitId: descriptor.toolkitId,
      runtime: verification.profile,
      readiness: "runtime-unavailable",
      missingRequirements: ["This Toolkit does not belong to Python."],
    };
  }

  if (verification.readiness !== "ready") {
    return {
      toolkitId: descriptor.toolkitId,
      runtime: verification.profile,
      readiness: "runtime-unavailable",
      missingRequirements:
        verification.missingRequirements.length > 0
          ? verification.missingRequirements
          : [verification.message ?? "This Python runtime is not usable."],
    };
  }

  const packages = new Map(verification.packages.map(({ name, version }) => [name, version]));
  const missingRequirements = descriptor.packageRequirements.flatMap((requirement) => {
    const installed = packages.get(requirement.name) ?? null;
    if (installed === null) return [requirement.displayName];
    if (
      requirement.minimumVersion !== null &&
      !meetsPythonMinimumVersion(installed, requirement.minimumVersion)
    ) {
      return [`${requirement.displayName} >= ${requirement.minimumVersion} (found ${installed})`];
    }
    return [];
  });

  return {
    toolkitId: descriptor.toolkitId,
    runtime: verification.profile,
    readiness: missingRequirements.length === 0 ? "ready" : "missing-requirement",
    missingRequirements,
  };
}

export function assessPythonToolkits(
  verification: ComputeRuntimeVerification,
): ReadonlyArray<ComputeToolkitAssessment> {
  return PYTHON_TOOLKIT_CATALOG.map((descriptor) => assessPythonToolkit(descriptor, verification));
}
