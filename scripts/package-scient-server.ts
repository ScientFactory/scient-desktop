#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release packaging tool invokes npm and stages immutable artifacts.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parse as parseYaml } from "yaml";

import {
  SCIENT_SERVER_ALLOWED_INSTALL_SCRIPTS,
  SCIENT_SERVER_PACKAGE_NAME,
  scientServerAssetName,
} from "@t3tools/shared/scientRelease";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

interface WorkspaceConfig {
  readonly catalog?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}

interface PnpmListProject {
  readonly dependencies?: Record<string, { readonly version?: string }>;
}

export function resolveNpmCompatibleOverrides(
  overrides: Record<string, string>,
  catalog: Record<string, string>,
  directDependencies: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const npmCompatible = Object.fromEntries(
    Object.entries(overrides).filter(
      ([selector, spec]) =>
        !selector.includes(">") && spec !== "-" && !directDependencies.has(selector),
    ),
  );
  return resolveCatalogDependencies(npmCompatible, catalog, "apps/server");
}

function readFlag(args: ReadonlyArray<string>, flag: string, fallback?: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : fallback;
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

export function createScientServerPackageJson(input: {
  readonly source: Record<string, unknown> & {
    readonly dependencies?: Record<string, string>;
  };
  readonly version: string;
  readonly catalog: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly installedVersions: Record<string, string>;
}): Record<string, unknown> {
  const dependencies = Object.fromEntries(
    Object.entries(input.source.dependencies ?? {}).flatMap(([name, spec]) => {
      if (spec.startsWith("workspace:")) return [];
      const installedVersion = input.installedVersions[name]?.trim();
      if (!installedVersion) {
        throw new Error(`Installed release dependency '${name}' could not be resolved.`);
      }
      return [[name, installedVersion]];
    }),
  );
  return {
    name: SCIENT_SERVER_PACKAGE_NAME,
    version: input.version,
    license: input.source.license,
    repository: {
      type: "git",
      url: "https://github.com/ScientFactory/scient-desktop-next.git",
      directory: "apps/server",
    },
    bin: input.source.bin,
    files: ["dist", "npm-shrinkwrap.json"],
    type: "module",
    engines: input.source.engines,
    dependencies: resolveCatalogDependencies(dependencies, input.catalog, "apps/server"),
    // npm rejects overrides that target an exact direct dependency. Those
    // dependencies are already pinned above, and the generated shrinkwrap
    // freezes the complete transitive tree.
    overrides: resolveNpmCompatibleOverrides(
      input.overrides,
      input.catalog,
      new Set(Object.keys(dependencies)),
    ),
    allowScripts: Object.fromEntries(
      SCIENT_SERVER_ALLOWED_INSTALL_SCRIPTS.map((dependency) => [dependency, true]),
    ),
  };
}

function resolveInstalledServerDependencyVersions(root: string): Record<string, string> {
  const listed = NodeChildProcess.execFileSync(
    "pnpm",
    ["--filter", "t3", "list", "--prod", "--depth", "0", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const [project] = JSON.parse(listed) as ReadonlyArray<PnpmListProject>;
  return Object.fromEntries(
    Object.entries(project?.dependencies ?? {}).flatMap(([name, dependency]) => {
      const version = dependency.version?.trim();
      return version && !version.startsWith("link:") ? [[name, version]] : [];
    }),
  );
}

export function packageScientServer(args: ReadonlyArray<string>): string {
  const root = NodePath.resolve(readFlag(args, "--root", process.cwd()));
  const version = readFlag(args, "--version").replace(/^v/u, "");
  const outputDir = NodePath.resolve(root, readFlag(args, "--output-dir", "release-server"));
  const serverDir = NodePath.join(root, "apps/server");
  const distDir = NodePath.join(serverDir, "dist");
  for (const relativePath of ["bin.mjs", "service-launcher.mjs", "client/index.html"]) {
    if (!NodeFS.existsSync(NodePath.join(distDir, relativePath))) {
      throw new Error(`Server release asset is missing apps/server/dist/${relativePath}.`);
    }
  }

  const source = JSON.parse(
    NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8"),
  ) as Record<string, unknown> & { readonly dependencies?: Record<string, string> };
  const workspace = parseYaml(
    NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8"),
  ) as WorkspaceConfig;
  const packageJson = createScientServerPackageJson({
    source,
    version,
    catalog: workspace.catalog ?? {},
    overrides: workspace.overrides ?? {},
    installedVersions: resolveInstalledServerDependencyVersions(root),
  });

  NodeFS.mkdirSync(outputDir, { recursive: true });
  const stagingDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-server-package-"));
  try {
    NodeFS.cpSync(distDir, NodePath.join(stagingDir, "dist"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stagingDir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    NodeChildProcess.execFileSync(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: stagingDir, stdio: "pipe" },
    );
    NodeFS.renameSync(
      NodePath.join(stagingDir, "package-lock.json"),
      NodePath.join(stagingDir, "npm-shrinkwrap.json"),
    );
    const packed = NodeChildProcess.execFileSync(
      "npm",
      ["pack", stagingDir, "--pack-destination", outputDir, "--json"],
      { cwd: root, encoding: "utf8" },
    );
    const [packResult] = JSON.parse(packed) as ReadonlyArray<{ readonly filename: string }>;
    if (!packResult?.filename) throw new Error("npm pack did not report an output filename.");
    const { filename } = packResult;
    const packedPath = NodePath.join(outputDir, filename);
    const assetPath = NodePath.join(outputDir, scientServerAssetName(version));
    NodeFS.renameSync(packedPath, assetPath);
    return assetPath;
  } finally {
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1]
  ? NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    process.stdout.write(`${packageScientServer(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
