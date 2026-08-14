#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const MANIFEST_PATH = "scient-latex-seams.json";
const DEFAULT_UPSTREAM_REFS = [
  "refs/remotes/upstream-verification/main",
  "refs/remotes/upstream/main",
  "upstream/main",
];

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return values;
};

const runGit = (args) => {
  const result = NodeChildProcess.spawnSync("git", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const refExists = (ref) => runGit(["rev-parse", "--verify", "--quiet", ref]).ok;
const pathExistsAtRef = (ref, path) => runGit(["cat-file", "-e", `${ref}:${path}`]).ok;
const isPathInside = (path, root) => path === root || path.startsWith(`${root}/`);
// Every lane declares its own seams, so a sibling lane's manifest or verifier
// naming a LaTeX path is that lane's classification, not an unclassified change.
const isSeamDeclaration = (path) =>
  /^scient-[a-z0-9-]+-seams\.json$/u.test(path) ||
  /^scripts\/verify-scient-[a-z0-9-]+-seams\.mjs$/u.test(path);
const isSupportingPath = (path) =>
  /(^|\/)(__tests__\/|[^/]+\.(test|spec)\.[cm]?[jt]sx?$)/u.test(path) ||
  path.endsWith(".md") ||
  path.endsWith("package.json") ||
  path.endsWith("pnpm-lock.yaml") ||
  path.startsWith(".github/") ||
  path === MANIFEST_PATH ||
  isSeamDeclaration(path);

const isNormalizedRepositoryPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !NodePath.isAbsolute(path) &&
  NodePath.posix.normalize(path) === path &&
  !path.startsWith("../");

export function verifyScientLatexSeams(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
  const failures = [];
  if (manifest.schemaVersion !== 2) failures.push("unsupported seam manifest schemaVersion");
  if (manifest.owner !== "ScientFactory")
    failures.push("seam manifest owner must be ScientFactory");

  const ownedRoots = manifest.ownedRoots ?? [];
  const ownedFiles = manifest.ownedFiles ?? [];
  const upstreamMounts = manifest.upstreamMounts ?? [];
  const diffSignals = (manifest.latexDiffSignals ?? []).map((signal) => new RegExp(signal, "u"));
  const allPaths = [...ownedRoots, ...ownedFiles, ...upstreamMounts.map((mount) => mount.path)];
  for (const path of allPaths) {
    if (!isNormalizedRepositoryPath(path))
      failures.push(`invalid repository path: ${String(path)}`);
  }

  const duplicatePaths = allPaths.filter((path, index) => allPaths.indexOf(path) !== index);
  for (const path of new Set(duplicatePaths))
    failures.push(`duplicate seam classification: ${path}`);

  for (const path of [...ownedRoots, ...ownedFiles]) {
    if (!NodeFS.existsSync(path)) failures.push(`owned LaTeX path does not exist: ${path}`);
  }

  const mountPaths = new Set();
  for (const mount of upstreamMounts) {
    if (mountPaths.has(mount.path)) failures.push(`duplicate LaTeX mount: ${mount.path}`);
    mountPaths.add(mount.path);
    if (!NodeFS.existsSync(mount.path)) {
      failures.push(`LaTeX mount does not exist: ${mount.path}`);
      continue;
    }
    if (!NodeFS.readFileSync(mount.path, "utf8").includes(mount.anchor)) {
      failures.push(`LaTeX mount ${mount.path} is missing anchor ${mount.anchor}`);
    }
  }

  const requestedUpstreamRef = args.get("upstream-ref");
  const upstreamRef = requestedUpstreamRef ?? DEFAULT_UPSTREAM_REFS.find(refExists);
  if (requestedUpstreamRef && !refExists(requestedUpstreamRef)) {
    failures.push(`upstream ref does not exist: ${requestedUpstreamRef}`);
  } else if (upstreamRef) {
    for (const path of [...ownedRoots, ...ownedFiles]) {
      if (pathExistsAtRef(upstreamRef, path)) {
        failures.push(
          `fork-owned path already exists in ${upstreamRef}; classify or reconcile it: ${path}`,
        );
      }
    }
    for (const mount of upstreamMounts) {
      if (!pathExistsAtRef(upstreamRef, mount.path)) {
        failures.push(`upstream mount is absent from ${upstreamRef}: ${mount.path}`);
      }
    }
  } else {
    failures.push("no official T3 upstream ref is available for provenance verification");
  }

  const base = args.get("base");
  const head = args.get("head");
  if ((base && !head) || (!base && head)) {
    failures.push("--base and --head must be provided together");
  } else if (base && head) {
    const changed = runGit(["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"]);
    if (!changed.ok) {
      failures.push(`unable to inspect seam diff ${base}..${head}: ${changed.stderr.trim()}`);
    } else {
      for (const path of changed.stdout.split("\n").filter(Boolean)) {
        const classified =
          ownedFiles.includes(path) ||
          mountPaths.has(path) ||
          ownedRoots.some((root) => isPathInside(path, root));
        if (classified || isSupportingPath(path)) continue;
        const diff = runGit(["diff", "--unified=0", base, head, "--", path]);
        if (!diff.ok) {
          failures.push(`unable to inspect changed path ${path}: ${diff.stderr.trim()}`);
          continue;
        }
        if (diffSignals.some((signal) => signal.test(diff.stdout))) {
          failures.push(
            `LaTeX-related changed path is not classified in ${MANIFEST_PATH}: ${path}`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Scient LaTeX seam check passed: ${String(ownedRoots.length)} owned roots, ${String(ownedFiles.length)} owned files, ${String(mountPaths.size)} upstream mounts${base && head ? ", current diff audited" : ""}.\n`,
  );
}

if (import.meta.main) verifyScientLatexSeams();
