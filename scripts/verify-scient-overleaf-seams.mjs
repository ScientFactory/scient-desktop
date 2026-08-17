#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST_PATH = "scient-overleaf-seams.json";
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
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const refExists = (ref) => runGit(["rev-parse", "--verify", "--quiet", ref]).ok;
const pathExistsAtRef = (ref, path) => runGit(["cat-file", "-e", `${ref}:${path}`]).ok;
const inside = (path, root) => path === root || path.startsWith(`${root}/`);
const normalized = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !NodePath.isAbsolute(path) &&
  NodePath.posix.normalize(path) === path &&
  !path.startsWith("../");
const supporting = (path) =>
  /(^|\/)(__tests__\/|[^/]+\.(test|spec)\.[cm]?[jt]sx?$)/u.test(path) ||
  path.endsWith(".md") ||
  path.endsWith("package.json") ||
  path.endsWith("pnpm-lock.yaml") ||
  path.startsWith(".github/") ||
  /^scient-[a-z0-9-]+-seams\.json$/u.test(path) ||
  /^scripts\/verify-scient-[a-z0-9-]+-seams\.mjs$/u.test(path);

export function verifyScientOverleafSeams(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
  const failures = [];
  if (manifest.schemaVersion !== 1) failures.push("unsupported seam manifest schemaVersion");
  if (manifest.owner !== "ScientFactory")
    failures.push("seam manifest owner must be ScientFactory");

  const ownedRoots = manifest.ownedRoots ?? [];
  const ownedFiles = manifest.ownedFiles ?? [];
  const mounts = manifest.upstreamMounts ?? [];
  const dependencies = manifest.upstreamDependencies ?? [];
  const crossMounts = manifest.crossScientMounts ?? [];
  const signals = (manifest.diffSignals ?? []).map((signal) => new RegExp(signal, "u"));
  if (mounts.length > (manifest.mountBudget ?? 0)) {
    failures.push(
      `upstream mount budget exceeded: ${String(mounts.length)} > ${String(manifest.mountBudget)}`,
    );
  }

  const declared = [
    ...ownedRoots,
    ...ownedFiles,
    ...mounts.map(({ path }) => path),
    ...dependencies.map(({ path }) => path),
    ...crossMounts.map(({ path }) => path),
  ];
  for (const path of declared)
    if (!normalized(path)) failures.push(`invalid repository path: ${String(path)}`);
  for (const path of [...ownedRoots, ...ownedFiles])
    if (!NodeFS.existsSync(path)) failures.push(`owned Overleaf path does not exist: ${path}`);

  const mountPaths = new Set();
  for (const entry of [...mounts, ...dependencies, ...crossMounts]) {
    if (mountPaths.has(entry.path))
      failures.push(`duplicate Overleaf seam declaration: ${entry.path}`);
    mountPaths.add(entry.path);
    if (!NodeFS.existsSync(entry.path)) {
      failures.push(`Overleaf seam path does not exist: ${entry.path}`);
    } else if (!NodeFS.readFileSync(entry.path, "utf8").includes(entry.anchor)) {
      failures.push(`Overleaf seam ${entry.path} is missing anchor ${entry.anchor}`);
    }
  }

  const requestedUpstreamRef = args.get("upstream-ref");
  const upstreamRef = requestedUpstreamRef ?? DEFAULT_UPSTREAM_REFS.find(refExists);
  if (requestedUpstreamRef && !refExists(requestedUpstreamRef)) {
    failures.push(`upstream ref does not exist: ${requestedUpstreamRef}`);
  } else if (!upstreamRef) {
    failures.push("no official T3 upstream ref is available for provenance verification");
  } else {
    for (const path of [...ownedRoots, ...ownedFiles]) {
      if (pathExistsAtRef(upstreamRef, path))
        failures.push(`fork-owned path already exists in ${upstreamRef}: ${path}`);
    }
    for (const entry of [...mounts, ...dependencies]) {
      if (!pathExistsAtRef(upstreamRef, entry.path))
        failures.push(`upstream seam is absent from ${upstreamRef}: ${entry.path}`);
    }
  }

  const base = args.get("base");
  const head = args.get("head");
  if ((base && !head) || (!base && head)) {
    failures.push("--base and --head must be provided together");
  } else if (base && head) {
    const changed = runGit(["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"]);
    if (!changed.ok)
      failures.push(`unable to inspect Overleaf seam diff: ${changed.stderr.trim()}`);
    else
      for (const path of changed.stdout.split("\n").filter(Boolean)) {
        const classified =
          ownedFiles.includes(path) ||
          mountPaths.has(path) ||
          ownedRoots.some((root) => inside(path, root));
        if (classified || supporting(path)) continue;
        const diff = runGit(["diff", "--unified=0", base, head, "--", path]);
        if (!diff.ok)
          failures.push(`unable to inspect changed path ${path}: ${diff.stderr.trim()}`);
        else if (signals.some((signal) => signal.test(diff.stdout)))
          failures.push(`Overleaf-related changed path is undeclared: ${path}`);
      }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Scient Overleaf seam check passed: ${String(ownedRoots.length)} owned roots, ${String(ownedFiles.length)} owned files, ${String(mounts.length)}/${String(manifest.mountBudget)} upstream mounts, ${String(crossMounts.length)} cross-Scient mounts.\n`,
  );
}

if (import.meta.main) verifyScientOverleafSeams();
