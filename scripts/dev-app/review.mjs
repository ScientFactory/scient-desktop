// Platform-independent parts of the standing dev app's review controller:
// reference parsing, locks, profiles and the install fingerprint. Everything
// that touches processes or the OS lives in host.mjs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Bump when the controller's expectations of a reviewed checkout change. */
export const DEV_APP_PROTOCOL = 1;
const MAX_PROFILES = 6;
const MAX_RETIRED_PROFILES = 2;

export function resolveStablePaths(homeDir) {
  const root = NodePath.join(homeDir, ".scient-next", "scient-dev-stable");
  const runtimeDir = NodePath.join(root, "dev-app-runtime");
  return {
    root,
    controllerDir: NodePath.join(root, "controller"),
    controllerConfigPath: NodePath.join(root, "controller", "controller.json"),
    profilesDir: NodePath.join(root, "profiles"),
    reviewPath: NodePath.join(root, "review.json"),
    operationLockPath: NodePath.join(root, "operation.lock"),
    // The name macOS's launchd service already writes to.
    logPath: NodePath.join(root, "local-dev-app.log"),
    runtimeDir,
    launchPath: NodePath.join(runtimeDir, "launch.json"),
    runnerLockPath: NodePath.join(runtimeDir, "runner.lock"),
    jobPath: NodePath.join(runtimeDir, "job.json"),
    jobEmptyPath: NodePath.join(runtimeDir, "job-empty.json"),
  };
}

// ── references ────────────────────────────────────────────────────────────

/**
 * `#123`, `pr:123` -> pull request; `commit:<sha>` or a bare 7-40 digit hex
 * string -> commit; `branch:<name>` or anything else -> branch.
 */
export function parseReviewRef(input) {
  const value = String(input ?? "").trim();
  const pr = /^(?:#|pr:)(\d+)$/iu.exec(value);
  if (pr) return { kind: "pr", number: Number(pr[1]), label: `#${pr[1]}` };
  const commit = /^(?:commit:)?([0-9a-f]{7,40})$/iu.exec(value);
  if (commit && (value.startsWith("commit:") || /^[0-9a-f]{40}$/iu.test(value))) {
    return { kind: "commit", sha: commit[1].toLowerCase(), label: commit[1].slice(0, 12) };
  }
  const branch = value.startsWith("branch:") ? value.slice("branch:".length) : value;
  if (!/^[A-Za-z0-9._/-]+$/u.test(branch) || branch.includes("..") || branch.startsWith("-")) {
    throw new Error(`Not a branch, pull request or commit: ${value || "(empty)"}`);
  }
  return { kind: "branch", name: branch, label: branch };
}

/** The refspec to fetch for a parsed reference; commits already present need none. */
export function fetchRefspec(ref) {
  if (ref.kind === "pr") return `refs/pull/${String(ref.number)}/head`;
  if (ref.kind === "branch") return `refs/heads/${ref.name}`;
  return ref.sha;
}

/** One profile per reviewed reference; the name is readable and filesystem-safe. */
export function profileIdForRef(ref) {
  if (ref.kind === "pr") return `pr-${String(ref.number)}`;
  if (ref.kind === "commit") return `commit-${ref.sha.slice(0, 12)}`;
  const slug = ref.name.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 40);
  const hash = NodeCrypto.createHash("sha256").update(ref.name).digest("hex").slice(0, 6);
  return `branch-${slug}-${hash}`;
}

// ── files ─────────────────────────────────────────────────────────────────

export function readJsonFile(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Write-then-rename, so a crash leaves either the old or the new content. */
export function writeJsonAtomic(path, value) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, path);
}

// ── locks ─────────────────────────────────────────────────────────────────

/**
 * Exclusive lock file holding its owner's {pid, start}. A lock is taken over
 * only when `ownerState(owner)` reports "gone"; "unknown" never counts as gone.
 */
export function tryAcquireLock(path, owner, { ownerState }) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      NodeFS.writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
      return { acquired: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let current;
    try {
      current = readJsonFile(path);
    } catch {
      return { acquired: false, holder: null, state: "unknown" };
    }
    if (current === null) continue;
    const state = ownerState(current);
    if (state !== "gone") return { acquired: false, holder: current, state };
    if (!reclaimStaleLock(path, current)) {
      return { acquired: false, holder: current, state: "unknown" };
    }
  }
  return { acquired: false, holder: readJsonFile(path), state: "unknown" };
}

const RECLAIM_LOCK_STALE_MS = 60_000;

/**
 * Removes the stale record only while holding `<path>.reclaim`, so two
 * controllers that both saw the same dead owner cannot each remove a lock the
 * other has since taken. The reclaim lock is held for a few file operations;
 * one older than a minute belongs to a controller that crashed meanwhile.
 */
function reclaimStaleLock(path, stale) {
  const reclaimPath = `${path}.reclaim`;
  try {
    NodeFS.writeFileSync(reclaimPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - NodeFS.statSync(reclaimPath).mtimeMs > RECLAIM_LOCK_STALE_MS) {
        NodeFS.rmSync(reclaimPath, { force: true });
      }
    } catch {
      // Gone already.
    }
    return false;
  }
  try {
    // Only the record we judged stale; anything else is a live owner's.
    const again = readJsonFile(path);
    if (again?.pid === stale.pid && again?.start === stale.start) {
      NodeFS.rmSync(path, { force: true });
    }
    return true;
  } finally {
    NodeFS.rmSync(reclaimPath, { force: true });
  }
}

export function releaseLock(path, owner) {
  const current = readJsonFile(path);
  if (current?.pid === owner.pid && current?.start === owner.start) {
    NodeFS.rmSync(path, { force: true });
  }
}

// ── profiles ──────────────────────────────────────────────────────────────

const PROFILE_META = "scient-dev-profile.json";

export function readProfile(profilesDir, id) {
  const dir = NodePath.join(profilesDir, id);
  const meta = readJsonFile(NodePath.join(dir, PROFILE_META));
  return meta && meta.id === id ? { id, dir, meta } : null;
}

/**
 * The reviewed ref's profile is reused only while the new commit moves its
 * state forward (same commit or a descendant of the last commit that ran on
 * it). A rewound or force-pushed ref gets a fresh profile; the old one is
 * retired, never deleted here.
 */
export function chooseProfile({ profilesDir, ref, sha, fresh, isAncestor }) {
  const id = profileIdForRef(ref);
  const existing = readProfile(profilesDir, id);
  const dirExists = NodeFS.existsSync(NodePath.join(profilesDir, id));
  if (!fresh && existing?.meta.lastRunSha) {
    const last = existing.meta.lastRunSha;
    if (last === sha || isAncestor(last, sha)) return { id, action: "reuse", previousSha: last };
  }
  return { id, action: dirExists ? "replace" : "create", previousSha: null };
}

export function retireProfile(profilesDir, id, now = Date.now()) {
  const source = NodePath.join(profilesDir, id);
  if (!NodeFS.existsSync(source)) return null;
  const target = NodePath.join(profilesDir, `${id}.retired-${String(now)}`);
  NodeFS.renameSync(source, target);
  return target;
}

export function createProfile(profilesDir, { id, ref, now = Date.now() }) {
  const dir = NodePath.join(profilesDir, id);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(NodePath.join(dir, PROFILE_META), {
    id,
    ref: ref.label,
    createdAt: new Date(now).toISOString(),
    lastRunSha: null,
    lastRunAt: null,
  });
  return readProfile(profilesDir, id);
}

/** Recorded before the app starts: migrations may change state before readiness. */
export function markProfileRun(profile, sha, now = Date.now()) {
  writeJsonAtomic(NodePath.join(profile.dir, PROFILE_META), {
    ...profile.meta,
    lastRunSha: sha,
    lastRunAt: new Date(now).toISOString(),
  });
}

/** Recorded once the app on this commit finished loading against its backend. */
export function markProfileReady(profile, sha) {
  const current = readProfile(NodePath.dirname(profile.dir), profile.id);
  writeJsonAtomic(NodePath.join(profile.dir, PROFILE_META), { ...current.meta, lastReadySha: sha });
}

/**
 * Snapshot before newer code runs, but only state the last run left in good
 * order: after a run that never became ready, the earlier snapshot is the
 * last state known to work and is kept.
 */
export function shouldSnapshotBeforeRun(meta, sha) {
  return (
    Boolean(meta.lastRunSha) && meta.lastRunSha !== sha && meta.lastReadySha === meta.lastRunSha
  );
}

export function snapshotPath(profilesDir, id) {
  return NodePath.join(profilesDir, `${id}.snapshot`);
}

/**
 * Copies the stopped profile before a newer commit runs on it. One snapshot
 * per profile, replaced only by the next upgrade, so --restore-previous always
 * has the state from just before the latest upgrade.
 */
export function snapshotProfile(profilesDir, id) {
  const source = NodePath.join(profilesDir, id);
  const target = snapshotPath(profilesDir, id);
  const staging = `${target}.partial`;
  NodeFS.rmSync(staging, { recursive: true, force: true });
  NodeFS.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.renameSync(staging, target);
  return target;
}

/** Swaps the snapshot back in; returns the commit that last ran on it. */
export function restoreProfileSnapshot(profilesDir, id, now = Date.now()) {
  const snapshot = snapshotPath(profilesDir, id);
  const meta = readJsonFile(NodePath.join(snapshot, PROFILE_META));
  if (!meta?.lastRunSha) throw new Error(`No earlier state is saved for ${id}.`);
  retireProfile(profilesDir, id, now);
  NodeFS.renameSync(snapshot, NodePath.join(profilesDir, id));
  return meta.lastRunSha;
}

/** Keeps the newest profiles and retired copies; never the active one. */
export function pruneProfiles(profilesDir, activeId) {
  if (!NodeFS.existsSync(profilesDir)) return [];
  const entries = NodeFS.readdirSync(profilesDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  const live = entries
    .map((entry) => readProfile(profilesDir, entry.name))
    // A profile that never ran (such as adopted legacy state) is never pruned.
    .filter((profile) => profile !== null && profile.id !== activeId && profile.meta.lastRunAt)
    .toSorted((a, b) => String(b.meta.lastRunAt).localeCompare(String(a.meta.lastRunAt)));
  const retired = entries
    .map((entry) => entry.name)
    .filter((name) => /\.retired-\d+$/u.test(name))
    .toSorted((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
  const removed = [
    ...live.slice(MAX_PROFILES - 1).flatMap((profile) => [profile.id, `${profile.id}.snapshot`]),
    ...retired.slice(MAX_RETIRED_PROFILES),
  ];
  for (const name of removed) {
    NodeFS.rmSync(NodePath.join(profilesDir, name), { recursive: true, force: true });
  }
  return removed;
}

/**
 * A managed launch must name an existing profile directly inside profilesDir;
 * anything else is refused before storage opens.
 */
export function validateProfileRoot(profilesDir, candidate) {
  if (typeof candidate !== "string" || !NodePath.isAbsolute(candidate)) return null;
  let real;
  let realProfiles;
  try {
    real = NodeFS.realpathSync(candidate);
    realProfiles = NodeFS.realpathSync(profilesDir);
  } catch {
    return null;
  }
  if (NodePath.dirname(real) !== realProfiles) return null;
  const id = NodePath.basename(real);
  return readProfile(realProfiles, id) ? real : null;
}

// ── install fingerprint ───────────────────────────────────────────────────

/** Paths whose committed content decides whether node_modules is current. */
export const INSTALL_INPUT_PATHSPECS = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ":(glob)**/package.json",
  "patches",
];

/** `lsFiles` is `git ls-files -s` output for INSTALL_INPUT_PATHSPECS. */
export function installFingerprint({ lsFiles, nodeVersion, arch, platform }) {
  const lines = lsFiles
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("node_modules/"))
    .toSorted();
  return NodeCrypto.createHash("sha256")
    .update([nodeVersion, arch, platform, ...lines].join("\n"))
    .digest("hex");
}

/**
 * Decides what an install still running should do. Progress is any new
 * output; a silent install is stopped after `idleMs`, any install after
 * `deadlineMs`.
 */
export function installWatchdogVerdict({ now, startedAt, lastOutputAt, idleMs, deadlineMs }) {
  if (now - startedAt >= deadlineMs) return "deadline";
  if (now - lastOutputAt >= idleMs) return "stalled";
  return "running";
}
