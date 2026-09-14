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
  let blockDepth = 0;
  for (const rawLine of code.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "%{") {
      blockDepth++;
      continue;
    }
    if (blockDepth > 0) {
      if (line === "%}") blockDepth--;
      continue;
    }
    if (line === "" || line.startsWith("%")) continue;
    return line;
  }
  return null;
}

/**
 * Scient's Run file action supports scripts, not function-call configuration.
 * Definitions need an explicit call so required arguments and package/class
 * context are supplied by the caller rather than guessed by the file action.
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
