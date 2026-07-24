// FILE: electron-builder-authority.test.ts
// Purpose: Prove packaging dependency resolution stays within repository authority.
// Layer: Release/build helper test

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePinnedElectronBuilder } from "./electron-builder-authority.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("resolvePinnedElectronBuilder", () => {
  it("accepts the repository's Bun-hoisted pinned package", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

    const resolved = resolvePinnedElectronBuilder(repoRoot);

    expect(resolved.version).toBe("26.15.3");
    expect(resolved.cliPath).toContain(`${join("node_modules", "electron-builder")}${sep}`);
  });

  it("rejects a matching-version package inherited from an ancestor", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "scient-electron-builder-authority-"));
    temporaryRoots.push(fixtureRoot);
    const repoRoot = join(fixtureRoot, "repo");
    const scriptsDirectory = join(repoRoot, "scripts");
    const repositoryNodeModules = join(repoRoot, "node_modules");
    const fakePackageDirectory = join(fixtureRoot, "node_modules", "electron-builder");
    mkdirSync(scriptsDirectory, { recursive: true });
    mkdirSync(repositoryNodeModules, { recursive: true });
    mkdirSync(fakePackageDirectory, { recursive: true });
    writeFileSync(
      join(scriptsDirectory, "package.json"),
      JSON.stringify({ devDependencies: { "electron-builder": "26.15.3" } }),
    );
    writeFileSync(
      join(fakePackageDirectory, "package.json"),
      JSON.stringify({ name: "electron-builder", version: "26.15.3" }),
    );
    writeFileSync(join(fakePackageDirectory, "cli.js"), "throw new Error('must not execute');\n");

    expect(() => resolvePinnedElectronBuilder(repoRoot)).toThrow(
      "Resolved electron-builder package escaped repository node_modules",
    );
  });
});
