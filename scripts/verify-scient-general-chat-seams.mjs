#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST_PATH = "scient-general-chat-seams.json";
const SOURCE_ROOTS = [
  "apps/mobile/src",
  "apps/server/src",
  "apps/web/src",
  "packages/client-runtime/src",
];
const PROJECTLESS_DECISION = /projectId\s*[!=]==?\s*null|null\s*[!=]==?\s*[^\n]*projectId/;
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;

function walk(root) {
  if (!NodeFS.existsSync(root)) return [];
  const files = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    const path = NodePath.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (SOURCE_EXTENSION.test(entry.name) && !entry.name.includes(".test.")) files.push(path);
  }
  return files;
}

export function findProjectlessDecisionPaths() {
  return SOURCE_ROOTS.flatMap(walk)
    .filter((path) => PROJECTLESS_DECISION.test(NodeFS.readFileSync(path, "utf8")))
    .sort();
}

export function verifyScientGeneralChatSeams() {
  const manifest = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
  const failures = [];
  if (manifest.schemaVersion !== 1) failures.push("unsupported seam manifest schemaVersion");
  if (manifest.owner !== "ScientFactory")
    failures.push("seam manifest owner must be ScientFactory");

  for (const root of manifest.ownedRoots ?? []) {
    if (!NodeFS.existsSync(root)) failures.push(`owned root does not exist: ${root}`);
  }
  const mountPaths = new Set();
  for (const mount of manifest.upstreamMounts ?? []) {
    if (mountPaths.has(mount.path)) failures.push(`duplicate upstream mount: ${mount.path}`);
    mountPaths.add(mount.path);
    if (!NodeFS.existsSync(mount.path)) {
      failures.push(`upstream mount does not exist: ${mount.path}`);
      continue;
    }
    if (!NodeFS.readFileSync(mount.path, "utf8").includes(mount.anchor)) {
      failures.push(`upstream mount ${mount.path} is missing anchor ${mount.anchor}`);
    }
  }

  const observed = findProjectlessDecisionPaths();
  const allowed = [...(manifest.projectlessDecisionAllowlist ?? [])].sort();
  for (const path of observed) {
    if (!allowed.includes(path)) failures.push(`unreviewed projectless decision: ${path}`);
  }
  for (const path of allowed) {
    if (!observed.includes(path))
      failures.push(`stale projectless-decision allowlist entry: ${path}`);
  }

  const mobileSources = walk("apps/mobile/src");
  for (const path of mobileSources) {
    const contents = NodeFS.readFileSync(path, "utf8");
    if (/projectless-\$\{|ProjectId\.make\(["'`]projectless-/.test(contents)) {
      failures.push(`mobile fake-project identity is forbidden: ${path}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Scient General Chat seam check passed: ${String(mountPaths.size)} mounts, ${String(observed.length)} reviewed projectless decision paths.\n`,
  );
}

if (import.meta.main) verifyScientGeneralChatSeams();
