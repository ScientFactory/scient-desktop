// SCIENT-OWNED: how the macOS development app bundle is kept signed and stable.
//
// The dev app is a signed copy of Electron.app. Three rules keep it reliable:
// - Each bundle owns its build record, so building one bundle (for example a
//   production-mode smoke test in the same checkout) never invalidates another.
// - Nothing that varies between launches lives inside the signed bundle. The
//   bundle's start command only runs a script kept beside it, so a different
//   Node, pnpm or shell environment never forces a re-sign.
// - A rebuild is staged next to the bundle and swapped in only once it is
//   signed; a failed signature leaves the previous bundle untouched.
//
// Signing is done in the foreground (`pnpm dev:app`, or `pnpm dev:app:start`,
// which prepares the bundle before handing off). macOS can refuse to sign from
// the background service, so the service never signs: it stops with a message
// that status reports instead of retrying.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Set by the background service; signing is refused there. */
export const SCIENT_DEV_APP_BACKGROUND_SERVICE_ENV = "SCIENT_DEV_APP_BACKGROUND_SERVICE";
/** Where a launch failure is recorded for `pnpm dev:app:status`. */
export const SCIENT_DEV_APP_FAILURE_FILE_ENV = "SCIENT_DEV_APP_FAILURE_FILE";

export class DevelopmentAppBundleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DevelopmentAppBundleError";
  }
}

/** The build record for one bundle, beside it in the runtime directory. */
export function resolveBundleMetadataPath(runtimeDir, appBundleName) {
  return NodePath.join(runtimeDir, `${appBundleName}.metadata.json`);
}

/** The launch-dependent start script, beside the bundle rather than inside it. */
export function resolveBundleStartCommandPath(runtimeDir, appBundleName) {
  return NodePath.join(runtimeDir, `${appBundleName}.start.command`);
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The signed start command: fixed for a given bundle, whatever launched it. */
export function makeDevelopmentStartCommandStub(startCommandPath) {
  return [
    "#!/bin/sh",
    `if [ ! -f ${shellSingleQuote(startCommandPath)} ]; then`,
    `  echo ${shellSingleQuote(`Missing development start command: ${startCommandPath}. Run pnpm dev:app:start from its checkout.`)} >&2`,
    "  exit 78",
    "fi",
    `exec /bin/sh ${shellSingleQuote(startCommandPath)} "$@"`,
    "",
  ].join("\n");
}

function recordDevelopmentAppFailure(message, environment = process.env) {
  const failurePath = environment[SCIENT_DEV_APP_FAILURE_FILE_ENV]?.trim();
  if (!failurePath) return;
  try {
    NodeFS.mkdirSync(NodePath.dirname(failurePath), { recursive: true });
    NodeFS.writeFileSync(
      failurePath,
      `${JSON.stringify({ message, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // The thrown error still reaches the log; the status hint is best effort.
  }
}

export function readDevelopmentAppFailure(failurePath) {
  try {
    const failure = JSON.parse(NodeFS.readFileSync(failurePath, "utf8"));
    return typeof failure?.message === "string" && failure.message.length > 0
      ? failure.message
      : null;
  } catch {
    return null;
  }
}

function fail(message, environment, cause) {
  recordDevelopmentAppFailure(message, environment);
  return new DevelopmentAppBundleError(message, cause === undefined ? undefined : { cause });
}

/** Refuses to sign from the background service, with the command that fixes it. */
export function assertForegroundSigning(appBundlePath, environment = process.env) {
  if (environment[SCIENT_DEV_APP_BACKGROUND_SERVICE_ENV] !== "1") return;
  throw fail(
    `${NodePath.basename(appBundlePath)} needs to be rebuilt and signed, which the background service does not do. Run pnpm dev:app:start again (it signs the app first) or pnpm dev:app from a terminal.`,
    environment,
  );
}

/** Signs in the foreground; a refusal is recorded with the next step to take. */
export function signInForeground(appBundlePath, sign, environment = process.env) {
  assertForegroundSigning(appBundlePath, environment);
  try {
    sign();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = detail
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast((line) => line.length > 0);
    throw fail(
      `Signing ${NodePath.basename(appBundlePath)} failed${reason ? `: ${reason}` : "."} Run pnpm dev:app from a terminal to rebuild it.`,
      environment,
      error,
    );
  }
}

/** A staging directory this old belongs to an interrupted build, not a live one. */
const ABANDONED_STAGING_AGE_MS = 10 * 60 * 1000;

/**
 * Cleans up after a build that was killed mid-way (for example Ctrl-C while
 * signing): restores a bundle left mid-swap and removes abandoned copies.
 */
function recoverInterruptedBuilds(runtimeDir, bundleName, fs, now) {
  const targetAppBundlePath = NodePath.join(runtimeDir, bundleName);
  for (const entry of fs.readdirSync(runtimeDir)) {
    if (!entry.startsWith(".staging-")) continue;
    const stagingDir = NodePath.join(runtimeDir, entry);
    const previous = NodePath.join(stagingDir, `${bundleName}.previous`);
    if (!fs.existsSync(targetAppBundlePath) && fs.existsSync(previous)) {
      fs.renameSync(previous, targetAppBundlePath);
    }
    if (now - fs.statSync(stagingDir).mtimeMs > ABANDONED_STAGING_AGE_MS) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

/**
 * Builds a bundle in a staging directory and swaps it into place only after
 * `build` succeeds. The staged bundle keeps the final bundle's name, so any
 * path derived from that name matches after the swap.
 */
export function replaceAppBundleAtomically(
  targetAppBundlePath,
  build,
  { fs = NodeFS, now = Date.now() } = {},
) {
  const runtimeDir = NodePath.dirname(targetAppBundlePath);
  const bundleName = NodePath.basename(targetAppBundlePath);
  fs.mkdirSync(runtimeDir, { recursive: true });
  recoverInterruptedBuilds(runtimeDir, bundleName, fs, now);
  const stagingDir = fs.mkdtempSync(NodePath.join(runtimeDir, ".staging-"));
  const stagedAppBundlePath = NodePath.join(stagingDir, bundleName);
  const previousAppBundlePath = NodePath.join(stagingDir, `${bundleName}.previous`);
  try {
    build(stagedAppBundlePath);
    const hadPrevious = fs.existsSync(targetAppBundlePath);
    if (hadPrevious) fs.renameSync(targetAppBundlePath, previousAppBundlePath);
    try {
      fs.renameSync(stagedAppBundlePath, targetAppBundlePath);
    } catch (error) {
      if (hadPrevious) fs.renameSync(previousAppBundlePath, targetAppBundlePath);
      throw error;
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
