#!/usr/bin/env bun
// FILE: litrev-upstream-check.ts
// Purpose: Verifies the owned Synara fork topology and current deterministic source baseline.
// Layer: Maintainer verification script

import { execFileSync } from "node:child_process";

import {
  LITREV_APP_NAME,
  LITREV_DESKTOP_ORIGIN,
  LITREV_DESKTOP_UPDATES_ENABLED,
} from "@synara/shared/desktopIdentity";

const EXPECTED_ORIGIN_REPOSITORY = "yaacovcorcos/papilab-desktop";
const EXPECTED_UPSTREAM_REPOSITORY = "emanuele-web04/synara";
const UPSTREAM_BRANCH = "upstream/main";

interface CommandFailure extends Error {
  readonly stderr?: string | Buffer;
  readonly stdout?: string | Buffer;
}

function commandFailureDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const failure = error as CommandFailure;
  const stderr = failure.stderr?.toString().trim();
  const stdout = failure.stdout?.toString().trim();
  return stderr || stdout || error.message;
}

function run(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${commandFailureDetails(error)}`,
      { cause: error },
    );
  }
}

function runVisible(command: string, args: readonly string[]): void {
  try {
    execFileSync(command, [...args], { stdio: "inherit" });
  } catch (error) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`, { cause: error });
  }
}

export function githubRepositoryFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\/+$/, "");
  const scpMatch = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmed);
  const urlMatch = /^(?:ssh:\/\/git@|https?:\/\/)github\.com\/([^/]+)\/(.+)$/i.exec(trimmed);
  const match = scpMatch ?? urlMatch;
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`.toLowerCase();
}

export function shouldFetchUpstream(args: readonly string[]): boolean {
  return !args.includes("--no-fetch");
}

export function assertCurrentUpstream(behind: string, args: readonly string[]): void {
  if (behind === "0" || args.includes("--allow-behind")) return;
  throw new Error(
    `Owned Synara is ${behind} commit(s) behind ${UPSTREAM_BRANCH}. Reconcile upstream before acceptance, or use --allow-behind only for diagnostics.`,
  );
}

function assertGitHubRemote(label: string, remote: string, expectedRepository: string): void {
  const actualRepository = githubRepositoryFromRemote(remote);
  if (actualRepository !== expectedRepository.toLowerCase()) {
    throw new Error(
      `${label} mismatch: expected GitHub repository ${expectedRepository}, received ${remote || "(empty)"}`,
    );
  }
}

function main(): void {
  const initialStatus = run("git", ["status", "--porcelain"]);
  if (initialStatus) {
    throw new Error("Run the Synara source check from a clean worktree.");
  }

  assertGitHubRemote(
    "origin fetch URL",
    run("git", ["remote", "get-url", "origin"]),
    EXPECTED_ORIGIN_REPOSITORY,
  );
  assertGitHubRemote(
    "origin push URL",
    run("git", ["remote", "get-url", "--push", "origin"]),
    EXPECTED_ORIGIN_REPOSITORY,
  );
  assertGitHubRemote(
    "upstream fetch URL",
    run("git", ["remote", "get-url", "upstream"]),
    EXPECTED_UPSTREAM_REPOSITORY,
  );
  const upstreamPushUrl = run("git", ["remote", "get-url", "--push", "upstream"]);
  if (upstreamPushUrl !== "DISABLED") {
    throw new Error(
      `upstream push URL mismatch: expected DISABLED, received ${upstreamPushUrl || "(empty)"}`,
    );
  }

  const args = process.argv.slice(2);
  const fetched = shouldFetchUpstream(args);
  if (fetched) {
    runVisible("git", ["fetch", "--prune", "upstream"]);
  }
  run("git", ["rev-parse", "--verify", UPSTREAM_BRANCH]);

  const [ahead = "unknown", behind = "unknown"] = run("git", [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${UPSTREAM_BRANCH}`,
  ]).split(/\s+/);
  assertCurrentUpstream(behind, args);

  if (LITREV_APP_NAME !== "LitRev" || LITREV_DESKTOP_ORIGIN !== "litrev://app") {
    throw new Error("LitRev desktop identity invariant failed.");
  }
  if (LITREV_DESKTOP_UPDATES_ENABLED) {
    throw new Error(
      "Automatic updates must remain disabled until client update support is explicitly enabled in a reviewed code change and a LitRev-owned feed is approved.",
    );
  }

  const sourceChecks = args.includes("--checks");
  if (sourceChecks) {
    for (const args of [
      ["run", "brand:check"],
      ["run", "fmt:check"],
      ["run", "lint"],
      ["run", "typecheck"],
      ["run", "test"],
      ["run", "build:desktop"],
      ["run", "release:smoke"],
    ] as const) {
      runVisible("bun", args);
    }
  }

  const finalStatus = run("git", ["status", "--porcelain"]);
  if (finalStatus !== initialStatus) {
    throw new Error("Verification changed tracked or untracked source files.");
  }

  console.log(
    JSON.stringify(
      {
        repository: EXPECTED_ORIGIN_REPOSITORY,
        head: run("git", ["rev-parse", "HEAD"]),
        upstream: run("git", ["rev-parse", UPSTREAM_BRANCH]),
        ahead,
        behind,
        upstreamFetched: fetched,
        identity: LITREV_APP_NAME,
        origin: LITREV_DESKTOP_ORIGIN,
        automaticUpdatesEnabled: LITREV_DESKTOP_UPDATES_ENABLED,
        deterministicSourceChecksRun: sourceChecks,
        crossRepositoryOpenCodeSmokeRun: false,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main();
}
