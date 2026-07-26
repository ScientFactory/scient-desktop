#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTCOME_FILE = "packaged-native-child-outcome.json";
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

const [command, cwd, serializedArgs] = process.argv.slice(2);
if (!command || !cwd || serializedArgs === undefined) {
  throw new Error("POSIX packaged startup sentinel requires command, cwd, and serialized args.");
}
const parsedArgs = JSON.parse(serializedArgs);
if (!Array.isArray(parsedArgs) || !parsedArgs.every((value) => typeof value === "string")) {
  throw new Error("POSIX packaged startup sentinel received invalid launch arguments.");
}

// The verifier makes this sentinel the process-group leader. Ignoring TERM
// keeps the original PGID occupied until the verifier observes the native
// payload outcome and atomically finishes the whole group with SIGKILL.
process.on("SIGTERM", () => undefined);

const child = spawn(command, parsedArgs, {
  cwd,
  env: process.env,
  detached: false,
  stdio: ["ignore", "inherit", "inherit"],
});

child.once("error", (error) => {
  writeOutcome({ exited: null, launchError: { message: error.message } });
});
child.once("exit", (code, signal) => {
  writeOutcome({ exited: { code, signal }, launchError: null });
});

// Stay alive even after an early native-payload exit. This retained sentinel
// is the OS-owned identity that makes a later group signal reuse-safe.
setInterval(() => undefined, 60_000);
await new Promise(() => undefined);
