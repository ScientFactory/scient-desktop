#!/usr/bin/env node

export interface NextScientStableVersion {
  readonly currentVersion: string;
  readonly version: string;
  readonly tag: string;
}

const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function requiredValue(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

export function resolveNextScientStableVersion(latestTag: string): NextScientStableVersion {
  const match = STABLE_TAG_PATTERN.exec(latestTag.trim());
  if (!match) {
    throw new Error(
      `Latest published release '${latestTag}' is not an exact stable v<major>.<minor>.<patch> tag.`,
    );
  }

  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Could not parse latest published release '${latestTag}'.`);
  }

  const nextPatch = Number(patch) + 1;
  if (!Number.isSafeInteger(nextPatch)) {
    throw new Error(`Patch component in '${latestTag}' cannot be incremented safely.`);
  }

  const currentVersion = `${major}.${minor}.${patch}`;
  const version = `${major}.${minor}.${nextPatch}`;
  return { currentVersion, version, tag: `v${version}` };
}

function writeOutput(metadata: NextScientStableVersion): void {
  const entries = [
    ["current_version", metadata.currentVersion],
    ["version", metadata.version],
    ["tag", metadata.tag],
  ] as const;

  process.stdout.write(entries.map(([key, value]) => `${key}=${value}\n`).join(""));
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const latestTag = requiredValue(args, "--latest-tag");
    writeOutput(resolveNextScientStableVersion(latestTag));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
