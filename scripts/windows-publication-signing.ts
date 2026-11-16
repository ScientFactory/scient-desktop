#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release gate reads build attestations and published handoffs before publication.

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/** What a release records about its Windows installer's Authenticode signature. */
export interface WindowsSigningRecord {
  readonly signed: boolean;
  /** The certificate CN the installed app pins in app-update.yml; null when unsigned. */
  readonly publisherName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    if (!isRecord(handoff) || handoff.windows === undefined) continue;
    const record = readWindowsSigningAttestation({
      platform: "win",
      arch: "x64",
      ...(handoff.windows as object),
    });
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
    if (!pinned.includes(candidate.publisherName!)) {
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

export function runWindowsPublicationGate(args: ReadonlyArray<string>): string | null {
  const [attestation] = values(args, "--attestation");
  if (!attestation) throw new Error("--attestation is required.");
  const allowUnsigned = values(args, "--allow-unsigned")[0] === "true";
  const { warning } = decideWindowsPublication({
    candidate: readWindowsSigningAttestation(readJson(attestation)),
    pinned: pinnedWindowsPublishers(values(args, "--published-handoff").map(readJson)),
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
