// Never share/adopt T3 state. Migrate only proven Scient databases via SQLite backup; retain the
// old home. Copy userdata without live discovery/locks/logs. Keep worktrees/projects/scratch at
// recorded absolute paths, and rebuild tools/caches because relocating them can invalidate embedded
// paths.
import * as Effect from "effect/Effect";

import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";

import type * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";

const T3_REMOTE_HOME = "$HOME/.t3";
const REMOTE_SCIENT_HOME_MIGRATION_TIMEOUT_MS = 15 * 60_000;

/** The launch script's whole output when the copy must run before it. */
export const SCIENT_HOME_MIGRATION_REQUIRED = '{"scientHomeMigration":"required"}';

/**
 * Copies an earlier Scient SSH home out of `~/.t3` into an absent new home.
 * Usage: `node - <legacy home> <new home> <launch state key>`. Exits 0 once the
 * new home exists, copied or freshly created; exits 1 with a message, leaving
 * no new home, when a copy is owed but cannot happen safely.
 */
export const REMOTE_SCIENT_HOME_MIGRATION_SCRIPT = `const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");
const [legacyHome, home, stateKey] = process.argv.slice(2);
const legacyState = path.join(legacyHome, "userdata");
const legacyDb = path.join(legacyState, "statev2.sqlite");
const legacyRuntime = path.join(legacyState, "server-runtime.json");
const legacyLaunch = path.join(legacyHome, "ssh-launch", stateKey);
const SKIP_HINT = "To start fresh instead, create an empty " + home + " folder on this host and reconnect.";
// Ledger entries only Scient records (apps/server/src/persistence/Migrations.ts).
// Upstream never shipped these names, and both products refuse a database whose
// ledger names an id differently.
const SCIENT_ONLY_MIGRATIONS = [
  [41, "ProjectlessThreads"],
  [43, "RetireProjectlessThreads"],
  [58, "ProjectionThreadSections"],
];
// State-directory entries the file copy leaves out: the database, which the
// backup API copies, and what belongs to one running server.
const SKIPPED = new Set([
  "statev2.sqlite",
  "statev2.sqlite-wal",
  "statev2.sqlite-shm",
  "statev2.sqlite-journal",
  "server-runtime.json",
  "server-owner.sqlite",
  "server-owner.sqlite-journal",
  "logs",
]);

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(legacyRuntime, "utf8"));
  } catch {
    return null;
  }
}

// node:sqlite rejects an explicit undefined options argument.
function hasScientMigration(location, options = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(location, options);
  try {
    const rows = db.prepare("SELECT migration_id, name FROM effect_sql_migrations").all();
    return rows.some((row) =>
      SCIENT_ONLY_MIGRATIONS.some(([id, name]) => Number(row.migration_id) === id && row.name === name),
    );
  } finally {
    db.close();
  }
}

// Nothing here may create files beside a database that could be upstream's: an
// immutable connection reads the file as it is. Rows that live only in a WAL
// are read from a private copy. An unreadable or upstream database is never
// Scient's to copy.
function scientOwned() {
  try {
    if (hasScientMigration(url.pathToFileURL(legacyDb).href + "?immutable=1", { readOnly: true })) return true;
  } catch {}
  if (!exists(legacyDb + "-wal")) return false;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scient-ledger-"));
  try {
    fs.copyFileSync(legacyDb, path.join(scratch, "statev2.sqlite"));
    fs.copyFileSync(legacyDb + "-wal", path.join(scratch, "statev2.sqlite-wal"));
    return hasScientMigration(path.join(scratch, "statev2.sqlite"));
  } catch {
    return false;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// A symbolic link would be copied as a link, and both homes would then share
// its target.
function findLink(dir, top) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (top && SKIPPED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return full;
    if (entry.isDirectory()) {
      const found = findLink(full, false);
      if (found) return found;
    }
  }
  return null;
}

// Whether a live PID is still the process that wrote a runtime record:
// "same", "different" (the PID was reused after the record), or "unknown".
function processIdentity(pid, recordedStart) {
  const recordedAt = Date.parse(String(recordedStart));
  if (!Number.isFinite(recordedAt)) return "unknown";
  try {
    const output = childProcess.execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    // ps reports whole seconds.
    const startedAt = Date.parse(output.trim() + " UTC");
    if (!Number.isFinite(startedAt)) return "unknown";
    return startedAt <= recordedAt + 1000 ? "same" : "different";
  } catch {
    return "unknown";
  }
}

// The server this launcher started on the old home: its managed record and the
// old home's runtime record name the same live PID, and that process is the
// one that wrote the runtime record. Nothing is signalled on less proof.
function stopManagedServer() {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(legacyLaunch, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const pid = Number(read("pid"));
  if (read("managed") !== "managed" || !Number.isInteger(pid) || pid <= 0) return;
  const runtime = readRuntime();
  if (Number(runtime?.pid) !== pid || !alive(pid)) return;
  const identity = processIdentity(pid, runtime.startedAt);
  if (identity === "different") return;
  if (identity === "unknown") {
    fail("Scient could not confirm that PID " + pid + " is the Scient server it started on " + legacyHome + ", so it did not stop it and copied nothing. Stop that server, then reconnect. " + SKIP_HINT);
  }
  process.kill(pid, "SIGTERM");
  for (let waited = 0; alive(pid) && waited < 100; waited += 1) sleep(100);
  if (alive(pid)) {
    fail("The Scient server with PID " + pid + " on " + legacyHome + " did not stop within 10 seconds. Nothing was copied; retry the connection.");
  }
  for (const name of ["pid", "port", "managed"]) fs.rmSync(path.join(legacyLaunch, name), { force: true });
}

// The same exclusive lock a Scient server holds on its state directory for
// its lifetime. Holding it keeps a server from starting on the old home
// mid-copy. Null when a server holds it.
function lockLegacyHome() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(legacyState, "server-owner.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return db;
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.code === "SQLITE_BUSY") return null;
    throw error;
  }
}

// Servers from before the lock only publish a runtime record. A reused PID is
// not its owner; an unconfirmed one is.
function legacyOwnerIsLive() {
  const runtime = readRuntime();
  const pid = Number(runtime?.pid);
  if (!runtime || runtime.ownerId !== undefined || !Number.isInteger(pid) || pid <= 0) return false;
  return alive(pid) && processIdentity(pid, runtime.startedAt) !== "different";
}

// Staged beside the new home and renamed into place, so an interrupted copy
// never leaves a partial home. The database goes through SQLite's backup API,
// which yields one consistent snapshot even if another connection writes or
// checkpoints during the copy.
async function copyState() {
  const parent = path.dirname(home);
  const stagingPrefix = path.basename(home) + ".migrating-";
  // Only a migration holding the lock stages, so any leftover is abandoned.
  for (const entry of fs.readdirSync(parent)) {
    if (entry.startsWith(stagingPrefix)) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
  }
  const staging = fs.mkdtempSync(path.join(parent, stagingPrefix));
  try {
    const stagedState = path.join(staging, "userdata");
    fs.cpSync(legacyState, stagedState, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      filter: (source) => {
        if (path.dirname(source) === legacyState && SKIPPED.has(path.basename(source))) return false;
        const stat = fs.lstatSync(source);
        return stat.isFile() || stat.isDirectory();
      },
    });
    const { DatabaseSync, backup } = require("node:sqlite");
    const source = new DatabaseSync(legacyDb, { readOnly: true });
    try {
      await backup(source, path.join(stagedState, "statev2.sqlite"));
    } finally {
      source.close();
    }
    fs.renameSync(staging, home);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

(async () => {
  if (exists(home)) return;
  if (!exists(legacyDb) || !scientOwned()) {
    fs.mkdirSync(home, { recursive: true });
    return;
  }
  if (fs.lstatSync(legacyState).isSymbolicLink() || findLink(legacyState, true)) {
    const link = fs.lstatSync(legacyState).isSymbolicLink() ? legacyState : findLink(legacyState, true);
    fail("Scient cannot copy its data from " + legacyHome + " because " + link + " is a symbolic link, and the copy would share its target with the old folder. " + SKIP_HINT);
  }
  stopManagedServer();
  let lock;
  try {
    lock = lockLegacyHome();
  } catch (error) {
    fail("Scient could not check whether a server is using " + legacyHome + ": " + error.message + ". Nothing was copied.");
  }
  if (lock === null || legacyOwnerIsLive()) {
    lock?.close();
    fail(
      "A Scient server from an earlier version is still running on " + legacyHome + ". " +
        "Scient copies that data to " + home + " once, and only while no server uses it. " +
        "Disconnect older Scient apps from this host or stop that server, then reconnect. " + SKIP_HINT,
    );
  }
  try {
    if (!exists(home)) await copyState();
  } catch (error) {
    fail("Scient could not copy its data from " + legacyHome + " to " + home + ": " + error.message + ". " + legacyHome + " was not changed.");
  } finally {
    lock.close();
  }
})().catch((error) => fail("Scient could not prepare " + home + ": " + error.message));
`;

/**
 * The launch-script step that stops before anything creates the new home when
 * an earlier home may need copying. The archive runner ships no Node, and
 * Scient's desktop never selects it, so an archive launch starts fresh.
 */
export function buildScientHomeCheckStep(archiveMode: boolean): string {
  if (archiveMode) return "";
  return `if [ ! -e "$DEFAULT_SERVER_HOME" ] && [ -f "${T3_REMOTE_HOME}/userdata/statev2.sqlite" ]; then
  printf '%s\\n' '${SCIENT_HOME_MIGRATION_REQUIRED}'
  exit 0
fi`;
}

export function buildRemoteScientHomeMigrationScript(nodeEnvScript: string): string {
  return `set -eu
${nodeEnvScript}
DEFAULT_SERVER_HOME="$HOME/.scient-next"
if [ -e "$DEFAULT_SERVER_HOME" ]; then
  exit 0
fi
if ! ensure_remote_node_path; then
  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
  exit 1
fi
node --no-warnings - "${T3_REMOTE_HOME}" "$DEFAULT_SERVER_HOME" "$1" <<'NODE'
${REMOTE_SCIENT_HOME_MIGRATION_SCRIPT.replace(/\n+$/u, "")}
NODE
`;
}

/**
 * Runs the copy as its own SSH step: a large state directory must not spend
 * the launch's budget, and a timed-out launch would discard a partial copy.
 */
export const migrateRemoteScientHome = Effect.fn("ssh/scientRemoteHome.migrate")(function* (
  target: DesktopSshEnvironmentTarget,
  stateKey: string,
  nodeEnvScript: string,
  input?: SshAuth.SshAuthOptions,
) {
  yield* Effect.logInfo("ssh.remoteServer.scientHomeMigration.start", { stateKey });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-l", "-s", "--", stateKey],
    stdin: buildRemoteScientHomeMigrationScript(nodeEnvScript),
    timeoutMs: REMOTE_SCIENT_HOME_MIGRATION_TIMEOUT_MS,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  }).pipe(
    Effect.catchTags({
      SshCommandError: (error) =>
        Effect.fail(
          new SshCommandError({
            command: error.command,
            exitCode: error.exitCode,
            stderr: error.stderr,
            ...(error.stdout === undefined ? {} : { stdout: error.stdout }),
            message: `Scient could not copy its earlier remote data from ~/.t3 to ~/.scient-next. ${error.message}`,
            cause: error,
          }),
        ),
    }),
  );
  yield* Effect.logInfo("ssh.remoteServer.scientHomeMigration.done", { stateKey });
});
