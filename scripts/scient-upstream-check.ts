#!/usr/bin/env bun
// FILE: scient-upstream-check.ts
// Purpose: Verifies Scient desktop source ownership, upstream review state, and intake readiness.
// Layer: Maintainer verification script

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SCIENT_APP_NAME,
  SCIENT_DESKTOP_ORIGIN,
  SCIENT_DESKTOP_UPDATES_ENABLED,
} from "@synara/shared/desktopIdentity";

const EXPECTED_ORIGIN_REPOSITORY = "ScientFactory/scient-desktop";
const EXPECTED_ORIGIN_BRANCH = "main";
const EXPECTED_UPSTREAM_REPOSITORY = "Emanuele-web04/synara";
const EXPECTED_UPSTREAM_BRANCH = "main";
const UPSTREAM_BRANCH = `upstream/${EXPECTED_UPSTREAM_BRANCH}`;
const UPSTREAM_STATE_PATH = "upstream-state.json";

const UPDATE_MODES = new Set([
  "no-upstream",
  "version-bump",
  "adapter-maintained",
  "thin-fork-merge",
  "divergent-cherry-pick",
  "reference-only",
  "deferred",
]);

export interface UpstreamState {
  readonly schemaVersion: 1;
  readonly ownedRepository: string;
  readonly ownedDefaultBranch: string;
  readonly officialRepository: string;
  readonly officialDefaultBranch: string;
  readonly updateMode: string;
  readonly reviewedThrough: string;
  readonly reviewedAt: string;
  readonly integrationBase: string;
  readonly reviewRecord: string;
}

export type VerificationMode = "report" | "review" | "intake";

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

export function resolveVerificationMode(args: readonly string[]): VerificationMode {
  const review = args.includes("--review-check");
  const intake = args.includes("--intake") || args.includes("--checks");
  if (review && intake) {
    throw new Error("Choose either --review-check or --intake, not both.");
  }
  if (intake) return "intake";
  if (review) return "review";
  return "report";
}

export function parseUpstreamState(value: unknown): UpstreamState {
  if (!isRecord(value)) {
    throw new Error(`${UPSTREAM_STATE_PATH} must contain a JSON object.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${UPSTREAM_STATE_PATH} schemaVersion must be 1.`);
  }
  const state = {
    schemaVersion: 1 as const,
    ownedRepository: requireString(value, "ownedRepository"),
    ownedDefaultBranch: requireString(value, "ownedDefaultBranch"),
    officialRepository: requireString(value, "officialRepository"),
    officialDefaultBranch: requireString(value, "officialDefaultBranch"),
    updateMode: requireString(value, "updateMode"),
    reviewedThrough: requireString(value, "reviewedThrough"),
    reviewedAt: requireString(value, "reviewedAt"),
    integrationBase: requireString(value, "integrationBase"),
    reviewRecord: requireString(value, "reviewRecord"),
  };
  if (!UPDATE_MODES.has(state.updateMode)) {
    throw new Error(`${UPSTREAM_STATE_PATH} has unsupported updateMode ${state.updateMode}.`);
  }
  for (const [key, commit] of [
    ["reviewedThrough", state.reviewedThrough],
    ["integrationBase", state.integrationBase],
  ] as const) {
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`${UPSTREAM_STATE_PATH} field ${key} must be a full lowercase commit SHA.`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.reviewedAt)) {
    throw new Error(`${UPSTREAM_STATE_PATH} field reviewedAt must use YYYY-MM-DD.`);
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field === "string" && field) return field;
  throw new Error(`${UPSTREAM_STATE_PATH} field ${key} must be a non-empty string.`);
}

function assertGitHubRemote(label: string, remote: string, expectedRepository: string): void {
  const actualRepository = githubRepositoryFromRemote(remote);
  if (actualRepository !== expectedRepository.toLowerCase()) {
    throw new Error(
      `${label} mismatch: expected GitHub repository ${expectedRepository}, received ${remote || "(empty)"}`,
    );
  }
}

function assertStateIdentity(state: UpstreamState): void {
  if (state.ownedRepository !== EXPECTED_ORIGIN_REPOSITORY) {
    throw new Error(
      `${UPSTREAM_STATE_PATH} field ownedRepository must be ${EXPECTED_ORIGIN_REPOSITORY}.`,
    );
  }
  if (state.ownedDefaultBranch !== EXPECTED_ORIGIN_BRANCH) {
    throw new Error(
      `${UPSTREAM_STATE_PATH} field ownedDefaultBranch must be ${EXPECTED_ORIGIN_BRANCH}.`,
    );
  }
  if (state.officialRepository !== EXPECTED_UPSTREAM_REPOSITORY) {
    throw new Error(
      `${UPSTREAM_STATE_PATH} field officialRepository must be ${EXPECTED_UPSTREAM_REPOSITORY}.`,
    );
  }
  if (state.officialDefaultBranch !== EXPECTED_UPSTREAM_BRANCH) {
    throw new Error(
      `${UPSTREAM_STATE_PATH} field officialDefaultBranch must be ${EXPECTED_UPSTREAM_BRANCH}.`,
    );
  }
}

function assertAncestor(ancestor: string, descendant: string, label: string): void {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
  } catch (error) {
    throw new Error(`${label}: ${ancestor} is not an ancestor of ${descendant}.`, { cause: error });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const mode = resolveVerificationMode(args);
  const initialStatus = run("git", ["status", "--porcelain"]);
  if (mode === "intake" && initialStatus) {
    throw new Error("Run Scient desktop intake verification from a clean worktree.");
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

  const fetched = shouldFetchUpstream(args);
  if (fetched) {
    runVisible("git", ["fetch", "--prune", "upstream"]);
  }
  const upstreamTip = run("git", ["rev-parse", "--verify", UPSTREAM_BRANCH]);
  const state = parseUpstreamState(
    JSON.parse(readFileSync(path.join(process.cwd(), UPSTREAM_STATE_PATH), "utf8")),
  );
  assertStateIdentity(state);
  run("git", ["cat-file", "-e", `${state.reviewedThrough}^{commit}`]);
  run("git", ["cat-file", "-e", `${state.integrationBase}^{commit}`]);
  assertAncestor(state.reviewedThrough, upstreamTip, "Invalid upstream review checkpoint");
  assertAncestor(
    state.integrationBase,
    upstreamTip,
    "Integration base is not official upstream history",
  );
  assertAncestor(state.integrationBase, "HEAD", "Integration base is not present in owned history");

  const [ahead = "unknown", behind = "unknown"] = run("git", [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${UPSTREAM_BRANCH}`,
  ]).split(/\s+/);
  const unreviewedCommits = Number(
    run("git", ["rev-list", "--count", `${state.reviewedThrough}..${upstreamTip}`]),
  );

  if (SCIENT_APP_NAME !== "Scient" || SCIENT_DESKTOP_ORIGIN !== "scient://app") {
    throw new Error("Scient desktop identity invariant failed.");
  }
  if (SCIENT_DESKTOP_UPDATES_ENABLED) {
    throw new Error(
      "Automatic updates must remain disabled until client update support is explicitly enabled in a reviewed code change and a Scient-owned feed is approved.",
    );
  }

  if (mode === "intake") {
    for (const commandArgs of [
      ["run", "brand:check"],
      ["run", "fmt:check"],
      ["run", "lint"],
      ["run", "typecheck"],
      ["run", "test"],
      ["run", "build:desktop"],
      ["run", "release:smoke"],
    ] as const) {
      runVisible("bun", commandArgs);
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
        upstream: upstreamTip,
        ahead,
        behind,
        upstreamFetched: fetched,
        verificationMode: mode,
        worktreeClean: !initialStatus,
        review: {
          reviewedThrough: state.reviewedThrough,
          reviewedAt: state.reviewedAt,
          reviewRecord: state.reviewRecord,
          current: unreviewedCommits === 0,
          unreviewedCommits,
        },
        integrationBase: state.integrationBase,
        updateMode: state.updateMode,
        identity: SCIENT_APP_NAME,
        origin: SCIENT_DESKTOP_ORIGIN,
        automaticUpdatesEnabled: SCIENT_DESKTOP_UPDATES_ENABLED,
        deterministicSourceChecksRun: mode === "intake",
        crossRepositoryScientAgentSmokeRun: false,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main();
}
