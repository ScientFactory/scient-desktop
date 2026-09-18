#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off -- CI publication owns these explicit filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isManagedRuntimeProvider,
  mergeQualifiedManagedRuntimeProvider,
  validateManagedRuntimeCatalog,
} from "./lib/managed-runtime-catalog.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const provider = argument("--provider");
if (!provider || !isManagedRuntimeProvider(provider)) {
  throw new Error("--provider must name a supported managed runtime provider.");
}

const currentPath = NodePath.resolve(
  argument("--current") ??
    "apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json",
);
const candidatePath = NodePath.resolve(argument("--candidate") ?? "");
const outputPath = NodePath.resolve(argument("--output") ?? currentPath);
if (!argument("--candidate")) throw new Error("--candidate is required.");

const [currentRaw, candidateRaw] = await Promise.all([
  NodeFSP.readFile(currentPath, "utf8"),
  NodeFSP.readFile(candidatePath, "utf8"),
]);
const current = validateManagedRuntimeCatalog(JSON.parse(currentRaw));
const candidate = validateManagedRuntimeCatalog(JSON.parse(candidateRaw));
const promoted = mergeQualifiedManagedRuntimeProvider({ current, candidate, provider });
await NodeFSP.writeFile(outputPath, `${JSON.stringify(promoted, null, 2)}\n`, { mode: 0o600 });

const previousRelease = current.providers[provider];
const promotedRelease = promoted.providers[provider];
const previousVersion = previousRelease?.version;
const promotedVersion = promotedRelease?.version;
const unchanged = JSON.stringify(previousRelease) === JSON.stringify(promotedRelease);
process.stdout.write(
  unchanged
    ? `${provider} ${promotedVersion ?? "unknown"} is already published.\n`
    : previousVersion === promotedVersion
      ? `Published additional qualified targets for ${provider} ${promotedVersion ?? "unknown"}.\n`
      : `Published ${provider} ${promotedVersion ?? "unknown"} over ${previousVersion ?? "unknown"}.\n`,
);
