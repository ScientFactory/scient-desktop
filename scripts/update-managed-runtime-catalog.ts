#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off -- CI release automation owns these explicit filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isManagedRuntimeProvider,
  refreshManagedRuntimeCatalog,
  refreshManagedRuntimeProvider,
  validateManagedRuntimeCatalog,
} from "./lib/managed-runtime-catalog.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputPath = NodePath.resolve(
  argument("--input") ??
    "apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json",
);
const outputPath = NodePath.resolve(argument("--output") ?? inputPath);
const requestedProvider = argument("--provider");
if (requestedProvider !== undefined && !isManagedRuntimeProvider(requestedProvider)) {
  throw new Error(`Unsupported managed runtime provider '${requestedProvider}'.`);
}
const current = validateManagedRuntimeCatalog(
  JSON.parse(await NodeFSP.readFile(inputPath, "utf8")),
);
const report = (message: string) => {
  process.stderr.write(`${message}\n`);
};
const result = requestedProvider
  ? await refreshManagedRuntimeProvider(current, requestedProvider, fetch, report)
  : await refreshManagedRuntimeCatalog(current, fetch, report);
await NodeFSP.writeFile(outputPath, `${JSON.stringify(result.catalog, null, 2)}\n`, {
  mode: 0o600,
});

const githubOutput = process.env.GITHUB_OUTPUT?.trim();
if (githubOutput) {
  await NodeFSP.appendFile(
    githubOutput,
    [`changed=${result.changedProviders.length > 0}`, ""].join("\n"),
  );
}

process.stdout.write(
  result.changedProviders.length > 0
    ? `Candidate metadata discovered for: ${result.changedProviders.join(", ")}\n`
    : "Managed provider catalog is already current.\n",
);
