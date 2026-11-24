#!/usr/bin/env node
// Finds finished and idle linked Git worktrees under one folder and, with --apply,
// removes them. Every installed checkout adds ~250,000 files that file watchers and
// Spotlight track; removed checkouts keep their branch (and an archive/ tag), so no
// commit is lost. Scient's own managed worktrees have their own cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export const KEEP_MARKER = ".keep-worktree";
const PROTECTED_NAMES = new Set(["scient-desktop-identity"]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A checkout made from main moments ago is "in main" before it has any work.
const MERGED_QUIET_MS = 6 * HOUR_MS;

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
export function parseArgs(argv, env = process.env, platform = process.platform) {
  const options = {
    apply: false,
    json: false,
    root: env.SCIENT_WORKTREES_ROOT ?? null,
    idleDays: 3,
    stateDb: NodePath.join(
      env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".scient-next"),
      "userdata",
      "statev2.sqlite",
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = argv[++index] ?? null;
    else if (arg === "--state-db") options.stateDb = argv[++index] ?? options.stateDb;
    else if (arg === "--idle-days") options.idleDays = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.root) throw new Error("Pass --root <folder> or set SCIENT_WORKTREES_ROOT.");
  if (!Number.isFinite(options.idleDays) || options.idleDays < 1) {
    throw new Error("--idle-days must be a number of at least 1.");
  }
  if (options.apply && platform === "win32") {
    throw new Error("--apply needs ps and lsof to see running processes; use macOS or Linux.");
  }
  options.root = NodePath.resolve(options.root);
  if (NodeFS.existsSync(options.root)) options.root = NodeFS.realpathSync(options.root);
  return options;
}

// Pure decision from gathered facts. Order matters: anything that could hold
// unsaved or in-use work wins over merged or idle.
export function decide(facts, { now, idleDays }) {
  if (facts.protected) return { action: "keep", reason: facts.protected };
  if (!facts.linked) return { action: "keep", reason: "standalone clone" };
  if (facts.dirty) return { action: "keep", reason: "uncommitted changes" };
  if (facts.running) return { action: "keep", reason: "process running from it" };
  if (facts.threads > 0) return { action: "keep", reason: `${facts.threads} thread(s) bound` };
  // Its dev app holds the candidate's own threads and projects; the owner reviews them first.
  if (facts.devState) {
    return {
      action: "keep",
      reason: facts.merged
        ? `${facts.merged}, but has dev app state`
        : "unmerged, has dev app state",
    };
  }
  if (facts.ignoredKept.length > 0) {
    return { action: "keep", reason: `ignored files: ${facts.ignoredKept.slice(0, 3).join(", ")}` };
  }
  const idleMs = now - facts.lastActivityMs;
  if (facts.merged) {
    return idleMs >= MERGED_QUIET_MS
      ? { action: "remove", reason: facts.merged }
      : { action: "keep", reason: "used in the last 6 hours" };
  }
  if (idleMs >= idleDays * DAY_MS) {
    return { action: "remove", reason: `idle ${Math.floor(idleMs / DAY_MS)} days`, archive: true };
  }
  return { action: "keep", reason: "recently used" };
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(checkout, args) {
  return run("git", ["-C", checkout, ...args]);
}

function mtimeMs(filePath) {
  return NodeFS.statSync(filePath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

function githubRepo(checkout) {
  const url = git(checkout, ["remote", "get-url", "origin"]).stdout.trim();
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(url)?.[1] ?? null;
}

// The live default branch and its tip, once per repository; null when unverifiable.
const remoteDefaults = new Map();
function remoteDefault(checkout) {
  const common = git(checkout, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).stdout.trim();
  if (!remoteDefaults.has(common)) {
    const listed = git(checkout, ["ls-remote", "--symref", "origin", "HEAD"]);
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(listed.stdout)?.[1];
    const tip = /^([0-9a-f]{40,64})\tHEAD$/mu.exec(listed.stdout)?.[1];
    remoteDefaults.set(common, listed.ok && branch && tip ? { branch, tip } : null);
  }
  return remoteDefaults.get(common);
}

function mergedReason(checkout, branch, head) {
  const base = remoteDefault(checkout);
  if (!base) return null;
  // A stale local copy of the default branch lacks the live tip; that is "unknown".
  if (
    git(checkout, ["cat-file", "-e", `${base.tip}^{commit}`]).ok &&
    git(checkout, ["merge-base", "--is-ancestor", head, base.tip]).ok
  ) {
    return `in origin/${base.branch}`;
  }
  const repo = githubRepo(checkout);
  if (!repo || !branch) return null;
  const pulls = run("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number,headRefOid,baseRefName",
  ]);
  if (!pulls.ok) return null;
  const merged = JSON.parse(pulls.stdout).find(
    (pull) => pull.headRefOid === head && pull.baseRefName === base.branch,
  );
  return merged ? `PR #${merged.number} merged at this head` : null;
}

function canonical(path) {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
}

// A thread runs in its worktree, or in its project's folder when it has none,
// as Scient itself resolves it. A database that can't be read stops the sweep.
export function threadCounts(stateDb, roots) {
  const counts = new Map(roots.map((root) => [root, 0]));
  if (!NodeFS.existsSync(stateDb)) {
    throw new Error(`Scient database not found: ${stateDb}. Pass --state-db.`);
  }
  const db = new NodeSqlite.DatabaseSync(stateDb, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `select coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) as path
         from orchestration_v2_projection_threads t
         left join projection_projects p on p.project_id = t.project_id
         where t.deleted_at is null and path is not null`,
      )
      .all();
    for (const { path } of rows) {
      const real = canonical(path);
      for (const root of roots) {
        if (real === root || real.startsWith(`${root}${NodePath.sep}`)) {
          counts.set(root, counts.get(root) + 1);
        }
      }
    }
  } finally {
    db.close();
  }
  return counts;
}

// A failed scan means "unknown", which must never read as "unused".
function processPaths() {
  const listed = run("ps", ["-Ao", "command="]);
  const opened = run("lsof", ["-a", "-d", "cwd", "-Fn"]);
  if (!listed.ok || !opened.ok) throw new Error("Could not list processes with ps and lsof.");
  const cwds = opened.stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  return { commands: listed.stdout, cwds };
}

function usedByProcess(checkout, processes) {
  const escaped = checkout.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // The path as a whole argument or a prefix of one, not a sibling like `<path>-2`.
  const mention = new RegExp(`${escaped}(?:[/\\\\\\s"'=:]|$)`, "mu");
  const prefix = `${checkout}${NodePath.sep}`;
  return (
    mention.test(processes.commands) ||
    processes.cwds.some((cwd) => cwd === checkout || cwd.startsWith(prefix))
  );
}

// Ignored entries git would delete with the checkout. Only rebuildable outputs and
// symlinks may go; anything else (notes, .env.local, a nested repo) keeps it.
const DISPOSABLE = new Set([
  ".cache",
  ".DS_Store",
  ".electron-runtime",
  ".next",
  ".t3",
  ".turbo",
  ".vite",
  ".vitest",
  "build",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "out",
  "target",
]);

export function keptIgnoredEntries(checkout, statusOutput) {
  const kept = [];
  for (const entry of statusOutput.split("\0")) {
    if (!entry.startsWith("!! ")) continue;
    const relative = entry.slice(3).replace(/\/$/u, "");
    const absolute = NodePath.join(checkout, relative);
    const stats = NodeFS.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats || stats.isSymbolicLink()) continue;
    const name = NodePath.basename(relative);
    const nestedRepo = stats.isDirectory() && NodeFS.existsSync(NodePath.join(absolute, ".git"));
    if (nestedRepo || !(DISPOSABLE.has(name) || name.endsWith(".tsbuildinfo"))) kept.push(relative);
  }
  return kept;
}

export function gatherFacts(checkout, { threads, processes, lockedPaths }) {
  const name = NodePath.basename(checkout);
  const dotGit = NodeFS.lstatSync(NodePath.join(checkout, ".git"));
  const branch =
    git(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null;
  const head = git(checkout, ["rev-parse", "HEAD"]).stdout.trim();
  // --no-optional-locks: a status must not refresh the index, whose mtime marks activity.
  const status = git(checkout, [
    "--no-optional-locks",
    "status",
    "--porcelain",
    "-z",
    "--ignored=traditional",
    "--untracked-files=normal",
  ]);
  const entries = status.stdout.split("\0");
  const gitPath = (file) =>
    NodePath.resolve(checkout, git(checkout, ["rev-parse", "--git-path", file]).stdout.trim());
  const devState = NodeFS.existsSync(NodePath.join(checkout, ".scient-next"));
  const protectedReason = PROTECTED_NAMES.has(name)
    ? "protected checkout"
    : NodeFS.existsSync(NodePath.join(checkout, KEEP_MARKER))
      ? `${KEEP_MARKER} marker`
      : lockedPaths.has(checkout)
        ? "locked worktree"
        : null;
  const facts = {
    name,
    path: checkout,
    branch,
    head,
    linked: dotGit.isFile(),
    protected: protectedReason,
    dirty: !status.ok || entries.some((entry) => entry !== "" && !entry.startsWith("!! ")),
    ignoredKept: status.ok ? keptIgnoredEntries(checkout, status.stdout) : [],
    running: usedByProcess(checkout, processes),
    threads: threads.get(checkout) ?? 0,
    devState,
    lastActivityMs: Math.max(
      mtimeMs(gitPath("logs/HEAD")),
      mtimeMs(gitPath("index")),
      mtimeMs(gitPath("HEAD")),
      devState ? mtimeMs(NodePath.join(checkout, ".scient-next")) : 0,
    ),
    merged: null,
  };
  // The merge lookup can call GitHub, so only ask when nothing else keeps it.
  if (!facts.protected && facts.linked && !facts.dirty && !facts.running && facts.threads === 0) {
    facts.merged = mergedReason(checkout, branch, head);
  }
  return facts;
}

function lockedWorktrees(checkouts) {
  const locked = new Set();
  const seen = new Set();
  for (const checkout of checkouts) {
    const common = git(checkout, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).stdout.trim();
    if (!common || seen.has(common)) continue;
    seen.add(common);
    let current = null;
    for (const line of git(checkout, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      else if (line.startsWith("locked") && current) locked.add(current);
    }
  }
  return locked;
}

function listCheckouts(root) {
  return NodeFS.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(root, entry.name))
    .filter((checkout) => NodeFS.existsSync(NodePath.join(checkout, ".git")));
}

export function archiveTag(facts) {
  return `archive/${facts.name}-${facts.head.slice(0, 12)}`;
}

function removeCheckout(facts, decision) {
  if (decision.archive) {
    // The commit id in the name keeps a reused folder name from replacing an older tag.
    const tag = archiveTag(facts);
    const created = git(facts.path, ["tag", tag, facts.head]);
    const existing = git(facts.path, ["rev-parse", `refs/tags/${tag}^{commit}`]).stdout.trim();
    if (!created.ok && existing !== facts.head) return `tag failed: ${created.stderr.trim()}`;
  }
  // Without --force, Git refuses a checkout that gained changes since the check.
  const removed = git(facts.path, ["worktree", "remove", facts.path]);
  return removed.ok ? null : removed.stderr.trim();
}

export function sweep(options, { listProcesses = processPaths } = {}) {
  const now = Date.now();
  const checkouts = listCheckouts(options.root);
  const processes = listProcesses();
  const threads = threadCounts(options.stateDb, checkouts);
  const lockedPaths = lockedWorktrees(checkouts);
  const results = [];
  for (const checkout of checkouts) {
    const facts = gatherFacts(checkout, { threads, processes, lockedPaths });
    const decision = decide(facts, { now, idleDays: options.idleDays });
    const result = { ...facts, ...decision, removed: false, error: null };
    if (options.apply && decision.action === "remove") {
      // Recheck right before removal: a thread or process may have started meanwhile.
      const fresh = gatherFacts(checkout, {
        threads: threadCounts(options.stateDb, [checkout]),
        processes: listProcesses(),
        lockedPaths: lockedWorktrees([checkout]),
      });
      const again = decide(fresh, { now: Date.now(), idleDays: options.idleDays });
      if (again.action !== "remove") Object.assign(result, again);
      else {
        result.error = removeCheckout(fresh, again);
        result.removed = result.error === null;
      }
    }
    results.push(result);
  }
  return results;
}

function report(results, options) {
  const lines = [];
  const removable = results.filter((result) => result.action === "remove");
  const verb = options.apply ? "Removed" : "Would remove";
  lines.push(
    `${verb} ${String(options.apply ? results.filter((r) => r.removed).length : removable.length)} of ${String(results.length)} checkouts in ${options.root}.`,
  );
  for (const result of removable) {
    const state = options.apply
      ? result.removed
        ? "removed"
        : `FAILED: ${result.error}`
      : "remove";
    const archive = result.archive ? ` (branch kept, tag ${archiveTag(result)})` : "";
    lines.push(`  ${state}  ${result.name}: ${result.reason}${archive}`);
  }
  for (const result of results.filter((r) => r.action === "keep")) {
    const idleDays = Math.floor((Date.now() - result.lastActivityMs) / DAY_MS);
    const idle = idleDays >= 1 ? `, idle ${String(idleDays)} days` : "";
    lines.push(`  keep    ${result.name}: ${result.reason}${idle}`);
  }
  if (!options.apply && removable.length > 0) lines.push("Run again with --apply to remove them.");
  return lines.join("\n");
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const results = sweep(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(results, null, 2)}\n` : `${report(results, options)}\n`,
    );
    if (results.some((result) => result.error)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
