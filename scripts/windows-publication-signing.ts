#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release gate reads build attestations and published handoffs before publication.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/** What a release records about its Windows installer's Authenticode signature. */
export interface WindowsSigningRecord {
  readonly signed: boolean;
  /** The certificate CN the installed app pins in app-update.yml; null when unsigned. */
  readonly publisherName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Windows build's signing attestation, as the release workflow writes it. */
export function readWindowsSigningAttestation(value: unknown): WindowsSigningRecord {
  if (
    !isRecord(value) ||
    value.platform !== "win" ||
    value.arch !== "x64" ||
    typeof value.signed !== "boolean"
  ) {
    throw new Error("Invalid Windows signing attestation.");
  }
  const publisherName = value.publisherName;
  if (value.signed) {
    if (typeof publisherName !== "string" || publisherName.trim() === "") {
      throw new Error("A signed Windows attestation must name its publisher.");
    }
    return { signed: true, publisherName };
  }
  if (publisherName !== undefined) {
    throw new Error("An unsigned Windows attestation cannot name a publisher.");
  }
  return { signed: false, publisherName: null };
}

/**
 * Publishers that installed Windows clients already pin, from each channel's newest published
 * handoff. Once a signed build ships, every later build is signed by the same publisher, so the
 * newest release of each channel carries the pin. Handoffs older than this record name none.
 */
export function pinnedWindowsPublishers(handoffs: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const pinned = new Set<string>();
  for (const handoff of handoffs) {
    const record = readHandoffWindowsSigning(handoff);
    if (record === null) continue;
    if (record.publisherName !== null) pinned.add(record.publisherName);
  }
  return [...pinned];
}

/**
 * Clients switch between Stable and Beta, so a pin on either binds both, and electron-updater
 * rejects an installer whose signer misses the pin: no exception may override it. Before any
 * pin, an unsigned build still needs the explicit unsigned-Windows exception.
 */
export function decideWindowsPublication(input: {
  readonly candidate: WindowsSigningRecord;
  readonly pinned: ReadonlyArray<string>;
  readonly allowUnsigned: boolean;
}): { readonly warning: string | null } {
  const { candidate, pinned, allowUnsigned } = input;
  if (pinned.length > 0) {
    const names = pinned.map((name) => `'${name}'`).join(", ");
    if (!candidate.signed) {
      throw new Error(
        `Installed Windows clients pin publisher ${names}; an unsigned installer would fail their update signature check on Stable and Beta. allow_unsigned_windows cannot override this.`,
      );
    }
    if (pinned.some((publisher) => publisher !== candidate.publisherName)) {
      throw new Error(
        `Installed Windows clients pin publisher ${names}; this installer is signed by '${candidate.publisherName}' and would fail their update signature check.`,
      );
    }
    return { warning: null };
  }
  if (candidate.signed) return { warning: null };
  if (!allowUnsigned) {
    throw new Error(
      "Windows publication is unsigned; rerun only with explicit allow_unsigned_windows=true.",
    );
  }
  return { warning: "Publishing an unsigned Windows installer by explicit release approval." };
}

function values(args: ReadonlyArray<string>, flag: string): ReadonlyArray<string> {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []));
}

function readJson(path: string): unknown {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;
}

function readHandoffWindowsSigning(handoff: unknown): WindowsSigningRecord | null {
  if (!isRecord(handoff)) throw new Error("Invalid release handoff.");
  if (handoff.windows === undefined) return null;
  if (!isRecord(handoff.windows)) throw new Error("Invalid Windows signing record in handoff.");
  return readWindowsSigningAttestation({ platform: "win", arch: "x64", ...handoff.windows });
}

function githubJson(args: ReadonlyArray<string>): unknown {
  return JSON.parse(
    NodeChildProcess.execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }),
  ) as unknown;
}

function newestPublishedHandoffs(stableRepository: string, betaRepository: string): unknown[] {
  const stable = githubJson(["api", `repos/${stableRepository}/releases/latest`]);
  if (!isRecord(stable) || typeof stable.tag_name !== "string" || !stable.tag_name) {
    throw new Error("Cannot identify the newest published Stable release.");
  }
  const pages = githubJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${betaRepository}/releases?per_page=100`,
  ]);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("Cannot read published Beta releases.");
  }
  const releases: unknown[] = pages.flat();
  let betaTag: string | null = null;
  for (const release of releases) {
    if (
      !isRecord(release) ||
      typeof release.draft !== "boolean" ||
      typeof release.tag_name !== "string"
    ) {
      throw new Error("Invalid published Beta release record.");
    }
    if (!release.draft && release.tag_name.includes("-beta.")) {
      betaTag = release.tag_name;
      break;
    }
  }
  const download = (repository: string, tag: string) =>
    githubJson([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      "scient-release-handoff.json",
      "--output",
      "-",
    ]);
  return [
    download(stableRepository, stable.tag_name),
    ...(betaTag === null ? [] : [download(betaRepository, betaTag)]),
  ];
}

export function runWindowsPublicationGate(args: ReadonlyArray<string>): string | null {
  const [attestation] = values(args, "--attestation");
  const [candidateHandoff] = values(args, "--candidate-handoff");
  if (Boolean(attestation) === Boolean(candidateHandoff)) {
    throw new Error("Exactly one of --attestation or --candidate-handoff is required.");
  }
  const candidate = attestation
    ? readWindowsSigningAttestation(readJson(attestation))
    : readHandoffWindowsSigning(readJson(candidateHandoff!));
  if (candidate === null) throw new Error("The candidate handoff must record Windows signing.");
  const [stableRepository] = values(args, "--stable-repository");
  const [betaRepository] = values(args, "--beta-repository");
  if (!stableRepository || !betaRepository) {
    throw new Error("--stable-repository and --beta-repository are required.");
  }
  const allowUnsigned = values(args, "--allow-unsigned")[0] === "true";
  const { warning } = decideWindowsPublication({
    candidate,
    pinned: pinnedWindowsPublishers(newestPublishedHandoffs(stableRepository, betaRepository)),
    allowUnsigned,
  });
  return warning;
}

// Real paths, so an indirect invocation still runs the gate rather than silently passing it.
const isMain = process.argv[1]
  ? NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
  : false;
if (isMain) {
  try {
    const warning = runWindowsPublicationGate(process.argv.slice(2));
    if (warning !== null) process.stdout.write(`WARNING: ${warning}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
