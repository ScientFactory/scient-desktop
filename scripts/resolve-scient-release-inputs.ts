#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release metadata is resolved before an application runtime exists.
import * as NodeFS from "node:fs";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  assertScientBetaTargetAheadOfStable,
  assertScientReleaseChannelVersion,
} from "@t3tools/shared/scientRelease";

export function resolveScientReleaseInputs(input: {
  readonly channel: string;
  readonly version: string;
  readonly sourceSha: string;
  readonly workflowSha: string;
  readonly publishRelease: boolean;
  readonly allowUnsignedWindows: boolean;
  readonly latestStableVersion: string;
  readonly betaTags: readonly string[];
  readonly date: string;
}) {
  if (input.channel !== "stable" && input.channel !== "beta") {
    throw new Error("Release channel must be stable or beta.");
  }
  const beta = input.channel === "beta";
  const sourceSha = input.sourceSha.trim().toLowerCase() || (beta ? input.workflowSha : "");
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("source_sha must be a full 40-character commit SHA.");
  }
  if (sourceSha !== input.workflowSha) {
    throw new Error("source_sha must equal the exact workflow commit.");
  }
  let version = input.version.trim().replace(/^v/u, "");
  const betaVersions = input.betaTags.map((tag) => tag.replace(/^v/u, ""));
  for (const candidate of betaVersions) assertScientReleaseChannelVersion(candidate, "beta");
  const latestBeta = betaVersions.toSorted(compareSemverVersions).at(-1);
  if (beta && !version) {
    const stable = input.latestStableVersion.replace(/^v/u, "");
    assertScientReleaseChannelVersion(stable, "stable");
    if (!/^\d{8}$/u.test(input.date)) throw new Error("Beta date must use YYYYMMDD.");
    const [major, minor, patch] = stable.split(".");
    const nextStable = `${major}.${minor}.${Number(patch) + 1}`;
    const betaCore = latestBeta?.split("-")[0];
    const core =
      betaCore && compareSemverVersions(betaCore, nextStable) > 0 ? betaCore : nextStable;
    const previous = latestBeta?.startsWith(`${core}-beta.`) ? latestBeta.split(".") : undefined;
    const previousDate = previous?.at(-2) ?? "";
    // Retain monotonic ordering even when an explicit candidate uses a future date.
    const date = previousDate > input.date ? previousDate : input.date;
    const sequence = previousDate === date ? BigInt(previous?.at(-1) ?? "0") + 1n : 1n;
    version = `${core}-beta.${date}.${sequence}`;
  }
  assertScientReleaseChannelVersion(version, input.channel);
  if (beta) {
    assertScientBetaTargetAheadOfStable(version, input.latestStableVersion.replace(/^v/u, ""));
    if (latestBeta && compareSemverVersions(version, latestBeta) <= 0) {
      throw new Error(`Beta ${version} must be newer than existing Beta ${latestBeta}.`);
    }
  }
  return {
    version,
    source_sha: sourceSha,
    publish_release: beta || input.publishRelease,
    allow_unsigned_windows: beta || input.allowUnsignedWindows,
    latest_beta_version: latestBeta ?? "",
  };
}

if (import.meta.main) {
  const betaTags: unknown = JSON.parse(
    process.env.BETA_TAGS_FILE ? NodeFS.readFileSync(process.env.BETA_TAGS_FILE, "utf8") : "[]",
  );
  if (!Array.isArray(betaTags) || !betaTags.every((tag) => typeof tag === "string")) {
    throw new Error("Beta release inventory must be an array of tag names.");
  }
  const result = resolveScientReleaseInputs({
    channel: process.env.RELEASE_CHANNEL ?? "stable",
    version: process.env.RELEASE_VERSION ?? "",
    sourceSha: process.env.SOURCE_SHA ?? "",
    workflowSha: process.env.GITHUB_SHA ?? "",
    publishRelease: process.env.PUBLISH_RELEASE === "true",
    allowUnsignedWindows: process.env.ALLOW_UNSIGNED_WINDOWS === "true",
    latestStableVersion: process.env.LATEST_STABLE_VERSION ?? "",
    betaTags,
    date: process.env.RELEASE_DATE ?? "",
  });
  const output = Object.entries(result)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
