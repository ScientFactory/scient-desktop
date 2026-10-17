// SCIENT-OWNED: Scient's remote server home for SSH launches. tunnel.ts uses
// these from short marked lines.
//
// The remote home is `~/.scient-next`, the same directory Scient desktop uses
// on its own computer, so connecting to a machine that runs Scient desktop
// reuses that machine's server. It is never T3's `~/.t3`: a T3 server there is
// never adopted, and the two products never share a state database.
//
// Earlier Scient builds kept SSH state in `~/.t3`. The first launch that finds
// no `~/.scient-next` copies that state once, and only when its database
// proves Scient wrote it. The copy leaves `~/.t3` in place, so an older Scient
// desktop keeps working against it. Only the state directory (`userdata`) is
// copied, without the live server's discovery record, ownership lock, and
// logs. Worktrees, projects and scratch folders stay where they are: the
// database records them by absolute path and Git registers worktrees at their
// location, so a copy would be an unregistered duplicate nothing points at.
// Installed runtimes, tools and caches are rebuilt on demand, and some record
// their own absolute paths.

const T3_REMOTE_HOME = "$HOME/.t3";

/**
 * Copies an earlier Scient SSH home out of `~/.t3` into an absent new home.
 * Usage: `node - <legacy home> <new home> <launch state key>`. Exits 0 when the
 * home is ready to use, copied or not; exits 1 with a message when a copy is
 * owed but cannot happen safely.
 */
export const REMOTE_SCIENT_HOME_MIGRATION_SCRIPT = `const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const [legacyHome, home, stateKey] = process.argv.slice(2);
const legacyState = path.join(legacyHome, "userdata");
const legacyRuntime = path.join(legacyState, "server-runtime.json");
const legacyLaunch = path.join(legacyHome, "ssh-launch", stateKey);
// Ledger entries only Scient records (apps/server/src/persistence/Migrations.ts).
// T3 never shipped these names, and both products refuse a database whose
// ledger names an id differently.
const SCIENT_ONLY_MIGRATIONS = [
  [41, "ProjectlessThreads"],
  [43, "RetireProjectlessThreads"],
  [58, "ProjectionThreadSections"],
];
// State-directory entries that belong to one running server, not to the data.
// SQLite rebuilds the shared-memory index from the database and its WAL.
const SKIPPED = new Set([
  "statev2.sqlite-shm",
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

// A read-only connection still creates -wal and -shm files beside a database
// that has none, which T3's home must never gain. An immutable one reads the
// file as it is; without a WAL it misses nothing.
function openLedger(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  if (!exists(dbPath + "-wal")) {
    try {
      return new DatabaseSync(url.pathToFileURL(dbPath).href + "?immutable=1", { readOnly: true });
    } catch {}
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

// An unreadable or upstream database is never Scient's to copy.
function scientOwned() {
  let db;
  try {
    db = openLedger(path.join(legacyState, "statev2.sqlite"));
    const rows = db.prepare("SELECT migration_id, name FROM effect_sql_migrations").all();
    return rows.some((row) =>
      SCIENT_ONLY_MIGRATIONS.some(([id, name]) => Number(row.migration_id) === id && row.name === name),
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

// The server this launcher started on the old home, recognized by its managed
// record and the old home's runtime record naming the same live PID.
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
  if (Number(readRuntime()?.pid) !== pid || !alive(pid)) return;
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

// Servers from before the lock only publish a runtime record. A live PID that
// started after the record was written is a reused PID, not its owner.
function legacyOwnerIsLive() {
  const runtime = readRuntime();
  const pid = Number(runtime?.pid);
  if (!runtime || runtime.ownerId !== undefined || !Number.isInteger(pid) || pid <= 0) return false;
  if (!alive(pid)) return false;
  const recordedAt = Date.parse(String(runtime.startedAt));
  if (!Number.isFinite(recordedAt)) return true;
  try {
    const output = childProcess.execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const startedAt = Date.parse(output.trim() + " UTC");
    return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1000;
  } catch {
    return true;
  }
}

// Staged beside the new home and renamed into place, so an interrupted copy
// never leaves a partial home that would block the next attempt.
function copyState() {
  const parent = path.dirname(home);
  const stagingPrefix = path.basename(home) + ".migrating-";
  // Only a migration holding the lock stages, so any leftover is abandoned.
  for (const entry of fs.readdirSync(parent)) {
    if (entry.startsWith(stagingPrefix)) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
  }
  const staging = fs.mkdtempSync(path.join(parent, stagingPrefix));
  try {
    fs.cpSync(legacyState, path.join(staging, "userdata"), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => {
        if (path.dirname(source) === legacyState && SKIPPED.has(path.basename(source))) return false;
        const stat = fs.lstatSync(source);
        return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
      },
    });
    fs.renameSync(staging, home);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (exists(home) || !exists(path.join(legacyState, "statev2.sqlite")) || !scientOwned()) {
  process.exit(0);
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
      "Disconnect older Scient apps from this host or stop that server, then reconnect.",
  );
}
try {
  if (!exists(home)) copyState();
} catch (error) {
  fail("Scient could not copy its data from " + legacyHome + " to " + home + ": " + error.message + ". " + legacyHome + " was not changed.");
} finally {
  lock.close();
}
`;

/**
 * The launch-script step that runs the copy before anything creates the new
 * home. The archive runner ships no Node, and Scient's desktop never selects
 * it, so an archive launch starts with a fresh home.
 */
export function buildScientHomeMigrationStep(archiveMode: boolean): string {
  if (archiveMode) return "";
  return `if [ ! -e "$DEFAULT_SERVER_HOME" ] && [ -f "${T3_REMOTE_HOME}/userdata/statev2.sqlite" ]; then
  if ! ensure_remote_node_path; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  node --no-warnings - "${T3_REMOTE_HOME}" "$DEFAULT_SERVER_HOME" "$STATE_KEY" <<'NODE'
${REMOTE_SCIENT_HOME_MIGRATION_SCRIPT.replace(/\n+$/u, "")}
NODE
fi`;
}
