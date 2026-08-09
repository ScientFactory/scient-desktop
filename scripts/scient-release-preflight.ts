#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone Git release preflight runs before an Effect application runtime exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isExactScientReleaseVersion } from "@t3tools/shared/scientRelease";

interface Options {
  readonly version: string;
  readonly sourceSha: string;
  readonly releaseSha: string;
  readonly root: string;
  readonly allowNoteFree: boolean;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function requiredValue(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

function parseOptions(args: ReadonlyArray<string>): Options {
  return {
    version: requiredValue(args, "--version").replace(/^v/u, ""),
    sourceSha: requiredValue(args, "--source-sha").toLowerCase(),
    releaseSha: requiredValue(args, "--release-sha").toLowerCase(),
    root: NodePath.resolve(args.includes("--root") ? requiredValue(args, "--root") : process.cwd()),
    allowNoteFree: args.includes("--allow-note-free"),
  };
}

function git(root: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertExactSha(value: string, label: string): void {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be a full 40-character commit SHA.`);
}

async function verifyReleaseNote(options: Options): Promise<"catalog" | "explicit-note-free"> {
  const catalogPath = NodePath.join(options.root, "apps/web/src/scient/releaseNotes/catalog.ts");
  const modelPath = NodePath.join(options.root, "apps/web/src/scient/releaseNotes/model.ts");

  if (!NodeFS.existsSync(catalogPath) || !NodeFS.existsSync(modelPath)) {
    if (options.allowNoteFree) return "explicit-note-free";
    throw new Error(
      "The approved Scient release-note catalog is not present. Use --allow-note-free only for an explicit note-free release decision.",
    );
  }

  const [{ SCIENT_RELEASE_NOTES }, { validateScientReleaseNotesCatalog }] = await Promise.all([
    import(NodeURL.pathToFileURL(catalogPath).href),
    import(NodeURL.pathToFileURL(modelPath).href),
  ]);
  const catalog = SCIENT_RELEASE_NOTES as ReadonlyArray<{ readonly version: string }>;
  const issues = validateScientReleaseNotesCatalog(catalog) as ReadonlyArray<string>;
  return resolveReleaseNoteSource({
    catalog,
    issues,
    version: options.version,
    allowNoteFree: options.allowNoteFree,
  });
}

export function resolveReleaseNoteSource(input: {
  readonly catalog: ReadonlyArray<{ readonly version: string }>;
  readonly issues: ReadonlyArray<string>;
  readonly version: string;
  readonly allowNoteFree: boolean;
}): "catalog" | "explicit-note-free" {
  if (input.issues.length > 0) {
    throw new Error(`The Scient What's New catalog is invalid:\n- ${input.issues.join("\n- ")}`);
  }
  if (!input.catalog.some((entry) => entry.version === input.version)) {
    if (input.allowNoteFree) return "explicit-note-free";
    throw new Error(
      `No approved What's New entry exists for ${input.version}. Use --allow-note-free only after an explicit decision.`,
    );
  }
  return "catalog";
}

export async function runScientReleasePreflight(options: Options): Promise<void> {
  if (!isExactScientReleaseVersion(options.version) || options.version.includes("-")) {
    throw new Error(
      `Stable releases require an exact x.y.z version, received '${options.version}'.`,
    );
  }
  assertExactSha(options.sourceSha, "--source-sha");
  assertExactSha(options.releaseSha, "--release-sha");

  const sourceTree = git(options.root, ["rev-parse", `${options.sourceSha}^{tree}`]);
  const releaseTree = git(options.root, ["rev-parse", `${options.releaseSha}^{tree}`]);
  if (sourceTree !== releaseTree) {
    throw new Error(
      `release/stable tree ${releaseTree} does not match selected main tree ${sourceTree}.`,
    );
  }

  try {
    git(options.root, ["rev-parse", "--verify", `refs/tags/v${options.version}`]);
  } catch {
    // Expected for a new release.
    const noteSource = await verifyReleaseNote(options);
    process.stdout.write(
      `${JSON.stringify({
        version: options.version,
        tag: `v${options.version}`,
        sourceSha: options.sourceSha,
        sourceTree,
        releaseSha: options.releaseSha,
        releaseTree,
        noteSource,
      })}\n`,
    );
    return;
  }
  throw new Error(`Tag v${options.version} already exists.`);
}

const isMain = process.argv[1]
  ? NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  runScientReleasePreflight(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
