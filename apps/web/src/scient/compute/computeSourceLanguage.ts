import { ComputeLanguageId } from "@t3tools/contracts";

export interface ComputeSourceLanguage {
  readonly languageId: ComputeLanguageId;
  readonly displayName: string;
  readonly extensions: ReadonlyArray<`.${string}`>;
  readonly cellMarker: RegExp;
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

export function computeSourceLanguageForPath(path: string): ComputeSourceLanguage | null {
  const normalized = path.toLowerCase();
  return (
    COMPUTE_SOURCES.find((source) =>
      source.extensions.some((extension) => normalized.endsWith(extension)),
    ) ?? null
  );
}
