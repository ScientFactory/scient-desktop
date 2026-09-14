export type MatlabSourceKind =
  | "script"
  | "function"
  | "class"
  | "package-member"
  | "class-member"
  | "private-member";

export interface MatlabSourceCapability {
  readonly kind: MatlabSourceKind;
  readonly runnableAsFile: boolean;
  readonly reason: string | null;
}

function pathSegments(path: string): ReadonlyArray<string> {
  return path.split(/[\\/]/u).filter(Boolean);
}

/**
 * Returns the first MATLAB statement that can determine whether a saved `.m`
 * file is a script or a definition. MATLAB block-comment delimiters are valid
 * only on otherwise-empty lines, which lets this remain deliberately small and
 * conservative without attempting to parse the language.
 */
function firstMatlabStatement(code: string): string | null {
  let inBlockComment = false;
  for (const rawLine of code.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line === "%}") inBlockComment = false;
      continue;
    }
    if (line === "%{") {
      inBlockComment = true;
      continue;
    }
    if (line === "" || line.startsWith("%")) continue;
    return line;
  }
  return null;
}

/**
 * MATLAB runs scripts as files. Function, class, package, class-folder, and
 * private definitions are dependencies that must be called by executable code;
 * sending their path to `run(...)` is both misleading and guaranteed to fail.
 */
export function classifyMatlabSource(input: {
  readonly path: string;
  readonly code: string;
}): MatlabSourceCapability {
  const directorySegments = pathSegments(input.path).slice(0, -1);
  if (directorySegments.some((segment) => segment.startsWith("+"))) {
    return {
      kind: "package-member",
      runnableAsFile: false,
      reason: "This package definition is called from a MATLAB script; it is not run as a file.",
    };
  }
  if (directorySegments.some((segment) => segment.startsWith("@"))) {
    return {
      kind: "class-member",
      runnableAsFile: false,
      reason: "This class method is called from MATLAB code; it is not run as a file.",
    };
  }
  if (directorySegments.some((segment) => segment.toLowerCase() === "private")) {
    return {
      kind: "private-member",
      runnableAsFile: false,
      reason: "This private function is called from MATLAB code; it is not run as a file.",
    };
  }

  const firstStatement = firstMatlabStatement(input.code);
  if (firstStatement !== null && /^classdef\b/iu.test(firstStatement)) {
    return {
      kind: "class",
      runnableAsFile: false,
      reason: "This class definition is used from MATLAB code; it is not run as a script.",
    };
  }
  if (firstStatement !== null && /^function\b/iu.test(firstStatement)) {
    return {
      kind: "function",
      runnableAsFile: false,
      reason: "This function is called from a MATLAB script; it is not run as a file.",
    };
  }
  return { kind: "script", runnableAsFile: true, reason: null };
}
