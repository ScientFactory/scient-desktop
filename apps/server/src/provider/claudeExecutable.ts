// FILE: claudeExecutable.ts
// Purpose: Resolves Claude launchers into paths the Claude Agent SDK can spawn directly.
// Layer: Provider utility.

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandPath,
  type WindowsSafeProcessInput,
} from "@synara/shared/windowsProcess";

const WINDOWS_LAUNCHER_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["@anthropic-ai", "claude-code", "cli.js"],
] as const;

type ResolveCommandPath = (command: string, input: WindowsSafeProcessInput) => string;

export interface ClaudeSdkExecutableResolutionInput extends WindowsSafeProcessInput {
  readonly isFile?: ((filePath: string) => boolean) | undefined;
  readonly resolveCommandPath?: ResolveCommandPath | undefined;
}

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * The Claude Agent SDK does not launch Windows npm shims through a shell.
 * Resolve a bare command against PATH/PATHEXT and follow known npm shims to
 * the package executable (or the older cli.js entry point) when possible.
 */
export function resolveClaudeSdkExecutablePath(
  binaryPath: string,
  input: ClaudeSdkExecutableResolutionInput = {},
): string {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return binaryPath;
  }

  const resolved = (input.resolveCommandPath ?? resolveWindowsCommandPath)(binaryPath, input);
  if (!WINDOWS_LAUNCHER_EXTENSIONS.has(Path.win32.extname(resolved).toLowerCase())) {
    return resolved;
  }

  const isFile = input.isFile ?? isExistingFile;
  const launcherDirectory = Path.win32.dirname(resolved);
  const packageRoots = [Path.win32.join(launcherDirectory, "node_modules")];
  if (Path.win32.basename(launcherDirectory).toLowerCase() === ".bin") {
    packageRoots.unshift(Path.win32.dirname(launcherDirectory));
  }
  for (const packageRoot of packageRoots) {
    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = Path.win32.join(packageRoot, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }

  return binaryPath;
}
