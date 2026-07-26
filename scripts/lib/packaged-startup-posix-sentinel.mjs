#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTCOME_FILE = "packaged-native-child-outcome.json";
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 12_000;
const VERIFIER_LIVENESS_POLL_MS = 250;
const SHUTDOWN_MESSAGE_TYPE = "scient-packaged-startup-shutdown";
let outcomeWritten = false;

function writeOutcome(value) {
  if (outcomeWritten) return;
  outcomeWritten = true;
  const scientHome = process.env.SCIENT_HOME?.trim();
  if (!scientHome) throw new Error("POSIX packaged startup sentinel requires SCIENT_HOME.");
  const path = join(scientHome, OUTCOME_FILE);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

const [serializedVerifierParentPid, command, cwd, serializedArgs] = process.argv.slice(2);
const verifierParentPid = Number(serializedVerifierParentPid);
if (
  !Number.isSafeInteger(verifierParentPid) ||
  verifierParentPid <= 0 ||
  process.ppid !== verifierParentPid
) {
  throw new Error("POSIX packaged startup sentinel requires its authenticated verifier parent.");
}
if (!command || !cwd || serializedArgs === undefined) {
  throw new Error(
    "POSIX packaged startup sentinel requires verifier, command, cwd, and serialized args.",
  );
}
const parsedArgs = JSON.parse(serializedArgs);
if (!Array.isArray(parsedArgs) || !parsedArgs.every((value) => typeof value === "string")) {
  throw new Error("POSIX packaged startup sentinel received invalid launch arguments.");
}

// The verifier makes this sentinel the process-group leader. Only this retained
// group member may signal the group: a verifier-side delayed numeric signal
// could otherwise target a recycled PID after the sentinel exits.
let shutdownStarted = false;
let childExited = false;

function killOwnedProcessGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function beginSentinelOwnedShutdown(immediate = false) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (immediate) {
    killOwnedProcessGroup();
    return;
  }
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const forceTimer = setTimeout(killOwnedProcessGroup, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();
  if (childExited) setImmediate(killOwnedProcessGroup);
}

process.on("SIGTERM", () => beginSentinelOwnedShutdown(false));
process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    message.type === SHUTDOWN_MESSAGE_TYPE &&
    Object.keys(message).length === 1
  ) {
    beginSentinelOwnedShutdown(false);
  }
});

const child = spawn(command, parsedArgs, {
  cwd,
  env: {
    ...process.env,
    // The desktop accepts smoke-only containment changes only from its direct
    // retained sentinel parent; an inherited public flag is not authority.
    SCIENT_PACKAGED_STARTUP_SENTINEL_PID: String(process.pid),
  },
  detached: false,
  stdio: ["ignore", "inherit", "inherit"],
});

child.once("error", (error) => {
  writeOutcome({ exited: null, launchError: { message: error.message } });
});
child.once("exit", (code, signal) => {
  childExited = true;
  writeOutcome({ exited: { code, signal }, launchError: null });
  // Preserve the durable child outcome before ending the retained group.
  if (shutdownStarted) setImmediate(killOwnedProcessGroup);
});

// Direct-parent identity is the liveness authority. Reparenting proves the
// verifier died without relying on a reusable numeric PID lookup.
const verifierLivenessTimer = setInterval(() => {
  if (process.ppid !== verifierParentPid) beginSentinelOwnedShutdown(true);
}, VERIFIER_LIVENESS_POLL_MS);
verifierLivenessTimer.unref();

// Stay alive even after an early native-payload exit. This retained sentinel is
// the sole group identity until requested cleanup or verifier death.
setInterval(() => undefined, 60_000);
await new Promise(() => undefined);
