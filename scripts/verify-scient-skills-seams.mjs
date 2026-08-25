#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST_PATH = "scient-skills-seams.json";
const DEFAULT_UPSTREAM_REFS = [
  "refs/remotes/upstream-verification/main",
  "refs/remotes/upstream/main",
  "upstream/main",
];

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
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
const isSupportingPath = (path) =>
  /(^|\/)(__tests__\/|[^/]+\.(test|spec)\.[cm]?[jt]sx?$)/u.test(path) ||
  path.endsWith(".md") ||
  path.endsWith("package.json") ||
  path.endsWith("pnpm-lock.yaml") ||
  path === MANIFEST_PATH ||
  path === "scripts/verify-scient-skills-seams.mjs";
const isNormalizedRepositoryPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !NodePath.isAbsolute(path) &&
  NodePath.posix.normalize(path) === path &&
  !path.startsWith("../");

const inspectChangedPaths = ({ base, head }) => {
  if (!base) return { ok: true, paths: [], untrackedPaths: new Set(), rangeLabel: null };
  const diff = runGit(
    head
      ? ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"]
      : ["diff", "--name-only", "--diff-filter=ACMR", base, "--"],
  );
  const untracked = head
    ? { ok: true, stdout: "", stderr: "" }
    : runGit(["ls-files", "--others", "--exclude-standard"]);
  const untrackedPaths = new Set(untracked.stdout.split("\n").filter(Boolean));
  return {
    ok: diff.ok && untracked.ok,
    paths: [...new Set([...diff.stdout.split("\n").filter(Boolean), ...untrackedPaths])],
    untrackedPaths,
    rangeLabel: head ? `${base}..${head}` : `${base}..working-tree`,
    error: [diff.stderr.trim(), untracked.stderr.trim()].filter(Boolean).join("; "),
  };
};

export function verifyScientSkillsSeams(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
  const failures = [];
  for (const name of args.keys()) {
    if (!new Set(["base", "head", "upstream-ref"]).has(name)) {
      failures.push(`unsupported argument: --${name}`);
    }
  }
  if (args.has("head") && !args.has("base")) failures.push("--head requires --base");
  if (manifest.schemaVersion !== 1) failures.push("unsupported seam manifest schemaVersion");
  if (manifest.owner !== "ScientFactory") failures.push("seam owner must be ScientFactory");

  const ownedRoots = manifest.ownedRoots ?? [];
  const ownedFiles = manifest.ownedFiles ?? [];
  const upstreamMounts = manifest.upstreamMounts ?? [];
  const signals = (manifest.skillDiffSignals ?? []).map((signal) => new RegExp(signal, "u"));
  const allPaths = [...ownedRoots, ...ownedFiles, ...upstreamMounts.map((mount) => mount.path)];
  for (const path of allPaths) {
    if (!isNormalizedRepositoryPath(path)) failures.push(`invalid repository path: ${path}`);
  }
  for (const path of new Set(allPaths.filter((item, index) => allPaths.indexOf(item) !== index))) {
    failures.push(`duplicate seam classification: ${path}`);
  }
  for (const path of [...ownedRoots, ...ownedFiles]) {
    if (!NodeFS.existsSync(path)) failures.push(`owned skill path does not exist: ${path}`);
  }

  const mountPaths = new Set();
  for (const mount of upstreamMounts) {
    mountPaths.add(mount.path);
    if (!NodeFS.existsSync(mount.path)) {
      failures.push(`skill mount does not exist: ${mount.path}`);
    } else if (!NodeFS.readFileSync(mount.path, "utf8").includes(mount.anchor)) {
      failures.push(`skill mount ${mount.path} is missing anchor ${mount.anchor}`);
    }
  }

  const requestedUpstreamRef = args.get("upstream-ref");
  const upstreamRef = requestedUpstreamRef ?? DEFAULT_UPSTREAM_REFS.find(refExists);
  if (requestedUpstreamRef && !refExists(requestedUpstreamRef)) {
    failures.push(`upstream ref does not exist: ${requestedUpstreamRef}`);
  } else if (upstreamRef) {
    for (const path of [...ownedRoots, ...ownedFiles]) {
      if (pathExistsAtRef(upstreamRef, path)) {
        failures.push(`fork-owned path already exists in ${upstreamRef}: ${path}`);
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

  const changed = inspectChangedPaths({ base: args.get("base"), head: args.get("head") });
  if (!changed.ok) {
    failures.push(`unable to inspect skill diff ${changed.rangeLabel}: ${changed.error}`);
  } else {
    for (const path of changed.paths) {
      const classified =
        ownedFiles.includes(path) ||
        mountPaths.has(path) ||
        ownedRoots.some((root) => isPathInside(path, root));
      if (classified || isSupportingPath(path)) continue;
      const diff = changed.untrackedPaths.has(path)
        ? { ok: true, stdout: NodeFS.readFileSync(path, "utf8"), stderr: "" }
        : runGit(
            (changed.rangeLabel?.endsWith("working-tree")
              ? ["diff", "--unified=0", args.get("base"), "--", path]
              : ["diff", "--unified=0", args.get("base"), args.get("head"), "--", path]
            ).filter(Boolean),
          );
      if (!diff.ok) {
        failures.push(`unable to inspect changed path ${path}: ${diff.stderr.trim()}`);
      } else if (signals.some((signal) => signal.test(diff.stdout))) {
        failures.push(`skill-related path is not classified in ${MANIFEST_PATH}: ${path}`);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Scient skills seam check passed: ${String(ownedRoots.length)} owned roots, ${String(ownedFiles.length)} owned files, ${String(mountPaths.size)} upstream mounts${changed.rangeLabel ? ", current diff audited" : ""}.\n`,
  );
}

if (import.meta.main) verifyScientSkillsSeams();
