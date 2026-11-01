import {
  COMPUTE_LANGUAGE_CATALOG,
  ComputeLanguageId,
  computeRunRouteForPath,
} from "@t3tools/contracts";

export interface ComputeSourceLanguage {
  readonly languageId: ComputeLanguageId;
  readonly displayName: string;
  readonly extensions: ReadonlyArray<`.${string}`>;
  readonly cellMarker: RegExp;
  /** Runs from its file with a record of each run, and has no session. */
  readonly runOnly?: true;
}

const HASH_CELL_MARKER = /^\s*#\s*%%(?:\s|$)/;

export const PYTHON_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("python"),
  displayName: "Python",
  extensions: [".py"],
  cellMarker: HASH_CELL_MARKER,
};

export const MATLAB_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("matlab"),
  displayName: "MATLAB",
  extensions: [".m"],
  cellMarker: /^\s*%%(?:\s|$)/,
};

const R_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("r"),
  displayName: "R",
  extensions: [".r"],
  cellMarker: HASH_CELL_MARKER,
};

const JULIA_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("julia"),
  displayName: "Julia",
  extensions: [".jl"],
  cellMarker: HASH_CELL_MARKER,
};

export const SQL_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("sql"),
  displayName: "SQL",
  extensions: [".sql"],
  cellMarker: /^\s*--\s*%%(?:\s|$)/,
};

const COMPUTE_SOURCES = [
  PYTHON_COMPUTE_SOURCE,
  MATLAB_COMPUTE_SOURCE,
  R_COMPUTE_SOURCE,
  JULIA_COMPUTE_SOURCE,
  SQL_COMPUTE_SOURCE,
] as const;

const NO_CELLS = /$^/;

export function computeSourceLanguageForPath(path: string): ComputeSourceLanguage | null {
  const normalized = path.toLowerCase();
  const session = COMPUTE_SOURCES.find((source) =>
    source.extensions.some((extension) => normalized.endsWith(extension)),
  );
  if (session !== undefined) return session;
  const route = computeRunRouteForPath(path);
  if (route === undefined) return null;
  const language = COMPUTE_LANGUAGE_CATALOG.flatMap((group) => group.languages).find(
    (candidate) => candidate.languageId === route.languageId,
  );
  return {
    languageId: ComputeLanguageId.make(route.languageId),
    displayName: language?.name ?? route.languageId,
    extensions: route.extensions.filter((extension) =>
      extension.startsWith("."),
    ) as ReadonlyArray<`.${string}`>,
    cellMarker: NO_CELLS,
    runOnly: true,
  };
}

/** A notebook runs in any language; one Scient has no source file type for is named from its id. */
export function computeSourceLanguageForId(languageId: string): ComputeSourceLanguage {
  return (
    COMPUTE_SOURCES.find((source) => source.languageId === languageId) ?? {
      languageId: ComputeLanguageId.make(languageId),
      displayName: languageId
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
      extensions: [],
      cellMarker: HASH_CELL_MARKER,
    }
  );
}
