// FILE: verify-mac-release-artifact.ts
// Purpose: Verifies freshly downloaded public macOS DMG and updater ZIP artifacts.
// Layer: Release verification helper

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { verifySingleMacDmgSignature } from "./lib/mac-artifact-signature.ts";
import { verifyMacUpdateZipArtifact } from "./lib/mac-update-zip-finalize.ts";

const artifactDirectory = process.argv[2];
if (!artifactDirectory) {
  throw new Error("Usage: bun scripts/verify-mac-release-artifact.ts <artifact-directory>");
}

const resolvedArtifactDirectory = resolve(artifactDirectory);
const verifiedDmg = verifySingleMacDmgSignature({
  stageDistDir: resolvedArtifactDirectory,
  requireDeveloperSignature: true,
  verbose: true,
});
console.log(`Verified published macOS artifact: ${verifiedDmg}`);

const zipNames = readdirSync(resolvedArtifactDirectory).filter((entry) => entry.endsWith(".zip"));
if (zipNames.length !== 1 || !zipNames[0]) {
  throw new Error(
    `Expected one macOS updater ZIP in ${resolvedArtifactDirectory}, found ${zipNames.length}.`,
  );
}
const verifiedAppName = verifyMacUpdateZipArtifact({
  signed: true,
  verbose: true,
  zipPath: resolve(resolvedArtifactDirectory, zipNames[0]),
});
console.log(`Verified published macOS updater artifact: ${zipNames[0]} (${verifiedAppName})`);
