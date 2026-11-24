import type {
  ComputeOutput,
  ComputeRuntimeInspection,
  ComputeSessionRecord,
} from "@t3tools/contracts";

// Import names are not distribution names, and an unknown name is often the
// person's own module: PyPI may well have an unrelated package by that name.
// So the app offers to add only these reviewed packages; an agent, which can
// read the code, handles any other.
const PYTHON_IMPORT_DISTRIBUTIONS: ReadonlyMap<string, string> = new Map([
  ...[
    "numpy",
    "pandas",
    "scipy",
    "matplotlib",
    "nbformat",
    "plotly",
    "seaborn",
    "statsmodels",
    "sympy",
    "openpyxl",
    "requests",
    "pypdf",
    "tabulate",
    "jinja2",
    "defusedxml",
    "xarray",
    "pyarrow",
    "h5py",
    "h5netcdf",
    "zarr",
    "dask",
    "cftime",
    "imageio",
    "tifffile",
    "imagecodecs",
    "pyfaidx",
    "polars",
    "duckdb",
    "networkx",
    "numba",
    "numexpr",
    "joblib",
    "tqdm",
    "xlrd",
    "lxml",
    "altair",
    "bokeh",
    "plotnine",
    "patsy",
    "pingouin",
    "lifelines",
    "linearmodels",
    "arviz",
    "pymc",
    "emcee",
    "corner",
    "lmfit",
    "iminuit",
    "uncertainties",
    "pint",
    "mpmath",
    "cvxpy",
    "pulp",
    "optuna",
    "shap",
    "xgboost",
    "lightgbm",
    "catboost",
    "torch",
    "torchvision",
    "torchaudio",
    "tensorflow",
    "keras",
    "jax",
    "transformers",
    "datasets",
    "tokenizers",
    "nltk",
    "spacy",
    "gensim",
    "hdbscan",
    "astropy",
    "shapely",
    "geopandas",
    "pyproj",
    "rasterio",
    "netCDF4",
    "pydicom",
    "nibabel",
    "nilearn",
    "dipy",
    "mne",
    "neo",
    "quantities",
    "brian2",
    "pysam",
    "anndata",
    "scanpy",
    "mdtraj",
    "ase",
    "pymatgen",
    "rdkit",
    "igraph",
    "leidenalg",
    "librosa",
    "soundfile",
    "pyreadstat",
    "pyreadr",
    "sqlalchemy",
    "ipywidgets",
  ].map((name): [string, string] => [name, name]),
  ["sklearn", "scikit-learn"],
  ["skimage", "scikit-image"],
  ["skbio", "scikit-bio"],
  ["sksurv", "scikit-survival"],
  ["skopt", "scikit-optimize"],
  ["yaml", "pyyaml"],
  ["PIL", "pillow"],
  ["Bio", "biopython"],
  ["cv2", "opencv-python"],
  ["bs4", "beautifulsoup4"],
  ["dateutil", "python-dateutil"],
  ["docx", "python-docx"],
  ["pptx", "python-pptx"],
  ["fitz", "pymupdf"],
  ["pywt", "pywavelets"],
  ["umap", "umap-learn"],
  ["community", "python-louvain"],
  ["MDAnalysis", "mdanalysis"],
  ["SimpleITK", "simpleitk"],
  ["tables", "tables"],
]);

/** A conservative hint, not a diagnosis or proof that switching will fix a run. */
export function computeDependencyRecovery(input: {
  readonly diagnostic: Pick<
    Extract<ComputeOutput, { _tag: "diagnostic" }>["diagnostic"],
    "errorName" | "message"
  >;
  readonly session: Pick<ComputeSessionRecord, "languageId" | "runtime">;
  readonly inspection: ComputeRuntimeInspection | null;
}): {
  readonly moduleName: string;
  readonly distribution: string;
  readonly managedHasPackage: boolean;
} | null {
  if (input.session.languageId !== "python" || input.diagnostic.errorName !== "ModuleNotFoundError")
    return null;
  // Accept only the canonical whole top-level-module message. Missing
  // submodules, project imports and arbitrary custom exception prose do not
  // establish that a different scientific environment would help.
  const match = /^No module named '([A-Za-z_][A-Za-z_0-9]*)'$/.exec(input.diagnostic.message);
  const moduleName = match?.[1];
  if (moduleName === undefined || match?.[0] !== input.diagnostic.message) return null;
  const distribution = PYTHON_IMPORT_DISTRIBUTIONS.get(moduleName);
  if (distribution === undefined) return null;

  return {
    moduleName,
    distribution,
    managedHasPackage: managedDependencyRuntime({ ...input, moduleName }) !== null,
  };
}

/** A package-qualified alternative; selection still requires fresh verification. */
export function managedDependencyRuntime(input: {
  readonly moduleName: string;
  readonly session: Pick<ComputeSessionRecord, "languageId" | "runtime">;
  readonly inspection: ComputeRuntimeInspection | null;
}): NonNullable<ComputeSessionRecord["runtime"]> | null {
  const distribution = PYTHON_IMPORT_DISTRIBUTIONS.get(input.moduleName);
  if (input.session.languageId !== "python" || distribution === undefined) return null;
  const language = input.inspection?.languages.find(
    (entry) => entry.descriptor.languageId === "python",
  );
  const status = language?.managedRuntime;
  const catalogued = language?.toolkits.some((toolkit) =>
    toolkit.packageRequirements.some((requirement) => requirement.name === distribution),
  );
  if (
    !(
      input.session.runtime !== null &&
      input.session.runtime.source !== "managed" &&
      language !== undefined &&
      catalogued &&
      status?.installed &&
      status.operation === null &&
      !status.failure &&
      !status.failureMessage &&
      !status.toolkitChanges?.some((change) => change.state !== "failed")
    )
  )
    return null;
  return (
    language.runtimes.find(
      (candidate) =>
        candidate.profile.source === "managed" &&
        candidate.profile.executable !== input.session.runtime?.executable &&
        candidate.verification.profile.executable === candidate.profile.executable &&
        candidate.verification.readiness === "ready" &&
        candidate.verification.packages.some(
          (pkg) => pkg.name === distribution && Boolean(pkg.version),
        ),
    )?.profile ?? null
  );
}
