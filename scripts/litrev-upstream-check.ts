#!/usr/bin/env bun
// FILE: litrev-upstream-check.ts
// Purpose: Verifies the owned Synara fork topology and optionally reruns the Gate 1.5 baseline.

import { execFileSync } from "node:child_process";

import {
  LITREV_APP_NAME,
  LITREV_DESKTOP_ORIGIN,
  LITREV_DESKTOP_UPDATES_ENABLED,
} from "@synara/shared/desktopIdentity";

const EXPECTED_ORIGIN = "git@github.com:yaacovcorcos/synara.git";
const EXPECTED_UPSTREAM = "https://github.com/Emanuele-web04/synara.git";
const UPSTREAM_BRANCH = "upstream/main";

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertEqual(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual || "(empty)"}`);
  }
}

const fetch = process.argv.includes("--fetch");
const checks = process.argv.includes("--checks");
const initialStatus = run("git", ["status", "--porcelain"]);
if (initialStatus) {
  throw new Error("Run the upstream check from a clean Synara worktree.");
}

assertEqual("origin fetch URL", run("git", ["remote", "get-url", "origin"]), EXPECTED_ORIGIN);
assertEqual("upstream fetch URL", run("git", ["remote", "get-url", "upstream"]), EXPECTED_UPSTREAM);
assertEqual(
  "upstream push URL",
  run("git", ["remote", "get-url", "--push", "upstream"]),
  "DISABLED",
);

if (fetch) {
  execFileSync("git", ["fetch", "--prune", "upstream"], { stdio: "inherit" });
}

if (LITREV_APP_NAME !== "LitRev" || LITREV_DESKTOP_ORIGIN !== "litrev://app") {
  throw new Error("LitRev desktop identity invariant failed.");
}
if (LITREV_DESKTOP_UPDATES_ENABLED) {
  throw new Error("Automatic updates must remain disabled until a LitRev-owned feed is approved.");
}

if (checks) {
  for (const args of [
    ["run", "fmt:check"],
    ["run", "lint"],
    ["run", "typecheck"],
    ["run", "build:desktop"],
  ] as const) {
    execFileSync("bun", args, { stdio: "inherit" });
  }
}

const finalStatus = run("git", ["status", "--porcelain"]);
if (finalStatus !== initialStatus) {
  throw new Error("Verification changed tracked or untracked source files.");
}

const [ahead = "unknown", behind = "unknown"] = run("git", [
  "rev-list",
  "--left-right",
  "--count",
  `HEAD...${UPSTREAM_BRANCH}`,
]).split(/\s+/);

console.log(
  JSON.stringify(
    {
      repository: "yaacovcorcos/synara",
      head: run("git", ["rev-parse", "HEAD"]),
      upstream: run("git", ["rev-parse", UPSTREAM_BRANCH]),
      ahead,
      behind,
      identity: LITREV_APP_NAME,
      origin: LITREV_DESKTOP_ORIGIN,
      automaticUpdatesEnabled: LITREV_DESKTOP_UPDATES_ENABLED,
      checksRun: checks,
    },
    null,
    2,
  ),
);
