// @effect-diagnostics nodeBuiltinImport:off - Runs the generated remote Node
// script against synthetic SQLite homes, the way the migration step runs it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";

import {
  buildRemoteScientHomeMigrationScript,
  buildScientHomeCheckStep,
  REMOTE_SCIENT_HOME_MIGRATION_SCRIPT,
  SCIENT_HOME_MIGRATION_REQUIRED,
} from "./scientRemoteHome.ts";

const STATE_KEY = "0123456789abcdef";
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

// Representative ledgers: Scient records ProjectlessThreads at 41, where T3
// records AuthSessionClientConnection.
const SCIENT_LEDGER = [
  [40, "ProjectionProjectFaviconPath"],
  [41, "ProjectlessThreads"],
  [42, "AuthSessionClientConnection"],
] as const;
const T3_LEDGER = [
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
] as const;
const LEDGER_TABLE = `CREATE TABLE effect_sql_migrations (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
);`;

const roots: Array<string> = [];
const openDatabases: Array<NodeSqlite.DatabaseSync> = [];
const children: Array<NodeChildProcess.ChildProcess> = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.isOpen) db.close();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

// A runtime record's start time, as a server writes it: the real wall clock,
// because the script compares it with the process start time `ps` reports.
const isoMinutesFromNow = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { minutes }));

function makeHost() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-home-migration-"));
  roots.push(root);
  const script = NodePath.join(root, "migrate.cjs");
  NodeFS.writeFileSync(script, REMOTE_SCIENT_HOME_MIGRATION_SCRIPT);
  const legacy = NodePath.join(root, "home", ".t3");
  const home = NodePath.join(root, "home", ".scient-next");
  NodeFS.mkdirSync(NodePath.dirname(legacy), { recursive: true });
  return { root, script, legacy, home, userdata: NodePath.join(legacy, "userdata") };
}

type Host = ReturnType<typeof makeHost>;

function insertLedger(
  db: NodeSqlite.DatabaseSync,
  ledger: ReadonlyArray<readonly [number, string]>,
) {
  const insert = db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)");
  for (const [id, name] of ledger) insert.run(id, name);
}

// A legacy home with a ledger, data a user would miss, and the per-server
// files that must not follow it. Leaves the database open when asked, so its
// WAL still holds the latest writes.
function writeLegacyHome(
  host: Host,
  ledger: ReadonlyArray<readonly [number, string]>,
  options: { readonly keepOpen?: boolean } = {},
) {
  NodeFS.mkdirSync(NodePath.join(host.userdata, "secrets"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(host.userdata, "attachments"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(host.userdata, "logs"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(host.legacy, "worktrees", "repo", "feature"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(host.legacy, "ssh-launch", STATE_KEY), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(host.userdata, "statev2.sqlite"));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
${LEDGER_TABLE}
CREATE TABLE threads (id TEXT PRIMARY KEY, worktree TEXT);`);
  insertLedger(db, ledger);
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(
    "thread-1",
    NodePath.join(host.legacy, "worktrees", "repo", "feature"),
  );
  if (options.keepOpen) openDatabases.push(db);
  else db.close();
  NodeFS.writeFileSync(NodePath.join(host.userdata, "settings.json"), '{"fixture":true}\n');
  NodeFS.writeFileSync(NodePath.join(host.userdata, "environment-id"), "env-fixture\n");
  NodeFS.writeFileSync(NodePath.join(host.userdata, "secrets", "server-signing-key"), "synthetic");
  NodeFS.writeFileSync(NodePath.join(host.userdata, "attachments", "a.txt"), "attachment");
  NodeFS.writeFileSync(NodePath.join(host.userdata, "logs", "server.log"), "log");
  NodeFS.writeFileSync(NodePath.join(host.legacy, "worktrees", "repo", "feature", "f.txt"), "w");
}

// A database left by a crashed server: every row still in the WAL, and no
// shared-memory index beside it.
function writeCrashedDatabase(host: Host, ledger: ReadonlyArray<readonly [number, string]>) {
  const scratch = NodePath.join(host.root, "crash");
  NodeFS.mkdirSync(scratch);
  NodeFS.mkdirSync(host.userdata, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(scratch, "statev2.sqlite"));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${LEDGER_TABLE}`);
  insertLedger(db, ledger);
  for (const suffix of ["", "-wal"]) {
    NodeFS.copyFileSync(
      NodePath.join(scratch, `statev2.sqlite${suffix}`),
      NodePath.join(host.userdata, `statev2.sqlite${suffix}`),
    );
  }
  db.close();
}

function writeRuntime(host: Host, runtime: Record<string, unknown>) {
  NodeFS.writeFileSync(
    NodePath.join(host.userdata, "server-runtime.json"),
    JSON.stringify(runtime),
  );
}

function startManagedServer(host: Host, startedAt: string | undefined) {
  const server = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(server);
  const pid = server.pid ?? 0;
  const launch = NodePath.join(host.legacy, "ssh-launch", STATE_KEY);
  NodeFS.writeFileSync(NodePath.join(launch, "pid"), `${pid}\n`);
  NodeFS.writeFileSync(NodePath.join(launch, "port"), "3773\n");
  NodeFS.writeFileSync(NodePath.join(launch, "managed"), "managed\n");
  writeRuntime(host, {
    version: 1,
    pid,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  return { pid, launch };
}

// Async so this test process keeps reaping a server the script stops.
function runMigration(host: Host) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = NodeChildProcess.execFile(
      process.execPath,
      ["--no-warnings", host.script, host.legacy, host.home, STATE_KEY],
      { encoding: "utf8", timeout: 30_000 },
      (_error, _stdout, stderr) => resolve({ code: child.exitCode, stderr }),
    );
  });
}

// Every file under a directory with its contents, so an untouched home can be
// compared byte for byte. An open database's files are listed by name only:
// Windows locks ranges of them against other readers.
function snapshot(dir: string, options: { readonly skipDatabase?: boolean } = {}) {
  const files: Record<string, string> = {};
  if (!NodeFS.existsSync(dir)) return files;
  for (const entry of NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = NodePath.join(entry.parentPath, entry.name);
    files[NodePath.relative(dir, file)] =
      options.skipDatabase && entry.name.startsWith("statev2.sqlite")
        ? "database"
        : NodeFS.readFileSync(file).toString("base64");
  }
  return files;
}

function stagingLeftovers(host: Host) {
  return NodeFS.readdirSync(NodePath.dirname(host.home)).filter((entry) =>
    entry.startsWith(".scient-next.migrating-"),
  );
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertEmptyNewHome(host: Host) {
  assert.deepEqual(NodeFS.readdirSync(host.home), []);
}

describe("Scient remote home migration", () => {
  it("creates an empty home when there is nothing to copy", async () => {
    const host = makeHost();
    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assertEmptyNewHome(host);
    assert.isFalse(NodeFS.existsSync(host.legacy));
  });

  it("copies a Scient-owned ~/.t3 state directory once and leaves ~/.t3 in place", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER, { keepOpen: true });
    writeRuntime(host, { version: 1, pid: 999_999_999, port: 3773, origin: "http://127.0.0.1" });
    const before = snapshot(host.legacy, { skipDatabase: true });

    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    const copied = NodePath.join(host.home, "userdata");
    for (const name of ["settings.json", "environment-id", "secrets/server-signing-key"]) {
      assert.equal(
        NodeFS.readFileSync(NodePath.join(copied, name), "utf8"),
        NodeFS.readFileSync(NodePath.join(host.userdata, name), "utf8"),
      );
    }
    assert.isTrue(NodeFS.existsSync(NodePath.join(copied, "attachments", "a.txt")));
    // The live server's discovery record, lock and logs stay behind, as do
    // worktrees and the launcher's state. The database arrives as one
    // standalone file from the backup, without the source's WAL.
    assert.isFalse(NodeFS.existsSync(NodePath.join(copied, "server-runtime.json")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(copied, "server-owner.sqlite")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(copied, "statev2.sqlite-wal")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(copied, "logs")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(host.home, "worktrees")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(host.home, "ssh-launch")));
    assert.deepEqual(stagingLeftovers(host), []);

    // The copied database includes writes still in the WAL, and keeps the
    // absolute worktree path, which still resolves in place.
    const copy = new NodeSqlite.DatabaseSync(NodePath.join(copied, "statev2.sqlite"));
    openDatabases.push(copy);
    assert.equal(copy.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    const thread = copy.prepare("SELECT worktree FROM threads").get();
    assert.equal(thread?.worktree, NodePath.join(host.legacy, "worktrees", "repo", "feature"));
    assert.isTrue(NodeFS.existsSync(String(thread?.worktree)));
    copy.close();

    // ~/.t3 keeps every file it had; only the ownership lock file is new.
    const after = snapshot(host.legacy, { skipDatabase: true });
    delete after[NodePath.join("userdata", "server-owner.sqlite")];
    assert.deepEqual(after, before);

    // Once the new home exists, later launches never copy again.
    NodeFS.writeFileSync(NodePath.join(host.userdata, "settings.json"), '{"changed":true}\n');
    const again = await runMigration(host);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(copied, "settings.json"), "utf8"),
      '{"fixture":true}\n',
    );
  });

  it("never touches a ~/.t3 that T3 Code owns", async () => {
    const host = makeHost();
    writeLegacyHome(host, T3_LEDGER);
    const before = snapshot(host.legacy);
    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assertEmptyNewHome(host);
    assert.deepEqual(snapshot(host.legacy), before);
  });

  it("reads WAL-only ledger rows without adding files beside T3 Code's database", async () => {
    const host = makeHost();
    writeCrashedDatabase(host, T3_LEDGER);
    const before = snapshot(host.legacy);
    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assertEmptyNewHome(host);
    assert.deepEqual(snapshot(host.legacy), before);
  });

  it("recognizes and copies a Scient database whose ledger is only in its WAL", async () => {
    const host = makeHost();
    writeCrashedDatabase(host, SCIENT_LEDGER);
    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    const copy = new NodeSqlite.DatabaseSync(
      NodePath.join(host.home, "userdata", "statev2.sqlite"),
    );
    openDatabases.push(copy);
    assert.lengthOf(copy.prepare("SELECT * FROM effect_sql_migrations").all(), 3);
  });

  it("starts fresh when the ~/.t3 database cannot be read", async () => {
    const host = makeHost();
    NodeFS.mkdirSync(host.userdata, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(host.userdata, "statev2.sqlite"), "not a database");
    const before = snapshot(host.legacy);
    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assertEmptyNewHome(host);
    assert.deepEqual(snapshot(host.legacy), before);
  });

  it("does nothing when the new home already exists", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    NodeFS.mkdirSync(host.home);
    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assertEmptyNewHome(host);
  });

  it("refuses to copy a state directory that contains a symbolic link", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    const outside = NodePath.join(host.root, "outside");
    NodeFS.mkdirSync(outside);
    // A junction needs no privilege on Windows and is a symbolic link elsewhere.
    NodeFS.symlinkSync(outside, NodePath.join(host.userdata, "attachments", "shared"), "junction");

    const result = await runMigration(host);
    assert.equal(result.code, 1);
    assert.include(result.stderr, "is a symbolic link");
    assert.include(result.stderr, `create an empty ${host.home} folder`);
    assert.isFalse(NodeFS.existsSync(host.home));
    assert.deepEqual(stagingLeftovers(host), []);
  });

  it("refuses to copy a state directory that is itself a symbolic link", async () => {
    const host = makeHost();
    const real = NodePath.join(host.root, "real-state");
    const hostWithRealState = { ...host, userdata: real };
    NodeFS.mkdirSync(host.legacy, { recursive: true });
    writeLegacyHome(hostWithRealState, SCIENT_LEDGER);
    NodeFS.symlinkSync(real, host.userdata, "junction");

    const result = await runMigration(host);
    assert.equal(result.code, 1);
    assert.include(result.stderr, "is a symbolic link");
    assert.isFalse(NodeFS.existsSync(host.home));
  });

  it("refuses to copy while a server holds the old home's ownership lock", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    const owner = new NodeSqlite.DatabaseSync(NodePath.join(host.userdata, "server-owner.sqlite"));
    openDatabases.push(owner);
    owner.exec("BEGIN EXCLUSIVE;");

    const result = await runMigration(host);
    assert.equal(result.code, 1);
    assert.include(result.stderr, "still running on");
    assert.isFalse(NodeFS.existsSync(host.home));
    assert.deepEqual(stagingLeftovers(host), []);
  });

  it("refuses to copy while an older server's runtime record names a live process", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    // This test process stands in for a server that predates the lock.
    writeRuntime(host, {
      version: 1,
      pid: process.pid,
      port: 3773,
      origin: "http://127.0.0.1:3773",
      startedAt: isoMinutesFromNow(0),
    });
    const result = await runMigration(host);
    assert.equal(result.code, 1);
    assert.include(result.stderr, "still running on");
    assert.isFalse(NodeFS.existsSync(host.home));
  });

  // Confirming a process's identity needs `ps`.
  it.skipIf(windowsHost)(
    "stops the server this launcher started on the old home before copying",
    async () => {
      const host = makeHost();
      writeLegacyHome(host, SCIENT_LEDGER);
      const { pid, launch } = startManagedServer(host, isoMinutesFromNow(1));

      const result = await runMigration(host);
      assert.equal(result.code, 0, result.stderr);
      assert.isFalse(isAlive(pid));
      assert.isFalse(NodeFS.existsSync(NodePath.join(launch, "pid")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(host.home, "userdata", "statev2.sqlite")));
    },
  );

  it.skipIf(windowsHost)("never signals a process that reused a stale record's PID", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    // The record predates this process, so the PID now names something else.
    const { pid } = startManagedServer(host, "2000-01-01T00:00:00.000Z");

    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assert.isTrue(isAlive(pid));
    assert.isTrue(NodeFS.existsSync(NodePath.join(host.home, "userdata", "statev2.sqlite")));
  });

  it("does not signal a recorded server whose identity cannot be confirmed", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    const { pid } = startManagedServer(host, undefined);

    const result = await runMigration(host);
    assert.equal(result.code, 1);
    assert.include(result.stderr, `could not confirm that PID ${pid}`);
    assert.isTrue(isAlive(pid));
    assert.isFalse(NodeFS.existsSync(host.home));
  });

  it("leaves an external server it did not start running", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    const { pid, launch } = startManagedServer(host, isoMinutesFromNow(1));
    NodeFS.writeFileSync(NodePath.join(launch, "managed"), "external\n");

    const result = await runMigration(host);
    assert.equal(result.code, 1);
    assert.isTrue(isAlive(pid));
    assert.isFalse(NodeFS.existsSync(host.home));
  });

  it("replaces an interrupted earlier copy instead of using it", async () => {
    const host = makeHost();
    writeLegacyHome(host, SCIENT_LEDGER);
    const abandoned = NodePath.join(NodePath.dirname(host.home), ".scient-next.migrating-abc123");
    NodeFS.mkdirSync(NodePath.join(abandoned, "userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(abandoned, "userdata", "partial"), "");

    const result = await runMigration(host);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stagingLeftovers(host), []);
    assert.isFalse(NodeFS.existsSync(NodePath.join(host.home, "userdata", "partial")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(host.home, "userdata", "settings.json")));
  });

  // Unreadable files need POSIX permissions that a root user ignores.
  it.skipIf(windowsHost || process.getuid?.() === 0)(
    "leaves no new home when the copy fails part way",
    async () => {
      const host = makeHost();
      writeLegacyHome(host, SCIENT_LEDGER);
      const unreadable = NodePath.join(host.userdata, "secrets", "server-signing-key");
      NodeFS.chmodSync(unreadable, 0o000);
      try {
        const result = await runMigration(host);
        assert.equal(result.code, 1);
        assert.include(result.stderr, "could not copy its data");
        assert.isFalse(NodeFS.existsSync(host.home));
        assert.deepEqual(stagingLeftovers(host), []);
      } finally {
        NodeFS.chmodSync(unreadable, 0o600);
      }
    },
  );

  it("defers the copy to its own step, only for runners that have Node", () => {
    assert.equal(buildScientHomeCheckStep(true), "");
    const check = buildScientHomeCheckStep(false);
    assert.include(
      check,
      'if [ ! -e "$DEFAULT_SERVER_HOME" ] && [ -f "$HOME/.t3/userdata/statev2.sqlite" ]; then',
    );
    assert.include(check, `printf '%s\\n' '${SCIENT_HOME_MIGRATION_REQUIRED}'`);
    const step = buildRemoteScientHomeMigrationScript("ensure_remote_node_path() { :; }");
    assert.include(step, 'node --no-warnings - "$HOME/.t3" "$DEFAULT_SERVER_HOME" "$1"');
    assert.include(step, REMOTE_SCIENT_HOME_MIGRATION_SCRIPT.trimEnd());
  });
});
