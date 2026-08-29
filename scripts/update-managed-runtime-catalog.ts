#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off -- CI release automation owns these explicit filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  qualificationMatrix,
  refreshManagedRuntimeCatalog,
  type ManagedRuntimeCatalogData,
} from "./lib/managed-runtime-catalog.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputPath = NodePath.resolve(
  argument("--input") ?? "apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json",
);
const outputPath = NodePath.resolve(argument("--output") ?? inputPath);
const current = JSON.parse(await NodeFSP.readFile(inputPath, "utf8")) as ManagedRuntimeCatalogData;
const result = await refreshManagedRuntimeCatalog(current, fetch, (message) => {
  process.stderr.write(`${message}\n`);
});
await NodeFSP.writeFile(outputPath, `${JSON.stringify(result.catalog, null, 2)}\n`, {
  mode: 0o600,
});

const matrix = qualificationMatrix(result.changedProviders);
const githubOutput = process.env.GITHUB_OUTPUT?.trim();
if (githubOutput) {
  await NodeFSP.appendFile(
    githubOutput,
    [
      `changed=${result.changedProviders.length > 0}`,
      `providers=${JSON.stringify(result.changedProviders)}`,
      `matrix=${JSON.stringify({ include: matrix })}`,
      "",
    ].join("\n"),
  );
}

process.stdout.write(
  result.changedProviders.length > 0
    ? `Qualified metadata discovered for: ${result.changedProviders.join(", ")}\n`
    : "Managed provider catalog is already current.\n",
);
