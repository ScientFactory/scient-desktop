// FILE: electron-builder-authority.ts
// Purpose: Resolve the pinned packaging CLI without escaping repository dependency authority.
// Layer: Release/build helper

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface ResolvedElectronBuilder {
  readonly cliPath: string;
  readonly packageJsonPath: string;
  readonly version: string;
}

function isPathInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

export function resolvePinnedElectronBuilder(repoRoot: string): ResolvedElectronBuilder {
  const realRepoRoot = realpathSync(repoRoot);
  const repositoryNodeModules = realpathSync(join(realRepoRoot, "node_modules"));
  const scriptsPackageJsonPath = realpathSync(join(realRepoRoot, "scripts/package.json"));
  const scriptsPackageJson = JSON.parse(readFileSync(scriptsPackageJsonPath, "utf8")) as {
    devDependencies?: Record<string, unknown>;
  };
  const pinnedVersion = scriptsPackageJson.devDependencies?.["electron-builder"];
  if (typeof pinnedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(pinnedVersion)) {
    throw new Error("scripts/package.json must pin electron-builder to an exact version.");
  }

  const requireFromScriptsWorkspace = createRequire(scriptsPackageJsonPath);
  const packageJsonPath = realpathSync(
    requireFromScriptsWorkspace.resolve("electron-builder/package.json"),
  );
  const cliPath = realpathSync(requireFromScriptsWorkspace.resolve("electron-builder/cli.js"));
  const packageDirectory = dirname(packageJsonPath);

  if (!isPathInside(repositoryNodeModules, packageDirectory)) {
    throw new Error(
      `Resolved electron-builder package escaped repository node_modules: ${packageDirectory}`,
    );
  }
  if (!isPathInside(packageDirectory, cliPath)) {
    throw new Error(
      `Resolved electron-builder CLI does not belong to ${packageDirectory}: ${cliPath}`,
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (packageJson.version !== pinnedVersion) {
    throw new Error(
      `Resolved electron-builder ${String(packageJson.version)} does not match scripts/package.json pin ${pinnedVersion}.`,
    );
  }

  return { cliPath, packageJsonPath, version: pinnedVersion };
}
