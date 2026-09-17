import type {
  ComputeOutput,
  ComputeRuntimeInspection,
  ComputeSessionRecord,
} from "@t3tools/contracts";

// Import names are not distribution names. This reviewed allowlist is only for
// contextual guidance, never an instruction to install an arbitrary error string.
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
  ].map((name): [string, string] => [name, name]),
  ["sklearn", "scikit-learn"],
  ["skimage", "scikit-image"],
  ["yaml", "pyyaml"],
  ["PIL", "pillow"],
  ["Bio", "biopython"],
]);

/** A conservative hint, not a diagnosis or proof that switching will fix a run. */
export function computeDependencyRecovery(input: {
  readonly diagnostic: Pick<
    Extract<ComputeOutput, { _tag: "diagnostic" }>["diagnostic"],
    "errorName" | "message"
  >;
  readonly session: Pick<ComputeSessionRecord, "languageId" | "runtime">;
  readonly inspection: ComputeRuntimeInspection | null;
}): { readonly moduleName: string; readonly managedHasPackage: boolean } | null {
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

  const language = input.inspection?.languages.find(
    (entry) => entry.descriptor.languageId === "python",
  );
  const status = language?.managedRuntime;
  const catalogued = language?.toolkits.some((toolkit) =>
    toolkit.packageRequirements.some((requirement) => requirement.name === distribution),
  );
  const managedHasPackage = Boolean(
    input.session.runtime !== null &&
    input.session.runtime.source !== "managed" &&
    language?.enabled &&
    catalogued &&
    status?.installed &&
    status.operation === null &&
    !status.failure &&
    !status.failureMessage &&
    !status.toolkitChanges?.some((change) => change.state !== "failed") &&
    language.runtimes.some(
      (candidate) =>
        candidate.profile.source === "managed" &&
        candidate.profile.executable !== input.session.runtime?.executable &&
        candidate.verification.profile.executable === candidate.profile.executable &&
        candidate.verification.readiness === "ready" &&
        candidate.verification.packages.some(
          (pkg) => pkg.name === distribution && Boolean(pkg.version),
        ),
    ),
  );
  return { moduleName, managedHasPackage };
}
